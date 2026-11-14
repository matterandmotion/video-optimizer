import { describe, expect, it } from 'vitest'
import type { SourceInfo, VideoInfo } from '../engine/types'
import {
  checkSource,
  planAudio,
  planColour,
  planEncode,
  planFps,
  planLevel,
  planRefs,
  planSize,
  posterTime,
  snapFps,
} from './plan'

const video = (over: Partial<VideoInfo> = {}): VideoInfo => ({
  stream: 0,
  codec: 'h264',
  profile: 'High',
  width: 1920,
  height: 1080,
  codedWidth: 1920,
  codedHeight: 1080,
  rotation: 0,
  sar: [1, 1],
  fps: [30, 1],
  vfr: false,
  pixelFormat: 'yuv420p',
  bitDepth: 8,
  colour: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'tv', hdr: null },
  ...over,
})

const source = (over: Partial<SourceInfo> = {}): SourceInfo => ({
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  bytes: 10_000_000,
  duration: 14.2,
  video: video(),
  audio: { stream: 1, codec: 'aac', channels: 2, sampleRate: 48000 },
  ...over,
})

describe('planSize', () => {
  it('fits landscape, portrait and square boxes', () => {
    expect(planSize(1920, 1080, 720)).toEqual([1280, 720])
    expect(planSize(1080, 1920, 720)).toEqual([720, 1280])
    expect(planSize(1080, 1080, 720)).toEqual([720, 720])
    expect(planSize(3840, 2160, 1080)).toEqual([1920, 1080])
    expect(planSize(2160, 3840, 1080)).toEqual([1080, 1920])
  })

  it('never enlarges', () => {
    expect(planSize(854, 480, 1080)).toEqual([854, 480])
    expect(planSize(640, 360, 720)).toEqual([640, 360])
  })

  it('makes both sides even and keeps the aspect ratio', () => {
    expect(planSize(1001, 563, 720)).toEqual([1000, 562])
    // The user's case study video: 1918 × 1080.
    expect(planSize(1918, 1080, 720)).toEqual([1278, 720])
    expect(planSize(1918, 1080, 1080)).toEqual([1918, 1080])
    expect(planSize(3, 3, 720)).toEqual([2, 2])
  })

  it('fits very wide and very tall video by its long side', () => {
    expect(planSize(3840, 1080, 720)).toEqual([1280, 360])
    expect(planSize(1920, 818, 1080)).toEqual([1920, 818])
    expect(planSize(1080, 3840, 720)).toEqual([360, 1280])
  })
})

describe('planFps', () => {
  it('keeps rates at or under the cap', () => {
    expect(planFps([30, 1], 30)).toEqual([30, 1])
    expect(planFps([30000, 1001], 30)).toEqual([30000, 1001])
    expect(planFps([24000, 1001], 30)).toEqual([24000, 1001])
    expect(planFps([60, 1], 60)).toEqual([60, 1])
  })

  it('divides faster rates by the smallest whole number that fits', () => {
    expect(planFps([60, 1], 30)).toEqual([30, 1])
    expect(planFps([60000, 1001], 30)).toEqual([30000, 1001])
    expect(planFps([50, 1], 30)).toEqual([25, 1])
    expect(planFps([120, 1], 30)).toEqual([30, 1])
    expect(planFps([48, 1], 30)).toEqual([24, 1])
    expect(planFps([240, 1], 60)).toEqual([60, 1])
    expect(planFps([100, 1], 30)).toEqual([25, 1])
  })
})

describe('snapFps', () => {
  it('snaps averages to the nearest common rate', () => {
    expect(snapFps(29.87)).toEqual([30000, 1001])
    expect(snapFps(29.99)).toEqual([30, 1])
    expect(snapFps(59.6)).toEqual([60000, 1001])
    expect(snapFps(23.9)).toEqual([24000, 1001])
    expect(snapFps(119.2)).toEqual([120, 1])
  })

  it('keeps uncommon rates, to the thousandth', () => {
    expect(snapFps(12.5)).toEqual([25, 2])
    expect(snapFps(37.1234)).toEqual([37123, 1000])
  })
})

