// The engine end to end in Node, with the real WebAssembly core (ffmpeg-lite's mt build, the
// one browsers use when cross-origin isolated). Outputs are checked with mp4.ts and the core's
// own ffprobe; quality and parity with the native ffmpeg use the ffmpeg on PATH.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { fixture, type Fixture } from '../../e2e/fixtures'
import { readMp4, type Mp4Info } from '../lib/mp4'
import { checkSource, planEncode, type EncodePlan, type Settings } from '../lib/plan'
import { ENCODE_THREADS, READER_THREADS, encodeArgs, videoFilter } from './args'
import { EngineError } from './errors'
import { Runner, type FFmpegCore } from './ffmpeg'
import type { SourceInfo } from './types'

const pkg = dirname(
  createRequire(import.meta.url).resolve('@matterandmotion/ffmpeg-lite/package.json'),
)

async function loadCore(variant: 'mt' | 'st'): Promise<FFmpegCore> {
  const { default: create } = await import(join(pkg, variant, 'ffmpeg-core.js'))
  return create()
}

let core: FFmpegCore
let runner: Runner

beforeAll(async () => {
  core = await loadCore('mt')
  runner = new Runner(core)
})

/** Copies a fixture into the core's memory file system. */
function put(name: Fixture): string {
  const path = `/in/${name}`
  core.FS.writeFile(path, readFileSync(fixture(name)))
  return path
}

interface Made {
  source: SourceInfo
  plan: EncodePlan
  bytes: Uint8Array
  mp4: Mp4Info
  /** The output, read back with the core's ffprobe. */
  out: SourceInfo
}

function make(name: Fixture, settings: Settings): Made {
  const input = put(name)
  const source = runner.probe(input)
  const plan = planEncode(source, settings)
  const bytes = runner.encode(input, plan, ENCODE_THREADS)
  core.FS.writeFile('/in/output.mp4', bytes)
  const out = runner.probe('/in/output.mp4')
  core.FS.unlink('/in/output.mp4')
  return { source, plan, bytes, mp4: readMp4(bytes), out }
}

/** The checks every output passes. */
function expectWebReady({ source, plan, mp4, out }: Made) {
  const video = mp4.tracks.find((t) => t.handler === 'vide')!
  const level = Math.round(Number(plan.level) * 10)
  expect(mp4.faststart).toBe(true)
  expect(mp4.hasLocation).toBe(false)
  expect(mp4.creationTime).toBe(0)
  expect(video.codec).toBe(`avc1.6400${level.toString(16)}`)
  expect(out.video).toMatchObject({
    codec: 'h264',
    profile: 'High',
    width: plan.width,
    height: plan.height,
    rotation: 0,
    sar: [1, 1],
    pixelFormat: 'yuv420p',
    colour: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'tv', hdr: null },
  })
  expect([video.width, video.height, video.transformed]).toEqual([plan.width, plan.height, false])
  expect(video.constantRate).toBe(true)
  expect(video.fps).toEqual(plan.fps)
  // Within one frame of the source.
  expect(Math.abs(video.duration - source.duration)).toBeLessThanOrEqual(plan.fps[1] / plan.fps[0])
  const audio = mp4.tracks.find((t) => t.handler === 'soun')
  if (plan.audio) {
    expect(audio?.codec).toBe('mp4a.40.2')
    expect(out.audio).toMatchObject({
      codec: 'aac',
      channels: plan.audio.channels,
      sampleRate: plan.audio.sampleRate,
    })
  } else expect(audio).toBeUndefined()
}

