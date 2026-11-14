import type { EncodePlan } from '../lib/plan'
import { encodeArgs, frameArgs, probeArgs, type FrameSpec } from './args'
import { EngineError, classify } from './errors'
import { parseProbe, NoVideoError, type ProbeJson } from './probe'
import type { RgbaImage, SourceInfo, Threads } from './types'

/** The parts of ffmpeg-lite's core (ffmpeg.wasm's core API plus Emscripten's FS) used here. */
export interface FFmpegCore {
  exec(...args: string[]): number
  ffprobe(...args: string[]): number
  reset(): void
  setLogger(logger: (log: { type: string; message: string }) => void): void
  FS: {
    mkdir(path: string): void
    readFile(path: string): Uint8Array
    writeFile(path: string, data: Uint8Array | string): void
    unlink(path: string): void
    stat(path: string): { size: number }
    analyzePath(path: string): { exists: boolean }
    mount(type: unknown, options: unknown, mountpoint: string): void
    unmount(mountpoint: string): void
    filesystems: Record<string, unknown>
  }
  HEAPU8: Uint8Array
}

export interface Progress {
  /** 0 to 1. Held at 0.99 while x264 finishes its last frames. */
  ratio: number
  /** Frames handed to the encoder so far. */
  frames: number
}

/** Lines of FFmpeg's log kept for error reports. */
const LOG_LINES = 200

/** FFmpeg's stats line, printed about twice a second: `frame=   57 fps= 26 q=0.0 size=...`. */
const STATS = /^frame=\s*(\d+)/

/**
 * Runs probes, encodes and stills on a loaded core. Inputs are paths in the core's file
 * system; outputs go to `/out` and are deleted once read. Used by the worker, and by the
 * tests in Node.
 */
export class Runner {
  private log: string[] = []
  private stats = ''
  private onStats: ((frames: number) => void) | undefined

  constructor(readonly core: FFmpegCore) {
    core.setLogger(({ message }) => {
      // The core ends every command with abort(); its message is noise.
      if (message.startsWith('Aborted(')) return
      const stats = STATS.exec(message)
      if (stats) {
        // Only the latest stats line is kept, so a long encode doesn't push out the rest.
        this.stats = message
        this.onStats?.(Number(stats[1]))
        return
      }
      this.log.push(message)
      if (this.log.length > LOG_LINES) this.log.shift()
    })
    for (const dir of ['/in', '/out']) if (!core.FS.analyzePath(dir).exists) core.FS.mkdir(dir)
  }

  /** WebAssembly memory in bytes. It grows as needed and never shrinks. */
  get heap(): number {
    return this.core.HEAPU8.length
  }

  probe(input: string): SourceInfo {
    const output = '/out/probe.json'
    // ffprobe's return value is -1 whether or not it worked; an unreadable file gives `{}`.
    this.run('ffprobe', probeArgs(input, output))
    let json: ProbeJson = {}
    try {
      json = JSON.parse(new TextDecoder().decode(this.take(output))) as ProbeJson
    } catch {
      // Left empty: reported below.
    }
    if (!json.streams?.length) {
      const kind = classify(this.log)
      throw new EngineError(kind === 'failed' ? 'unreadable' : kind, 'probe failed', this.details())
    }
    try {
      return parseProbe(json, this.core.FS.stat(input).size)
    } catch (e) {
      if (e instanceof NoVideoError) throw new EngineError('no-video', 'no video stream')
      throw e
    }
  }

  encode(
    input: string,
    plan: EncodePlan,
    threads: Threads,
    onProgress?: (p: Progress) => void,
  ): Uint8Array {
    const output = '/out/output.mp4'
    // Progress counts frames handed to x264, not frames written: x264 holds about 50 frames
    // back to plan ahead, so the core's own progress (written time) sits at 0 for short clips.
    const total = Math.round((plan.duration * plan.fps[0]) / plan.fps[1])
    this.onStats = (frames) =>
      onProgress?.({ ratio: total ? Math.min(0.99, frames / total) : 0, frames })
    try {
      this.run('exec', encodeArgs(input, output, plan, threads))
    } finally {
      this.onStats = undefined
    }
    onProgress?.({ ratio: 1, frames: total })
    return this.take(output)
  }

  frame(input: string, spec: FrameSpec, threads: Threads): RgbaImage {
    const output = '/out/frame.rgba'
    this.run('exec', frameArgs(input, output, spec, threads))
    const bytes = this.take(output)
    if (bytes.length !== spec.width * spec.height * 4)
      throw new EngineError('failed', `no frame at ${spec.time} s`, this.details())
    return {
      data: new Uint8ClampedArray(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length),
      width: spec.width,
      height: spec.height,
    }
  }

  /** The last lines of the log, and the last stats line. */
  details(): string {
    return [...this.log, this.stats].filter(Boolean).join('\n')
  }

  /** Runs one command. `exec` throws when FFmpeg exits with an error. */
  private run(command: 'exec' | 'ffprobe', args: string[]) {
    this.log = []
    this.stats = ''
    let ret: number
    try {
      ret = this.core[command](...args)
    } finally {
      this.core.reset()
    }
    if (command === 'exec' && ret !== 0) {
      const kind = classify(this.log)
      throw new EngineError(kind, `ffmpeg failed (${ret}): ${kind}`, this.details())
    }
  }

  /** Reads a file from `/out` and deletes it. Missing files read as empty. */
  private take(path: string): Uint8Array {
    if (!this.core.FS.analyzePath(path).exists) return new Uint8Array()
    const bytes = this.core.FS.readFile(path)
    this.core.FS.unlink(path)
    return bytes
  }
}
