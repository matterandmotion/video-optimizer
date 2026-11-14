import type { AudioInfo, Rational, SourceInfo, VideoInfo } from '../engine/types'

/**
 * What a video is for. Each use is a complete preset: size, frame rate, quality and sound.
 * - Background: decorative, autoplays muted and loops behind text.
 * - Hero: the large video at the top of a page, autoplays muted.
 * - Content: watched on purpose, with controls and sound.
 */
export type Use = 'background' | 'hero' | 'content'
export type Quality = 'lower' | 'balanced' | 'higher'
export type Sound = 'keep' | 'remove'
export type Preset = 'slow' | 'medium'

export interface UseSpec {
  /** Short side of the largest output: 720 for 720p, 1080 for 1080p. */
  box: 720 | 1080
  /** Highest frame rate; faster sources are divided down to fit. */
  fpsCap: number
  /** x264 CRF at Balanced quality. */
  crf: number
  preset: Preset
  /** Bitrate cap in kbit/s, and its buffer in kbit. Normal footage stays under it. */
  maxrate: number
  bufsize: number
  /** Seconds between keyframes. */
  gopSeconds: number
  /** Sound: never kept, removed unless kept, or kept unless removed. */
  sound: 'never' | 'off' | 'on'
}

export const USES: Record<Use, UseSpec> = {
  background: {
    box: 720,
    fpsCap: 30,
    crf: 28,
    preset: 'slow',
    maxrate: 3000,
    bufsize: 6000,
    gopSeconds: 4,
    sound: 'never',
  },
  hero: {
    box: 1080,
    fpsCap: 30,
    crf: 26,
    preset: 'slow',
    maxrate: 6000,
    bufsize: 12000,
    gopSeconds: 4,
    sound: 'off',
  },
  content: {
    box: 1080,
    fpsCap: 60,
    crf: 25,
    preset: 'medium',
    maxrate: 8000,
    bufsize: 16000,
    gopSeconds: 2,
    sound: 'on',
  },
}

/** Added to the use's CRF: +3 is roughly 0.7× the size, −3 roughly 1.4×. */
export const QUALITY_CRF: Record<Quality, number> = { lower: 3, balanced: 0, higher: -3 }

/** Largest input accepted. Reading files up to 4.56 GB was tested in Chromium and WebKit. */
export const MAX_INPUT_BYTES = 4_500_000_000

/** Video codecs the engine can decode: ffmpeg-lite 0.1.0's decoders. */
export const VIDEO_CODECS = [
  'h264',
  'hevc',
  'vp8',
  'vp9',
  'mpeg4',
  'h263',
  'mpeg2video',
  'prores',
  'dnxhd',
  'mjpeg',
  'gif',
  'png',
  'rawvideo',
]

/** Audio codecs the engine can decode. Others are left out of the output rather than failing. */
export const AUDIO_CODECS = [
  'aac',
  'mp3',
  'opus',
  'vorbis',
  'alac',
  'ac3',
  'eac3',
  'pcm_s16le',
  'pcm_s24le',
  'pcm_f32le',
]

/** How the source's colours are read before converting to BT.709 standard range. */
export type ColourPlan =
  /** YUV video: the matrix and range to read it with (swscale names). */
  | { kind: 'sdr'; matrix: 'bt709' | 'bt601' | 'bt2020' | 'smpte240m' | 'fcc'; range: 'tv' | 'pc' }
  /** RGB video (PNG, GIF, some screen recorders): no matrix to read. */
  | { kind: 'rgb' }
  /** HDR video, tone-mapped to standard range (zimg names). */
  | {
      kind: 'hdr'
      transfer: 'arib-std-b67' | 'smpte2084'
      primaries: '2020' | '709' | 'smpte432'
      matrix: '2020_ncl' | '709'
      range: 'limited' | 'full'
    }

export interface AudioPlan {
  stream: number
  /** kbit/s: 128 for stereo, 64 for mono. */
  bitrate: number
  channels: 1 | 2
  sampleRate: 44100 | 48000
}

/** Everything about one output video. */
export interface EncodePlan {
  use: Use
  /** Index of the source's video stream. */
  stream: number
  width: number
  height: number
  fps: Rational
  crf: number
  preset: Preset
  /** H.264 level, e.g. `4.0`. */
  level: Level
  refs: number
  /** Frames between keyframes. */
  gop: number
  maxrate: number
  bufsize: number
  colour: ColourPlan
  audio: AudioPlan | null
  /** Seconds, as the source. */
  duration: number
  /** Seconds into the output where the poster frame is taken. */
  posterTime: number
}

export interface Settings {
  use: Use
  quality: Quality
  /** Only Hero and Content have a choice; unset means the use's default. */
  sound?: Sound
}

