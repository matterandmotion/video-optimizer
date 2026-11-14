/// <reference lib="webworker" />
import { EngineError } from './errors'
import { Runner, type FFmpegCore } from './ffmpeg'
import type { EngineInfo, Request, Response } from './protocol'
import type { Threads } from './types'

declare const self: DedicatedWorkerGlobalScope

let runner: Runner | undefined
let info: EngineInfo | undefined
let threads: Threads

async function init(coreDir: string, requested: Threads): Promise<EngineInfo> {
  threads = requested
  if (info) return info
  // The multi-threaded core needs SharedArrayBuffer, so the page must be cross-origin isolated.
  const multi = self.crossOriginIsolated
  const base = `${coreDir}${multi ? 'mt' : 'st'}/`
  const coreURL = `${base}ffmpeg-core.js`
  // The core reads its wasm and pthread worker URLs from the hash of its own URL.
  const urls = {
    wasmURL: `${base}ffmpeg-core.wasm`,
    ...(multi ? { workerURL: `${base}ffmpeg-core.worker.js` } : {}),
  }
  const { default: createFFmpegCore } = await import(/* @vite-ignore */ coreURL)
  const core: FFmpegCore = await createFFmpegCore({
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify(urls))}`,
  })
  runner = new Runner(core)
  info = { threads: multi ? 'multi' : 'single', core: /\/([^/]+)\/$/.exec(coreDir)?.[1] ?? '' }
  return info
}

/**
 * Mounts the file read-only at /in with WORKERFS, which reads slices on demand instead of
 * copying the file into memory. It's renamed, keeping its extension, so FFmpeg never sees
 * a name that looks like an option or a protocol.
 */
function withInput<T>(file: File, run: (path: string) => T): T {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1].toLowerCase() ?? 'bin'
  const input = new File([file], `input.${ext}`, { type: file.type })
  const { FS } = runner!.core
  FS.mount(FS.filesystems.WORKERFS, { files: [input] }, '/in')
  try {
    return run(`/in/${input.name}`)
  } finally {
    FS.unmount('/in')
  }
}

const post = (msg: Response, transfer: Transferable[] = []) => self.postMessage(msg, transfer)

self.onmessage = async ({ data: req }: MessageEvent<Request>) => {
  const { id } = req
  try {
    if (req.type === 'init') {
      const result = await init(req.coreDir, req.threads)
      return post({ id, kind: 'done', result, heap: runner!.heap })
    }
    if (!runner) throw new Error('engine not initialised')
    const r = runner
    switch (req.type) {
      case 'probe':
        post({ id, kind: 'done', result: withInput(req.file, (p) => r.probe(p)), heap: r.heap })
        break
      case 'encode': {
        const start = performance.now()
        const bytes = withInput(req.file, (p) =>
          r.encode(p, req.plan, threads, (progress) => post({ id, kind: 'progress', progress })),
        ) as Uint8Array<ArrayBuffer>
        const result = { bytes, ms: performance.now() - start }
        post({ id, kind: 'done', result, heap: r.heap }, [bytes.buffer])
        break
      }
      case 'frame': {
        const image = withInput(req.file, (p) => r.frame(p, req.spec, threads))
        post({ id, kind: 'done', result: image, heap: r.heap }, [image.data.buffer])
        break
      }
    }
  } catch (e) {
    post({
      id,
      kind: 'error',
      failure: e instanceof EngineError ? e.kind : 'failed',
      message: describe(e),
      details: e instanceof EngineError ? e.details : (runner?.details() ?? ''),
    })
  }
}

/** Emscripten's thread pool rejects with the ErrorEvent of a worker that failed to start. */
function describe(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e instanceof ErrorEvent) return e.message || 'An engine thread failed to start'
  return String(e)
}