describe('planLevel', () => {
  it('matches the H.264 level table', () => {
    expect(planLevel(1280, 720, 30)).toBe('3.1')
    expect(planLevel(720, 1280, 30)).toBe('3.1')
    expect(planLevel(640, 360, 30)).toBe('3.1')
    expect(planLevel(1280, 720, 60)).toBe('3.2')
    expect(planLevel(1920, 1080, 30)).toBe('4.0')
    expect(planLevel(1920, 1080, 30000 / 1001)).toBe('4.0')
    expect(planLevel(1080, 1920, 30)).toBe('4.0')
    expect(planLevel(1920, 1080, 60)).toBe('4.2')
    expect(planLevel(1918, 1080, 60)).toBe('4.2')
    expect(planLevel(2560, 1440, 30)).toBe('5.0')
    expect(planLevel(2560, 1440, 60)).toBe('5.1')
  })
})

describe('planRefs', () => {
  it('keeps the preset’s references within the level’s picture buffer', () => {
    expect(planRefs('4.0', 1920, 1080, 'slow')).toBe(4)
    expect(planRefs('3.1', 1280, 720, 'slow')).toBe(5)
    expect(planRefs('4.2', 1920, 1080, 'medium')).toBe(3)
    expect(planRefs('3.1', 640, 360, 'slow')).toBe(5)
  })
})

describe('planColour', () => {
  it('reads tagged SDR video with its own matrix and range', () => {
    expect(planColour(video())).toEqual({ kind: 'sdr', matrix: 'bt709', range: 'tv' })
    const ntsc = video({
      colour: { matrix: 'smpte170m', primaries: null, transfer: null, range: 'tv', hdr: null },
    })
    expect(planColour(ntsc)).toEqual({ kind: 'sdr', matrix: 'bt601', range: 'tv' })
  })

  it('guesses untagged video by size, as browsers do', () => {
    const untagged = { matrix: null, primaries: null, transfer: null, range: null, hdr: null }
    expect(planColour(video({ colour: untagged }))).toEqual({
      kind: 'sdr',
      matrix: 'bt709',
      range: 'tv',
    })
    const sd = video({ codedWidth: 640, codedHeight: 480, colour: untagged })
    expect(planColour(sd)).toEqual({ kind: 'sdr', matrix: 'bt601', range: 'tv' })
  })

  it('reads full range from the tag or a yuvj format', () => {
    const colour = {
      matrix: 'bt709',
      primaries: null,
      transfer: null,
      range: 'pc' as const,
      hdr: null,
    }
    expect(planColour(video({ colour }))).toMatchObject({ range: 'pc' })
    expect(planColour(video({ pixelFormat: 'yuvj420p' }))).toMatchObject({ range: 'pc' })
  })

  it('reads RGB video without a matrix', () => {
    expect(planColour(video({ pixelFormat: 'rgb24' }))).toEqual({ kind: 'rgb' })
    expect(planColour(video({ pixelFormat: 'pal8' }))).toEqual({ kind: 'rgb' })
  })

  it('tone-maps HLG and PQ', () => {
    const hlg = video({
      pixelFormat: 'yuv420p10le',
      colour: {
        matrix: 'bt2020nc',
        primaries: 'bt2020',
        transfer: 'arib-std-b67',
        range: 'tv',
        hdr: 'hlg',
      },
    })
    expect(planColour(hlg)).toEqual({
      kind: 'hdr',
      transfer: 'arib-std-b67',
      primaries: '2020',
      matrix: '2020_ncl',
      range: 'limited',
    })
    const pq = video({
      colour: { matrix: null, primaries: null, transfer: 'smpte2084', range: null, hdr: 'pq' },
    })
    expect(planColour(pq)).toMatchObject({ transfer: 'smpte2084', primaries: '2020' })
  })
})