/** Mean of each plane of an output's first frame (8-bit 4:2:0), and how far chroma is from grey. */
function firstFrame(bytes: Uint8Array, width: number, height: number) {
  core.FS.writeFile('/in/check.mp4', bytes)
  const args = ['-hide_banner', '-threads', '1', '-i', '/in/check.mp4', '-frames:v', '1']
  core.exec(...args, '-c:v', 'rawvideo', '-threads', '1', '-f', 'rawvideo', '/out/check.yuv')
  core.reset()
  const yuv = core.FS.readFile('/out/check.yuv')
  core.FS.unlink('/out/check.yuv')
  core.FS.unlink('/in/check.mp4')
  const n = width * height
  const mean = (a: Uint8Array) => a.reduce((s, v) => s + v, 0) / a.length
  const u = yuv.subarray(n, n + n / 4)
  const v = yuv.subarray(n + n / 4, n + n / 2)
  const spread = (a: Uint8Array) => a.reduce((s, x) => s + Math.abs(x - 128), 0) / a.length
  return { y: mean(yuv.subarray(0, n)), u: mean(u), v: mean(v), chroma: spread(u) + spread(v) }
}

describe('engine', () => {
  it('makes a Background video: 720p, 30 fps, no sound', () => {
    const made = make('hd.mp4', { use: 'background', quality: 'balanced' })
    expectWebReady(made)
    expect(made.plan).toMatchObject({ width: 1280, height: 720, level: '3.1' })
  })

  it('makes Hero and Content videos at 1080p, with sound for Content', () => {
    const hero = make('hd.mp4', { use: 'hero', quality: 'balanced' })
    expectWebReady(hero)
    expect(hero.plan).toMatchObject({ width: 1920, height: 1080, level: '4.0', audio: null })
    const content = make('hd.mp4', { use: 'content', quality: 'balanced' })
    expectWebReady(content)
    expect(content.plan.audio).toMatchObject({ channels: 2, sampleRate: 48000 })
  })

  it('halves 60 fps for loops and keeps it for content', () => {
    const loop = make('hd60.mp4', { use: 'background', quality: 'balanced' })
    expectWebReady(loop)
    expect(loop.plan.fps).toEqual([30, 1])
    const content = make('hd60.mp4', { use: 'content', quality: 'balanced' })
    expectWebReady(content)
    expect(content.plan).toMatchObject({ fps: [60, 1], level: '3.2' })
  })

  it('tone-maps HLG to standard range, without washing it out', () => {
    const made = make('hlg.mov', { use: 'background', quality: 'balanced' })
    expect(made.source.video.colour.hdr).toBe('hlg')
    expectWebReady(made)
    const frame = firstFrame(made.bytes, made.plan.width, made.plan.height)
    expect(frame.y).toBeGreaterThan(40)
    expect(frame.y).toBeLessThan(200)
    expect(frame.chroma).toBeGreaterThan(10)
  })

  it('applies rotation to the pixels', () => {
    const made = make('rotated.mp4', { use: 'background', quality: 'balanced' })
    expect(made.source.video).toMatchObject({ rotation: 270, width: 360, height: 640 })
    expectWebReady(made)
    expect(made.plan).toMatchObject({ width: 360, height: 640 })
  })

  it('removes location, dates and titles', () => {
    const made = make('location.mov', { use: 'background', quality: 'balanced' })
    expectWebReady(made)
    const text = new TextDecoder('latin1').decode(made.bytes)
    for (const secret of ['+40.7128', '2026-01-02', 'Secret']) expect(text).not.toContain(secret)
  })

  it('converts full range to limited range', () => {
    const made = make('fullrange.mp4', { use: 'background', quality: 'balanced' })
    expect(made.plan.colour).toEqual({ kind: 'sdr', matrix: 'bt709', range: 'pc' })
    expectWebReady(made)
    // White is 255 in full range and 235 in limited range.
    expect(firstFrame(made.bytes, made.plan.width, made.plan.height).y).toBeCloseTo(235, 0)
  })

  it('makes a variable frame rate constant', () => {
    const made = make('vfr.mp4', { use: 'background', quality: 'balanced' })
    expect(made.source.video).toMatchObject({ vfr: true, fps: [30, 1] })
    expectWebReady(made)
  })

  it('never enlarges, and mixes 5.1 sound down to stereo', () => {
    const made = make('small.mp4', { use: 'content', quality: 'balanced' })
    expectWebReady(made)
    expect(made.plan).toMatchObject({ width: 854, height: 480 })
    expect(made.source.audio).toMatchObject({ channels: 6, sampleRate: 44100 })
    expect(made.plan.audio).toMatchObject({ channels: 2, sampleRate: 44100 })
  })

  it('makes odd sizes even, and reads RGB video', () => {
    const made = make('odd.mov', { use: 'background', quality: 'balanced' })
    expect(made.plan).toMatchObject({ width: 1000, height: 562, colour: { kind: 'rgb' } })
    expectWebReady(made)
  })

  it('expands non-square pixels', () => {
    const made = make('anamorphic.mp4', { use: 'background', quality: 'balanced' })
    expect(made.source.video).toMatchObject({ width: 1920, height: 1080, sar: [4, 3] })
    expectWebReady(made)
    expect(made.plan).toMatchObject({ width: 1280, height: 720 })
  })

  it('reads VP9 and Opus from WebM', () => {
    const made = make('vp9.webm', { use: 'content', quality: 'balanced' })
    expectWebReady(made)
    expect(made.plan.audio).toMatchObject({ channels: 1, bitrate: 64 })
  })

  it('refuses AV1 before encoding', () => {
    const source = runner.probe(put('av1.mp4'))
    expect(source.video.codec).toBe('av1')
    expect(checkSource(source)).toBe('codec')
  })

  it('fails cleanly on files with no video, and on garbage', () => {
    expect(() => runner.probe(put('audio.m4a'))).toThrow(
      expect.objectContaining({ kind: 'no-video' }),
    )
    try {
      runner.probe(put('garbage.mp4'))
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError)
      expect((e as EngineError).kind).toBe('unreadable')
      expect((e as EngineError).details).toContain('Invalid data found when processing input')
    }
    // The engine still works afterwards.
    expect(runner.probe(put('base.mp4')).video.width).toBe(640)
  })

  it('gives the same bytes every time, in a fresh core too', async () => {
    const settings: Settings = { use: 'background', quality: 'balanced' }
    const first = make('base.mp4', settings).bytes
    expect(make('base.mp4', settings).bytes).toEqual(first)
    const fresh = new Runner(await loadCore('mt'))
    fresh.core.FS.writeFile('/in/base.mp4', readFileSync(fixture('base.mp4')))
    const plan = planEncode(fresh.probe('/in/base.mp4'), settings)
    expect(fresh.encode('/in/base.mp4', plan, ENCODE_THREADS)).toEqual(first)
  })

  it('reports progress', () => {
    const input = put('hd60.mp4')
    const plan = planEncode(runner.probe(input), { use: 'background', quality: 'lower' })
    const ratios: number[] = []
    runner.encode(input, plan, ENCODE_THREADS, (p) => ratios.push(p.ratio))
    // Between the start and the end, not just 0 then 1.
    expect(ratios.some((r) => r > 0 && r < 1)).toBe(true)
    expect(ratios.every((r, i) => r >= 0 && r <= 1 && (i === 0 || r >= ratios[i - 1]))).toBe(true)
    expect(ratios.at(-1)).toBe(1)
    expect(ratios.slice(0, -1).every((r) => r <= 0.99)).toBe(true)
  })
})

