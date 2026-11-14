import type { ColourPlan, EncodePlan } from '../lib/plan'
import type { Threads } from './types'

/**
 * Thread counts for encoding: x264 8, decoder 2, filters 2. Measured in M0 as the fastest
 * split that fits the `mt` core's pool of 16 threads; more decoder threads slowed x264 down.
 * x264's output depends on its thread count, so it's pinned: the same video gives the same
 * bytes on every machine. The single-threaded core ignores these.
 */
export const ENCODE_THREADS: Threads = { decoder: 2, filters: 2, encoder: 8 }

/** Thread counts for probes and stills, so they can run beside an encode. */
export const READER_THREADS: Threads = { decoder: 1, filters: 1, encoder: 1 }

/**
 * Each command sets the log level: it's global in the core, so a probe's `-v error` would
 * otherwise silence the next encode's stats, which progress comes from.
 */
const LOG = ['-hide_banner', '-loglevel', 'info']

/**
 * The FFmpeg arguments for one output video. The core adds `-nostdin -y` itself.
 *
 * Every thread count is set: FFmpeg otherwise picks them from the number of cores, which can
 * ask for more threads than the pool has, and the command then fails.
 */
export function encodeArgs(
  input: string,
  output: string,
  plan: EncodePlan,
  threads: Threads,
): string[] {
  const { audio } = plan
  return [
    ...LOG,
    ...['-threads', String(threads.decoder), '-filter_threads', String(threads.filters)],
    ...['-i', input],
    ...['-map', `0:${plan.stream}`],
    ...(audio ? ['-map', `0:${audio.stream}`] : ['-an']),
    ...['-sn', '-dn'],
    // Phone videos carry location, device and dates: keep none of it.
    ...['-map_metadata', '-1', '-map_metadata:s:v', '-1'],
    ...(audio ? ['-map_metadata:s:a', '-1'] : []),
    ...['-map_chapters', '-1'],
    ...['-vf', videoFilter(plan, true)],
    ...['-c:v', 'libx264', '-preset', plan.preset, '-crf', String(plan.crf)],
    ...['-profile:v', 'high', '-level:v', plan.level, '-refs', String(plan.refs)],
    ...['-maxrate', `${plan.maxrate}k`, '-bufsize', `${plan.bufsize}k`, '-g', String(plan.gop)],
    ...['-threads', String(threads.encoder)],
    ...['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'],
    ...['-color_range', 'tv'],
    ...(audio
      ? [
          ...['-c:a', 'aac', '-b:a', `${audio.bitrate}k`],
          ...['-ac', String(audio.channels), '-ar', String(audio.sampleRate)],
        ]
      : []),
    // faststart: the index goes first, so playback starts before the whole file has loaded.
    // bitexact: no encoder version or creation time, so outputs are reproducible.
    ...['-movflags', '+faststart', '-fflags', '+bitexact'],
    ...['-f', 'mp4', output],
  ]
}

/** One still as RGBA: a source frame through the encode's size and colour steps, or a frame of an output. */
export interface FrameSpec {
  /** Index of the video stream. */
  stream: number
  /** Seconds from the start. */
  time: number
  width: number
  height: number
  colour: ColourPlan
}

/**
 * The FFmpeg arguments for one still, as raw RGBA. A source frame goes through the same
 * scaling, colour conversion and tone mapping as the encode, so comparing it with the
 * output's frame shows only what compression changed. The last step converts BT.709 limited
 * range to RGB, as browsers do when they play the MP4.
 */
export function frameArgs(input: string, output: string, spec: FrameSpec, threads: Threads) {
  return [
    ...LOG,
    ...['-threads', String(threads.decoder), '-filter_threads', String(threads.filters)],
    ...(spec.time > 0 ? ['-ss', spec.time.toFixed(3)] : []),
    ...['-i', input],
    ...['-map', `0:${spec.stream}`, '-an', '-sn', '-dn', '-frames:v', '1'],
    ...['-vf', `${videoFilter(spec, false)},${TO_RGBA}`],
    ...['-c:v', 'rawvideo', '-threads', String(threads.encoder), '-f', 'rawvideo', output],
  ]
}

const TO_RGBA =
  'scale=flags=accurate_rnd+full_chroma_int:in_color_matrix=bt709:in_range=tv,format=rgba'

/** ffprobe arguments that write the file's streams and format as JSON to `output`. */
export function probeArgs(input: string, output: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-o',
    output,
    input,
  ]
}

/**
 * The video filter chain: frame rate first (so dropped frames are never scaled), then size
 * and colour to 8-bit 4:2:0 BT.709 limited range, square pixels.
 * - SDR: swscale with the source's matrix and range given explicitly. Without them it assumes
 *   BT.601 for untagged video and shifts HD colours.
 * - HDR: zimg converts to linear light at the output size, tone-maps with Hable, then
 *   converts to BT.709. Resizing first keeps the float work small.
 * Lanczos matches the image optimizer's resizing.
 */
export function videoFilter(
  spec: Pick<EncodePlan, 'width' | 'height' | 'colour'> & Partial<Pick<EncodePlan, 'fps'>>,
  withFps: boolean,
): string {
  const { width: w, height: h, colour } = spec
  const fps = withFps && spec.fps ? [`fps=${spec.fps[0]}/${spec.fps[1]}`] : []
  const out = ['setsar=1', 'format=yuv420p']
  if (colour.kind === 'hdr') {
    const input = `tin=${colour.transfer}:pin=${colour.primaries}:min=${colour.matrix}:rin=${colour.range}`
    return [
      ...fps,
      `zscale=w=${w}:h=${h}:f=lanczos:${input}:t=linear:npl=100`,
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      ...out,
    ].join(',')
  }
  const read =
    colour.kind === 'sdr' ? `:in_color_matrix=${colour.matrix}:in_range=${colour.range}` : ''
  return [
    ...fps,
    `scale=${w}:${h}:flags=lanczos${read}:out_color_matrix=bt709:out_range=tv`,
    ...out,
  ].join(',')
}
