import type { EncodePlan } from '../lib/plan'
import type { FrameSpec } from './args'
import type { FailureKind } from './errors'
import type { Progress } from './ffmpeg'
import type { RgbaImage, SourceInfo, Threads } from './types'

export interface EngineInfo {
  /** Multi-threaded when the page is cross-origin isolated, otherwise single-threaded. */
  threads: 'multi' | 'single'
  /** ffmpeg-lite's version. */
  core: string
}

export interface EncodeResult {
  /** The MP4. */
  bytes: Uint8Array<ArrayBuffer>
  /** How long the encode took, in milliseconds. */
  ms: number
}

export type Request =
  | { id: number; type: 'init'; coreDir: string; threads: Threads }
  | { id: number; type: 'probe'; file: File }
  | { id: number; type: 'encode'; file: File; plan: EncodePlan }
  | { id: number; type: 'frame'; file: File; spec: FrameSpec }

export interface Results {
  init: EngineInfo
  probe: SourceInfo
  encode: EncodeResult
  frame: RgbaImage
}

export type Response =
  /** `heap`: the engine's memory in bytes after the request. */
  | { id: number; kind: 'done'; result: Results[keyof Results]; heap: number }
  | { id: number; kind: 'error'; failure: FailureKind; message: string; details: string }
  | { id: number; kind: 'progress'; progress: Progress }