describe('stills', () => {
  it('makes a source still and an output still that differ only by compression', () => {
    const made = make('hd.mp4', { use: 'background', quality: 'balanced' })
    const { width, height, colour } = made.plan
    const spec = { stream: made.plan.stream, time: 1, width, height }
    const original = runner.frame('/in/hd.mp4', { ...spec, colour }, READER_THREADS)
    core.FS.writeFile('/in/output.mp4', made.bytes)
    const output = runner.frame(
      '/in/output.mp4',
      { ...spec, stream: 0, colour: { kind: 'sdr', matrix: 'bt709', range: 'tv' } },
      READER_THREADS,
    )
    expect([original.width, original.height, original.data.length]).toEqual([
      1280,
      720,
      1280 * 720 * 4,
    ])
    let diff = 0
    for (let i = 0; i < original.data.length; i++)
      diff += Math.abs(original.data[i] - output.data[i])
    expect(diff / original.data.length).toBeLessThan(4)
  })

  it('makes a tone-mapped still from HDR', () => {
    const source = runner.probe(put('hlg.mov'))
    const plan = planEncode(source, { use: 'background', quality: 'balanced' })
    const spec = { stream: 0, time: 0.5, width: 320, height: 180, colour: plan.colour }
    expect(runner.frame('/in/hlg.mov', spec, READER_THREADS).data.length).toBe(320 * 180 * 4)
  })

  it('fails cleanly past the end', () => {
    const spec = { stream: 0, time: 30, width: 64, height: 36, colour: { kind: 'rgb' } as const }
    expect(() => runner.frame(put('base.mp4'), spec, READER_THREADS)).toThrow(EngineError)
  })
})

