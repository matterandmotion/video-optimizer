import type { FailureKind } from '../engine/errors'
import type { PlanError } from './plan'

/** Codec names as people know them. */
const CODECS: Record<string, string> = {
  av1: 'AV1',
  h264: 'H.264',
  hevc: 'HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  prores: 'ProRes',
  prores_raw: 'ProRes RAW',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  dnxhd: 'DNxHD',
  mjpeg: 'Motion JPEG',
  wmv3: 'Windows Media Video',
  theora: 'Theora',
}

export function codecName(codec: string): string {
  return CODECS[codec] ?? codec.toUpperCase()
}

/** A plain sentence for why a file can't be optimized. */
export function failureMessage(kind: FailureKind | PlanError, codec = ''): string {
  switch (kind) {
    case 'unreadable':
      return 'Can’t read this file.'
    case 'no-video':
      return 'This file has no video.'
    case 'codec':
      return `This video uses ${codec ? codecName(codec) : 'a codec'}, which this tool can’t read. Export it as H.264 or HEVC first.`
    case 'too-large':
      return 'Larger than 4.5 GB. Trim it or export a smaller copy first.'
    case 'memory':
      return 'This video needed more memory than the browser allowed. Try a shorter clip, or close other tabs.'
    case 'failed':
      return 'Couldn’t encode this video.'
  }
}