describe('planAudio', () => {
  const stereo = { stream: 1, codec: 'aac', channels: 2, sampleRate: 48000 }

  it('follows the use, unless the settings say otherwise', () => {
    expect(planAudio(stereo, { use: 'background', quality: 'balanced' })).toBeNull()
    expect(planAudio(stereo, { use: 'background', quality: 'balanced', sound: 'keep' })).toBeNull()
    expect(planAudio(stereo, { use: 'hero', quality: 'balanced' })).toBeNull()
    expect(planAudio(stereo, { use: 'hero', quality: 'balanced', sound: 'keep' })).not.toBeNull()
    expect(planAudio(stereo, { use: 'content', quality: 'balanced' })).not.toBeNull()
    expect(planAudio(stereo, { use: 'content', quality: 'balanced', sound: 'remove' })).toBeNull()
    expect(planAudio(null, { use: 'content', quality: 'balanced' })).toBeNull()
  })

  it('makes stereo 128 kbit/s, mono 64, and mixes more channels down', () => {
    const content = { use: 'content' as const, quality: 'balanced' as const }
    expect(planAudio(stereo, content)).toEqual({
      stream: 1,
      bitrate: 128,
      channels: 2,
      sampleRate: 48000,
    })
    expect(planAudio({ ...stereo, channels: 1 }, content)).toMatchObject({
      bitrate: 64,
      channels: 1,
    })
    expect(planAudio({ ...stereo, channels: 6 }, content)).toMatchObject({ channels: 2 })
  })

  it('keeps 44.1 and 48 kHz, and makes other rates 48 kHz', () => {
    const content = { use: 'content' as const, quality: 'balanced' as const }
    expect(planAudio({ ...stereo, sampleRate: 44100 }, content)).toMatchObject({
      sampleRate: 44100,
    })
    expect(planAudio({ ...stereo, sampleRate: 96000 }, content)).toMatchObject({
      sampleRate: 48000,
    })
    expect(planAudio({ ...stereo, sampleRate: 22050 }, content)).toMatchObject({
      sampleRate: 48000,
    })
  })

  it('leaves out sound it can’t decode', () => {
    const content = { use: 'content' as const, quality: 'balanced' as const }
    expect(planAudio({ ...stereo, codec: 'dts' }, content)).toBeNull()
  })
})

describe('posterTime', () => {
  it('uses the first frame for loops, 10% in (at most 5 s) for content', () => {
    expect(posterTime('background', 14.2)).toBe(0)
    expect(posterTime('hero', 14.2)).toBe(0)
    expect(posterTime('content', 14.2)).toBe(1.42)
    expect(posterTime('content', 113)).toBe(5)
  })
})

describe('planEncode', () => {
  it('makes a Background plan from a 1080p60 phone clip', () => {
    const clip = source({ video: video({ fps: [60000, 1001] }) })
    expect(planEncode(clip, { use: 'background', quality: 'balanced' })).toEqual({
      use: 'background',
      stream: 0,
      width: 1280,
      height: 720,
      fps: [30000, 1001],
      crf: 28,
      preset: 'slow',
      level: '3.1',
      refs: 5,
      gop: 120,
      maxrate: 3000,
      bufsize: 6000,
      colour: { kind: 'sdr', matrix: 'bt709', range: 'tv' },
      audio: null,
      duration: 14.2,
      posterTime: 0,
    })
  })

  it('moves the CRF by quality', () => {
    const crf = (use: 'background' | 'hero' | 'content', quality: 'lower' | 'higher') =>
      planEncode(source(), { use, quality }).crf
    expect([crf('background', 'lower'), crf('background', 'higher')]).toEqual([31, 25])
    expect([crf('hero', 'lower'), crf('hero', 'higher')]).toEqual([29, 23])
    expect([crf('content', 'lower'), crf('content', 'higher')]).toEqual([28, 22])
  })

  it('makes Content keep 60 fps, sound and a 2 s keyframe interval', () => {
    const clip = source({ video: video({ fps: [60, 1] }) })
    expect(planEncode(clip, { use: 'content', quality: 'balanced' })).toMatchObject({
      width: 1920,
      height: 1080,
      fps: [60, 1],
      level: '4.2',
      refs: 3,
      gop: 120,
      preset: 'medium',
      audio: { bitrate: 128, channels: 2 },
      posterTime: 1.42,
    })
  })
})

describe('checkSource', () => {
  it('refuses files over 4.5 GB and codecs the engine can’t read', () => {
    expect(checkSource(source())).toBeNull()
    expect(checkSource(source({ bytes: 4_600_000_000 }))).toBe('too-large')
    expect(checkSource(source({ video: video({ codec: 'av1' }) }))).toBe('codec')
  })
})