export type PlanError = 'too-large' | 'codec'

/** Why a file can't be optimized, or null if it can. */
export function checkSource(source: SourceInfo): PlanError | null {
  if (source.bytes > MAX_INPUT_BYTES) return 'too-large'
  if (!VIDEO_CODECS.includes(source.video.codec)) return 'codec'
  return null
}

export function planEncode(source: SourceInfo, settings: Settings): EncodePlan {
  const spec = USES[settings.use]
  const { video } = source
  const [width, height] = planSize(video.width, video.height, spec.box)
  const fps = planFps(video.fps, spec.fpsCap)
  const level = planLevel(width, height, fps[0] / fps[1])
  return {
    use: settings.use,
    stream: video.stream,
    width,
    height,
    fps,
    crf: spec.crf + QUALITY_CRF[settings.quality],
    preset: spec.preset,
    level,
    refs: planRefs(level, width, height, spec.preset),
    gop: Math.round((spec.gopSeconds * fps[0]) / fps[1]),
    maxrate: spec.maxrate,
    bufsize: spec.bufsize,
    colour: planColour(video),
    audio: planAudio(source.audio, settings),
    duration: source.duration,
    posterTime: posterTime(settings.use, source.duration),
  }
}

/**
 * Fits the use's box by orientation (landscape 1280×720 for 720p, portrait 720×1280, square
 * 720×720), never enlarging. Both sides are even, as 4:2:0 video needs, and the aspect ratio
 * is kept to within a pixel. Takes the displayed size (rotated, square pixels).
 */
export function planSize(width: number, height: number, box: number): [number, number] {
  const long = Math.round((box * 16) / 9)
  const [maxW, maxH] = width >= height ? [long, box] : [box, long]
  const scale = Math.min(1, maxW / width, maxH / height)
  // The epsilon keeps 1920 × (720 / 1080) at 1280, not 1278.
  const down = (n: number) => Math.max(2, 2 * Math.floor(n / 2 + 1e-9))
  const nearest = (n: number) => Math.max(2, 2 * Math.round(n / 2))
  // The longer side is rounded down; the other follows the aspect ratio, within its limit.
  if (width >= height) {
    const w = down(width * scale)
    return [w, Math.min(nearest((w * height) / width), down(Math.min(height, maxH)))]
  }
  const h = down(height * scale)
  return [Math.min(nearest((h * width) / height), down(Math.min(width, maxW))), h]
}

/**
 * Keeps the source rate when it's at or under the cap; otherwise divides it by the smallest
 * whole number that gets under, so motion stays even: 60 → 30, 59.94 → 29.97, 50 → 25.
 */
export function planFps([num, den]: Rational, cap: number): Rational {
  let d = 1
  while (num / (den * d) > cap + 1e-9) d++
  return reduce([num, den * d])
}

/** Common frame rates, which variable-rate video is snapped to. */
const COMMON_RATES: Rational[] = [
  [15, 1],
  [24000, 1001],
  [24, 1],
  [25, 1],
  [30000, 1001],
  [30, 1],
  [48, 1],
  [50, 1],
  [60000, 1001],
  [60, 1],
  [90, 1],
  [100, 1],
  [120, 1],
  [240, 1],
]

/** The nearest common rate within 3%, or the rate itself to 3 decimal places. */
export function snapFps(fps: number): Rational {
  let best: Rational | null = null
  for (const r of COMMON_RATES) {
    const diff = Math.abs(r[0] / r[1] - fps) / fps
    if (diff <= 0.03 && (!best || diff < Math.abs(best[0] / best[1] - fps) / fps)) best = r
  }
  return best ?? reduce([Math.round(fps * 1000), 1000])
}

export type Level = '3.1' | '3.2' | '4.0' | '4.2' | '5.0' | '5.1' | '5.2'

/**
 * H.264 levels from 3.1 up (every phone and browser of the last decade plays 3.1): frame
 * size and decoded picture buffer in macroblocks, macroblocks per second. ITU-T H.264 table A-1.
 */
const LEVELS: { level: Level; maxFs: number; maxMbps: number; maxDpbMbs: number }[] = [
  { level: '3.1', maxFs: 3600, maxMbps: 108000, maxDpbMbs: 18000 },
  { level: '3.2', maxFs: 5120, maxMbps: 216000, maxDpbMbs: 20480 },
  { level: '4.0', maxFs: 8192, maxMbps: 245760, maxDpbMbs: 32768 },
  { level: '4.2', maxFs: 8704, maxMbps: 522240, maxDpbMbs: 34816 },
  { level: '5.0', maxFs: 22080, maxMbps: 589824, maxDpbMbs: 110400 },
  { level: '5.1', maxFs: 36864, maxMbps: 983040, maxDpbMbs: 184320 },
  { level: '5.2', maxFs: 36864, maxMbps: 2073600, maxDpbMbs: 184320 },
]

