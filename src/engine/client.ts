import type { EncodePlan } from '../lib/plan'
import type { FrameSpec } from './args'
import { EngineError } from './errors'
import type { Progress } from './ffmpeg'
import type { EncodeResult, EngineInfo, Request, Response, Results } from './protocol'
import type { RgbaImage, SourceInfo, Threads } from './types'

type Pending = {
  resolve: (value: never) => void
  reject: (error: Error) => void
  onProgress?: (progress: Progress) => void
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

export interface EngineOptions {
  /** Shown in the browser's developer tools. */
  name: string
  threads: Threads
  /**
   * WebAssembly memory grows as needed and never shrinks. After a request leaves it above
   * this many bytes, the worker is ended and the next request starts a fresh one.
   */
  recycleAbove?: number
}

/** Failures after which the core may be in a bad state, so the next request starts afresh. */
const FATAL = new Set(['failed', 'memory'])

/**
 * Main-thread handle to an FFmpeg engine worker (ffmpeg-lite).
 * Requests run one at a time, in call order. Use separate instances for parallel work, e.g.
 * one that encodes and one that reads new files meanwhile.
 */
export class Engine {
  private worker: Worker | null = null
  private ready: Promise<EngineInfo> | null = null
  private pending = new Map<number, Pending>()
  private seq = 0
  private queue: Promise<unknown> = Promise.resolve()
  private generation = 0

  constructor(private readonly options: EngineOptions) {}

  /** Loads the core. Called implicitly by the other requests. */
  init(): Promise<EngineInfo> {
    this.ready ??= this.call('init', {
      coreDir: new URL(`${import.meta.env.BASE_URL}${__CORE_DIR__}`, location.origin).href,
      threads: this.options.threads,
    })
    return this.ready
  }

  probe(file: File): Promise<SourceInfo> {
    return this.enqueue(async () => {
      await this.init()
      return this.call('probe', { file })
    })
  }

  encode(
    file: File,
    plan: EncodePlan,
    onProgress?: (progress: Progress) => void,
  ): Promise<EncodeResult> {
    return this.enqueue(async () => {
      await this.init()
      return this.call('encode', { file, plan }, onProgress)
    })
  }

  /** One still as RGBA, from a source (through the encode's steps) or from an output. */
  frame(file: File, spec: FrameSpec): Promise<RgbaImage> {
    return this.enqueue(async () => {
      await this.init()
      return this.call('frame', { file, spec })
    })
  }

  /**
   * Stops all work immediately: the running request and every queued one reject with
   * `CancelledError`. The next call starts a fresh worker.
   */
  cancel() {
    this.generation++
    for (const p of this.pending.values()) p.reject(new CancelledError())
    this.pending.clear()
    this.end()
  }

  /** Ends the worker once the queued requests are done, giving its memory back. */
  release(): Promise<void> {
    const generation = this.generation
    const done = this.queue.then(() => {
      if (generation === this.generation) this.end()
    })
    this.queue = done
    return done
  }

  private end() {
    this.worker?.terminate()
    this.worker = null
    this.ready = null
  }

  /** Runs `task` once every earlier request has settled, unless `cancel()` happens first. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const generation = this.generation
    const run = this.queue.then(() => {
      if (generation !== this.generation) throw new CancelledError()
      return task()
    })
    this.queue = run.catch(() => {})
    return run
  }

  private get w(): Worker {
    if (!this.worker) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
        name: this.options.name,
      })
      worker.onmessage = ({ data }: MessageEvent<Response>) => {
        const p = this.pending.get(data.id)
        if (!p) return
        if (data.kind === 'progress') return p.onProgress?.(data.progress)
        this.pending.delete(data.id)
        if (data.kind === 'done') {
          const limit = this.options.recycleAbove
          if (limit && data.heap > limit && this.worker === worker) this.end()
          p.resolve(data.result as never)
        } else {
          if (FATAL.has(data.failure) && this.worker === worker) this.end()
          p.reject(new EngineError(data.failure, data.message, data.details))
        }
      }
      worker.onerror = (e) => {
        e.preventDefault()
        const error = new EngineError('failed', e.message || 'engine worker failed')
        for (const p of this.pending.values()) p.reject(error)
        this.pending.clear()
        if (this.worker === worker) this.end()
      }
      this.worker = worker
    }
    return this.worker
  }

  private call<T extends keyof Results>(
    type: T,
    payload: Omit<Extract<Request, { type: T }>, 'id' | 'type'>,
    onProgress?: (progress: Progress) => void,
  ): Promise<Results[T]> {
    const id = ++this.seq
    return new Promise<Results[T]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, onProgress })
      this.w.postMessage({ id, type, ...payload })
    })
  }
}
