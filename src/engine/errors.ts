/**
 * Why a command failed, for a plain message in the UI:
 * - unreadable: not a video, or damaged
 * - no-video: a file with no picture (e.g. audio only)
 * - codec: a codec the engine can't decode (e.g. AV1)
 * - memory: the browser wouldn't give the engine more memory
 * - failed: anything else; the details go in a bug report
 */
export type FailureKind = 'unreadable' | 'no-video' | 'codec' | 'memory' | 'failed'

export class EngineError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    /** The last lines of FFmpeg's log, for "Copy details". */
    readonly details = '',
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

/** Reads a failed command's log for the reason, most specific first. */
export function classify(log: string[]): FailureKind {
  const text = log.join('\n')
  if (/Cannot enlarge memory|Out of memory|Cannot allocate memory|OOM/i.test(text)) return 'memory'
  if (/Decoder \(codec [^)]+\) not found|no decoder found|Unsupported codec/i.test(text))
    return 'codec'
  if (/Invalid data found when processing input|moov atom not found/i.test(text))
    return 'unreadable'
  if (/does not contain any stream|Stream map '0:\d+' matches no streams/i.test(text))
    return 'no-video'
  return 'failed'
}