const macroblocks = (w: number, h: number) => [Math.ceil(w / 16), Math.ceil(h / 16)] as const

/** The lowest level that fits the frame size and rate: 3.1 for 720p30, 4.0 for 1080p30, 4.2 for 1080p60. */
export function planLevel(width: number, height: number, fps: number): Level {
  const [mbW, mbH] = macroblocks(width, height)
  const frame = mbW * mbH
  const fits = LEVELS.find(
    (l) =>
      frame <= l.maxFs && frame * fps <= l.maxMbps && Math.max(mbW, mbH) <= Math.sqrt(8 * l.maxFs),
  )
  return (fits ?? LEVELS[LEVELS.length - 1]).level
}

/** x264's reference frames for each preset. */
const PRESET_REFS: Record<Preset, number> = { slow: 5, medium: 3 }

/**
 * Reference frames: the preset's, but no more than the level's picture buffer holds at this
 * size (slow wants 5; 1080p at level 4.0 allows 4). x264 clamps this too; setting it keeps
 * the stream visibly within its level.
 */
export function planRefs(level: Level, width: number, height: number, preset: Preset): number {
  const [mbW, mbH] = macroblocks(width, height)
  const dpb = LEVELS.find((l) => l.level === level)!.maxDpbMbs
  return Math.max(1, Math.min(PRESET_REFS[preset], Math.floor(dpb / (mbW * mbH)), 16))
}

const RGB_FORMATS = /^(rgb|bgr|gbr|argb|abgr|0rgb|0bgr|pal8)/

/**
 * How to read the source's colours. Untagged YUV is guessed as browsers do: BT.709 for HD
 * (720 lines or 1280 columns and up), BT.601 below. `yuvj` formats are full range.
 */
export function planColour(video: VideoInfo): ColourPlan {
  const { colour, pixelFormat } = video
  if (colour.hdr)
    return {
      kind: 'hdr',
      transfer: colour.hdr === 'hlg' ? 'arib-std-b67' : 'smpte2084',
      primaries:
        colour.primaries === 'bt709'
          ? '709'
          : colour.primaries === 'smpte432'
            ? 'smpte432'
            : '2020',
      matrix: colour.matrix === 'bt709' ? '709' : '2020_ncl',
      range: colour.range === 'pc' ? 'full' : 'limited',
    }
  if (RGB_FORMATS.test(pixelFormat) || colour.matrix === 'gbr') return { kind: 'rgb' }
  const tagged: Record<string, 'bt709' | 'bt601' | 'bt2020' | 'smpte240m' | 'fcc'> = {
    bt709: 'bt709',
    smpte170m: 'bt601',
    bt470bg: 'bt601',
    bt2020nc: 'bt2020',
    bt2020c: 'bt2020',
    smpte240m: 'smpte240m',
    fcc: 'fcc',
  }
  const hd = video.codedHeight >= 720 || video.codedWidth >= 1280
  return {
    kind: 'sdr',
    matrix: (colour.matrix && tagged[colour.matrix]) || (hd ? 'bt709' : 'bt601'),
    range: colour.range === 'pc' || pixelFormat.startsWith('yuvj') ? 'pc' : 'tv',
  }
}

/**
 * Sound, when the use and settings keep it: AAC at 128 kbit/s stereo or 64 kbit/s mono, more
 * channels mixed down to stereo, 44.1 and 48 kHz kept and anything else made 48 kHz.
 */
export function planAudio(audio: AudioInfo | null, settings: Settings): AudioPlan | null {
  const spec = USES[settings.use]
  if (!audio || !AUDIO_CODECS.includes(audio.codec) || spec.sound === 'never') return null
  const keep = settings.sound ? settings.sound === 'keep' : spec.sound === 'on'
  if (!keep) return null
  const channels = audio.channels === 1 ? 1 : 2
  return {
    stream: audio.stream,
    bitrate: channels === 1 ? 64 : 128,
    channels,
    sampleRate: audio.sampleRate === 44100 ? 44100 : 48000,
  }
}

/** Loops start on their first frame; content videos show a frame 10% in, at most 5 s. */
export function posterTime(use: Use, duration: number): number {
  return use === 'content' ? Math.min(5, Math.round(duration * 0.1 * 1000) / 1000) : 0
}

function reduce([num, den]: Rational): Rational {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const g = gcd(num, den) || 1
  return [num / g, den / g]
}
