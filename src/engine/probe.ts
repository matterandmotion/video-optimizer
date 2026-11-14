import { snapFps } from '../lib/plan'
import type { AudioInfo, ColourInfo, Rational, SourceInfo, VideoInfo } from './types'

/** The parts of `ffprobe -print_format json -show_format -show_streams` used here. */
export interface ProbeJson {
  format?: { format_name?: string; duration?: string; size?: string }
  streams?: ProbeStream[]
}

export interface ProbeStream {
  index: number
  codec_type?: string
  codec_name?: string
  profile?: string
  width?: number
  height?: number
  sample_aspect_ratio?: string
  pix_fmt?: string
  bits_per_raw_sample?: string
  color_range?: string
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  duration?: string
  channels?: number
  sample_rate?: string
  disposition?: { attached_pic?: number }
  tags?: Record<string, string>
  side_data_list?: { side_data_type?: string; rotation?: number }[]
}

/** Thrown when a file has no video stream to encode. */
export class NoVideoError extends Error {
  constructor() {
    super('no video stream')
    this.name = 'NoVideoError'
  }
}

/** Turns ffprobe's JSON into what the planner needs. Throws `NoVideoError` for audio-only files. */
export function parseProbe(json: ProbeJson, bytes: number): SourceInfo {
  const streams = json.streams ?? []
  // Cover art in MP4/MP3 files is a one-frame "video" stream; it's never the video.
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!v || !v.width || !v.height) throw new NoVideoError()
  const a = streams.find((s) => s.codec_type === 'audio')
  const duration = Number(json.format?.duration ?? v.duration ?? 0)
  return {
    container: json.format?.format_name ?? '',
    bytes: Number(json.format?.size ?? bytes) || bytes,
    duration: Number.isFinite(duration) ? duration : 0,
    video: parseVideo(v),
    audio: a ? parseAudio(a) : null,
  }
}

function parseVideo(s: ProbeStream): VideoInfo {
  const codedWidth = s.width!
  const codedHeight = s.height!
  const sar = parseRatio(s.sample_aspect_ratio, ':') ?? [1, 1]
  const rotation = parseRotation(s)
  // Non-square pixels are expanded horizontally, as players show them.
  const shownWidth = Math.round((codedWidth * sar[0]) / sar[1])
  const [width, height] =
    rotation === 90 || rotation === 270 ? [codedHeight, shownWidth] : [shownWidth, codedHeight]
  const pixelFormat = s.pix_fmt ?? 'yuv420p'
  const { fps, vfr } = parseFps(s)
  return {
    stream: s.index,
    codec: s.codec_name ?? 'unknown',
    profile: s.profile ?? null,
    width,
    height,
    codedWidth,
    codedHeight,
    rotation,
    sar,
    fps,
    vfr,
    pixelFormat,
    bitDepth: Number(s.bits_per_raw_sample) || bitDepthOf(pixelFormat),
    colour: parseColour(s),
  }
}

function parseAudio(s: ProbeStream): AudioInfo {
  return {
    stream: s.index,
    codec: s.codec_name ?? 'unknown',
    channels: s.channels ?? 2,
    sampleRate: Number(s.sample_rate) || 48000,
  }
}

const known = (value: string | undefined) =>
  value && value !== 'unknown' && value !== 'reserved' ? value : null

function parseColour(s: ProbeStream): ColourInfo {
  const transfer = known(s.color_transfer)
  const range = known(s.color_range)
  return {
    matrix: known(s.color_space),
    primaries: known(s.color_primaries),
    transfer,
    range: range === 'tv' || range === 'pc' ? range : null,
    hdr: transfer === 'arib-std-b67' ? 'hlg' : transfer === 'smpte2084' ? 'pq' : null,
  }
}

/**
 * Clockwise rotation on playback. ffprobe gives the display matrix's angle counterclockwise
 * (an iPhone portrait video says -90); older files may have a `rotate` tag (clockwise).
 */
function parseRotation(s: ProbeStream): VideoInfo['rotation'] {
  const matrix = s.side_data_list?.find((d) => d.side_data_type === 'Display Matrix')
  const degrees = matrix?.rotation !== undefined ? -matrix.rotation : Number(s.tags?.rotate ?? 0)
  const r = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360
  return r as VideoInfo['rotation']
}

/**
 * The stream's rate (`r_frame_rate`) when it's constant. When the average differs by more
 * than 1%, the video has a variable frame rate: its rate is kept if it's a common one near
 * the average (a 30 fps phone clip averaging 29.5), otherwise the average is snapped to the
 * nearest common rate (timestamps on a 1/120 s grid averaging 29.85 make 29.97).
 */
function parseFps(s: ProbeStream): { fps: Rational; vfr: boolean } {
  const r = parseRatio(s.r_frame_rate, '/')
  const avg = parseRatio(s.avg_frame_rate, '/')
  if (!avg) return { fps: r ?? [30, 1], vfr: false }
  if (!r) return { fps: snapFps(avg[0] / avg[1]), vfr: false }
  const rate = r[0] / r[1]
  const mean = avg[0] / avg[1]
  const near = Math.abs(rate - mean) / mean
  if (near <= 0.01) return { fps: r, vfr: false }
  const snapped = snapFps(rate)
  const common = near <= 0.03 && snapped[0] * r[1] === r[0] * snapped[1]
  return { fps: common ? r : snapFps(mean), vfr: true }
}

/** `30000/1001` or `4:3`; null when missing, zero or not a number. */
function parseRatio(value: string | undefined, separator: string): Rational | null {
  const [num, den] = (value ?? '').split(separator).map(Number)
  return num > 0 && den > 0 ? [num, den] : null
}

function bitDepthOf(pixelFormat: string): number {
  const m = /p(9|10|12|14|16)(le|be)?$/.exec(pixelFormat)
  return m ? Number(m[1]) : 8
}
