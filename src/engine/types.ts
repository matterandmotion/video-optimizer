/** A frame rate as a fraction, e.g. `[30000, 1001]` for 29.97 fps. */
export type Rational = [num: number, den: number]

/** What ffprobe says about a file, in the shape the planner needs (see probe.ts). */
export interface SourceInfo {
  /** ffprobe's format name, e.g. `mov,mp4,m4a,3gp,3g2,mj2` or `matroska,webm`. */
  container: string
  /** File size in bytes. */
  bytes: number
  /** Seconds. */
  duration: number
  video: VideoInfo
  /** The first audio stream, or null when there's none. */
  audio: AudioInfo | null
}

export interface VideoInfo {
  /** Index of the stream in the file (for `-map 0:N`). */
  stream: number
  /** ffprobe's codec name, e.g. `h264`, `hevc`, `vp9`, `prores`, `av1`. */
  codec: string
  profile: string | null
  /** Size as shown: rotation applied and non-square pixels expanded. */
  width: number
  height: number
  /** Size as stored in the file. */
  codedWidth: number
  codedHeight: number
  /** Clockwise rotation applied on playback. */
  rotation: 0 | 90 | 180 | 270
  /** Sample (pixel) aspect ratio; `[1, 1]` for square pixels. */
  sar: Rational
  /**
   * The rate to plan from: the stream's own rate, or for variable frame rate video its
   * average, snapped to the nearest common rate.
   */
  fps: Rational
  /** Variable frame rate, common in phone and screen recordings. */
  vfr: boolean
  pixelFormat: string
  bitDepth: number
  colour: ColourInfo
}

export interface ColourInfo {
  /** ffprobe's `color_space`, e.g. `bt709`, `smpte170m`, `bt2020nc`; null when untagged. */
  matrix: string | null
  /** ffprobe's `color_primaries`, e.g. `bt709`, `bt2020`. */
  primaries: string | null
  /** ffprobe's `color_transfer`, e.g. `bt709`, `arib-std-b67`, `smpte2084`. */
  transfer: string | null
  /** `tv` (limited) or `pc` (full); null when untagged. */
  range: 'tv' | 'pc' | null
  /** HDR transfer: HLG (most phones) or PQ (HDR10, Dolby Vision). */
  hdr: 'hlg' | 'pq' | null
}

export interface AudioInfo {
  stream: number
  codec: string
  channels: number
  sampleRate: number
}

/** Uncompressed RGBA pixels, ready for a canvas or a JPEG encoder. */
export interface RgbaImage {
  data: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
}

/** Thread counts for one FFmpeg command. The `mt` core has a pool of 16 threads. */
export interface Threads {
  /** Video decoder threads (`-threads` before `-i`). */
  decoder: number
  /** Filter graph threads (`-filter_threads`). */
  filters: number
  /** Encoder threads (`-threads` after `-i`). */
  encoder: number
}