// Quality and native parity, per use, on camera-like and synthetic fixtures. The native
// ffmpeg (Ubuntu's FFmpeg 6.1) runs the same arguments with x264's assembly.
const native = mkdtempSync(join(tmpdir(), 'video-optimizer-'))

/** SSIM (FFmpeg's ssim filter, "All") of an output against its source taken through the same steps. */
function ssim(output: string, source: string, plan: EncodePlan): number {
  const chain = `[1:${plan.stream}]${videoFilter(plan, true)}[ref];[0:v:0][ref]ssim`
  const { stderr } = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', output, '-i', source, '-lavfi', chain, '-f', 'null', '-'],
    { encoding: 'utf8' },
  )
  return Number(/All:([\d.]+)/.exec(stderr)?.[1] ?? 0)
}

/**
 * Fixture, use, lowest SSIM, and the expected size in bytes (±8%: a CRF step is about 12%).
 * Measured 2026-11-14: SSIM 0.991–0.995, sizes within 0.6% of native and SSIM within 0.0002.
 */
const PARITY: [Fixture, Settings['use'], minSsim: number, bytes: number][] = [
  ['hd.mp4', 'background', 0.985, 216_774],
  ['hd.mp4', 'hero', 0.99, 1_099_984],
  ['hd60.mp4', 'content', 0.985, 787_980],
  ['anamorphic.mp4', 'background', 0.985, 127_869],
  ['vp9.webm', 'content', 0.985, 95_571],
]

describe('quality', () => {
  it.each(PARITY)(
    '%s as %s: quality, size, and parity with native x264',
    (name, use, minSsim, bytes) => {
      const made = make(name, { use, quality: 'balanced' })
      const source = fixture(name)
      const ours = join(native, `${name}-${use}-wasm.mp4`)
      const theirs = join(native, `${name}-${use}-native.mp4`)
      writeFileSync(ours, made.bytes)
      // The same arguments; its log goes nowhere (they set the level to info).
      execFileSync(
        'ffmpeg',
        ['-nostdin', '-y', ...encodeArgs(source, theirs, made.plan, ENCODE_THREADS)],
        { stdio: 'pipe' },
      )
      const [a, b] = [ssim(ours, source, made.plan), ssim(theirs, source, made.plan)]
      const [sizeA, sizeB] = [statSync(ours).size, statSync(theirs).size]
      console.log(`${name} ${use}: wasm ${sizeA} B SSIM ${a}, native ${sizeB} B SSIM ${b}`)
      expect(a).toBeGreaterThanOrEqual(minSsim)
      expect(Math.abs(sizeA / bytes - 1)).toBeLessThanOrEqual(0.08)
      expect(Math.abs(a - b)).toBeLessThanOrEqual(0.005)
      expect(Math.abs(sizeA / sizeB - 1)).toBeLessThanOrEqual(0.05)
    },
  )
})
