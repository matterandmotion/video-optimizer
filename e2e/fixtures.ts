/**
 * Test videos, made with the native ffmpeg from FFmpeg's built-in test sources, so there are
 * no binary files in the repo. Each is made once and kept in node_modules/.cache, keyed by
 * its recipe. Single-threaded encoders keep them the same on every machine.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-threads', '1']
/** testsrc2 is RGB: convert it to BT.709 limited range and tag it so. */
const BT709 = [
  ...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'],
  '-color_range',
  'tv',
]
const src = (size: string, rate: number, seconds: number) => [
  ...['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`],
]
const sine = (rate: number, seconds: number) => [
  ...['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=${seconds}`],
]
const toBt709 = 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p'

interface Recipe {
  /** What it exercises. */
  about: string
  /** ffmpeg arguments, before the output path. `{from}` is replaced by the `from` fixture. */
  args?: string[]
  /** Another fixture this one is made from. */
  from?: string
  /** Raw bytes instead of an ffmpeg command. */
  bytes?: string
}

export const FIXTURES = {
  'hd.mp4': {
    about: '1080p30 with stereo sound: downscaling, sound kept and removed',
    args: [...src('1920x1080', 30, 2), ...sine(48000, 2), '-vf', toBt709, ...H264, ...BT709].concat(
      ['-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-shortest'],
    ),
  },
  'hd60.mp4': {
    about: '720p60: the frame rate halved for loops, kept for content',
    args: [...src('1280x720', 60, 2), '-vf', toBt709, ...H264, ...BT709],
  },
  'hlg.mov': {
    about: 'HEVC Main 10 tagged BT.2020 HLG, as phones record HDR: tone mapping',
    args: [
      ...src('1280x720', 30, 1),
      ...['-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast'],
      ...['-x265-params', 'log-level=error:pools=1:frame-threads=1', '-tag:v', 'hvc1'],
      ...['-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc'],
    ],
  },
  'base.mp4': {
    about: '640×360, for the fixtures below',
    args: [...src('640x360', 30, 1), '-vf', toBt709, ...H264, ...BT709],
  },
  'rotated.mp4': {
    about: 'A 90° display rotation, as phones held upright write: rotation applied',
    from: 'base.mp4',
    args: ['-display_rotation:v:0', '90', '-i', '{from}', '-c', 'copy'],
  },
  'location.mov': {
    about: 'Location, dates and a title: metadata removed',
    from: 'base.mp4',
    args: ['-i', '{from}', '-c', 'copy']
      .concat(['-metadata', 'location=+40.7128-074.0060/'])
      .concat(['-metadata', 'creation_time=2026-01-02T03:04:05Z', '-metadata', 'title=Secret'])
      .concat(['-metadata:s:v:0', 'creation_time=2026-01-02T03:04:05Z']),
  },
  'fullrange.mp4': {
    about: 'Full-range white (yuvj420p): converted to limited range',
    args: [
      ...['-f', 'lavfi', '-i', 'color=c=white:size=640x360:rate=30:duration=1'],
      ...['-vf', 'scale=out_color_matrix=bt709:out_range=pc,format=yuvj420p', ...H264],
      ...['-colorspace', 'bt709', '-color_range', 'pc'],
    ],
  },
  'vfr.mp4': {
    about: 'Variable frame rate, as phones and screen recorders write: made constant',
    args: [
      ...src('640x360', 30, 2),
      ...['-vf', `settb=1/1000,setpts='(N/30+0.01*mod(N\\,3))/TB',${toBt709}`],
      ...['-fps_mode', 'passthrough', ...H264, ...BT709],
    ],
  },
  'small.mp4': {
    about: '854×480 with 5.1 sound at 44.1 kHz: never enlarged, sound mixed to stereo',
    args: [...src('854x480', 30, 1), ...sine(44100, 1), '-vf', toBt709, ...H264, ...BT709].concat([
      '-c:a',
      'aac',
      '-ac',
      '6',
      '-shortest',
    ]),
  },
  'odd.mov': {
    about: '1001×563 PNG frames (RGB): even sides, RGB read without a matrix',
    args: [
      ...src('1002x564', 10, 1),
      '-vf',
      'crop=1001:563:0:0',
      '-c:v',
      'png',
      '-pix_fmt',
      'rgb24',
    ],
  },
  'anamorphic.mp4': {
    about: '1440×1080 with 4:3 pixels: shown as 1920×1080',
    args: [...src('1440x1080', 25, 1), '-vf', `setsar=4/3,${toBt709}`, ...H264, ...BT709],
  },
  'vp9.webm': {
    about: 'VP9 and mono Opus in WebM',
    args: [...src('640x360', 30, 1), ...sine(48000, 1), '-vf', toBt709]
      .concat(['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '1'])
      .concat(['-b:v', '1M', '-c:a', 'libopus', '-ac', '1', '-shortest']),
  },
  'av1.mp4': {
    about: 'AV1, which the engine can’t decode',
    args: [...src('320x180', 30, 1), '-c:v', 'libsvtav1', '-preset', '12', '-pix_fmt', 'yuv420p'],
  },
  'audio.m4a': {
    about: 'Sound only',
    args: [...sine(48000, 1), '-c:a', 'aac'],
  },
  'garbage.mp4': {
    about: 'Four bytes named .mp4',
    bytes: 'abcd',
  },
} satisfies Record<string, Recipe>

export type Fixture = keyof typeof FIXTURES

const DIR = fileURLToPath(new URL('../node_modules/.cache/video-fixtures/', import.meta.url))

/** The path of a fixture, made first if needed. Needs ffmpeg on PATH. */
export function fixture(name: Fixture): string {
  const recipe: Recipe = FIXTURES[name]
  const from = recipe.from && fixture(recipe.from as Fixture)
  const key = createHash('sha256')
    .update(JSON.stringify([recipe, from]))
    .digest('hex')
    .slice(0, 12)
  const path = join(DIR, key, name)
  if (existsSync(path)) return path
  mkdirSync(join(DIR, key), { recursive: true })
  const partial = join(DIR, key, `partial-${name}`)
  if (recipe.bytes !== undefined) writeFileSync(partial, recipe.bytes)
  else {
    const args = recipe.args!.map((a) => (a === '{from}' ? from! : a))
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, partial], {
      stdio: 'pipe',
      env: { ...process.env, SVT_LOG: '1' },
    })
  }
  renameSync(partial, path)
  return path
}
