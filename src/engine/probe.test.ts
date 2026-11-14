import { describe, expect, it } from 'vitest'
import { NoVideoError, parseProbe, type ProbeJson } from './probe'

// Trimmed ffprobe output (`-print_format json -show_format -show_streams`, FFmpeg 5.1) in the
// shapes real files give.

/** An iPhone HDR video held upright: HEVC Main 10, HLG, Dolby Vision, rotated, with location. */
const iphone: ProbeJson = {
  streams: [
    {
      index: 0,
      codec_name: 'hevc',
      profile: 'Main 10',
      codec_type: 'video',
      width: 1920,
      height: 1080,
      sample_aspect_ratio: '1:1',
      pix_fmt: 'yuv420p10le',
      color_range: 'tv',
      color_space: 'bt2020nc',
      color_transfer: 'arib-std-b67',
      color_primaries: 'bt2020',
      r_frame_rate: '30/1',
      avg_frame_rate: '30/1',
      duration: '4.233333',
      disposition: { attached_pic: 0 },
      tags: { creation_time: '2026-11-02T09:41:00.000000Z', handler_name: 'Core Media Video' },
      side_data_list: [
        { side_data_type: 'DOVI configuration record' },
        { side_data_type: 'Display Matrix', rotation: -90 },
      ],
    },
    { index: 1, codec_name: 'aac', codec_type: 'audio', sample_rate: '44100', channels: 2 },
    { index: 2, codec_type: 'data' },
    { index: 3, codec_type: 'data' },
  ],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '4.233333',
    size: '9452311',
  },
}

/** An Android clip with a variable frame rate around 30 fps. */
const android: ProbeJson = {
  streams: [
    {
      index: 0,
      codec_name: 'h264',
      profile: 'High',
      codec_type: 'video',
      width: 1920,
      height: 1080,
      pix_fmt: 'yuv420p',
      color_range: 'tv',
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      // Timestamps on a 1/120 s grid, averaging 29.85 fps.
      r_frame_rate: '120/1',
      avg_frame_rate: '597/20',
    },
    { index: 1, codec_name: 'aac', codec_type: 'audio', sample_rate: '48000', channels: 2 },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.010000', size: '24000000' },
}

/** A screen recording: full range, untagged matrix, no sound. */
const screen: ProbeJson = {
  streams: [
    {
      index: 0,
      codec_name: 'h264',
      codec_type: 'video',
      width: 2880,
      height: 1800,
      pix_fmt: 'yuvj420p',
      color_range: 'pc',
      r_frame_rate: '60/1',
      avg_frame_rate: '60/1',
    },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '31.5', size: '48000000' },
}

/** A ProRes export with 24-bit PCM sound. */
const prores: ProbeJson = {
  streams: [
    {
      index: 0,
      codec_name: 'prores',
      profile: 'HQ',
      codec_type: 'video',
      width: 1920,
      height: 1080,
      pix_fmt: 'yuv422p10le',
      bits_per_raw_sample: '10',
      color_range: 'tv',
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      r_frame_rate: '24000/1001',
      avg_frame_rate: '24000/1001',
    },
    { index: 1, codec_name: 'pcm_s24le', codec_type: 'audio', sample_rate: '48000', channels: 2 },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '8.008000', size: '180000000' },
}

/** WebM with VP9 and Opus. Matroska streams have no duration of their own. */
const webm: ProbeJson = {
  streams: [
    {
      index: 0,
      codec_name: 'vp9',
      profile: 'Profile 0',
      codec_type: 'video',
      width: 1280,
      height: 720,
      sample_aspect_ratio: '1:1',
      pix_fmt: 'yuv420p',
      r_frame_rate: '30/1',
      avg_frame_rate: '30/1',
    },
    { index: 1, codec_name: 'opus', codec_type: 'audio', sample_rate: '48000', channels: 1 },
  ],
  format: { format_name: 'matroska,webm', duration: '10.000000', size: '1500000' },
}

describe('parseProbe', () => {
  it('reads an iPhone HDR video: rotation, HLG, sound', () => {
    expect(parseProbe(iphone, 0)).toEqual({
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      bytes: 9452311,
      duration: 4.233333,
      video: {
        stream: 0,
        codec: 'hevc',
        profile: 'Main 10',
        width: 1080,
        height: 1920,
        codedWidth: 1920,
        codedHeight: 1080,
        rotation: 90,
        sar: [1, 1],
        fps: [30, 1],
        vfr: false,
        pixelFormat: 'yuv420p10le',
        bitDepth: 10,
        colour: {
          matrix: 'bt2020nc',
          primaries: 'bt2020',
          transfer: 'arib-std-b67',
          range: 'tv',
          hdr: 'hlg',
        },
      },
      audio: { stream: 1, codec: 'aac', channels: 2, sampleRate: 44100 },
    })
  })

  it('snaps a variable frame rate to the nearest common rate', () => {
    const { video } = parseProbe(android, 0)
    expect(video.vfr).toBe(true)
    expect(video.fps).toEqual([30000, 1001])
  })

  it('keeps a common rate near a variable frame rate’s average', () => {
    const stream = { index: 0, codec_type: 'video', width: 640, height: 360 }
    const json = (r: string, avg: string): ProbeJson => ({
      streams: [{ ...stream, r_frame_rate: r, avg_frame_rate: avg }],
    })
    expect(parseProbe(json('30/1', '1800/61'), 0).video).toMatchObject({ fps: [30, 1], vfr: true })
    expect(parseProbe(json('30/1', '30/1'), 0).video).toMatchObject({ fps: [30, 1], vfr: false })
    expect(parseProbe(json('30/1', '2997/100'), 0).video).toMatchObject({ vfr: false })
  })

  it('reads full-range, untagged screen recordings', () => {
    const info = parseProbe(screen, 0)
    expect(info.video.colour).toEqual({
      matrix: null,
      primaries: null,
      transfer: null,
      range: 'pc',
      hdr: null,
    })
    expect(info.video.fps).toEqual([60, 1])
    expect(info.audio).toBeNull()
  })

  it('reads ProRes and WebM', () => {
    expect(parseProbe(prores, 0).video).toMatchObject({
      codec: 'prores',
      bitDepth: 10,
      fps: [24000, 1001],
    })
    expect(parseProbe(prores, 0).audio?.codec).toBe('pcm_s24le')
    const info = parseProbe(webm, 0)
    expect(info).toMatchObject({ container: 'matroska,webm', duration: 10 })
    expect(info.audio).toEqual({ stream: 1, codec: 'opus', channels: 1, sampleRate: 48000 })
  })

  it('expands non-square pixels', () => {
    const anamorphic: ProbeJson = {
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'h264',
          width: 1440,
          height: 1080,
          sample_aspect_ratio: '4:3',
          r_frame_rate: '25/1',
          avg_frame_rate: '25/1',
        },
      ],
    }
    expect(parseProbe(anamorphic, 0).video).toMatchObject({
      width: 1920,
      height: 1080,
      sar: [4, 3],
    })
  })

  it('reads an old rotate tag, clockwise', () => {
    const json: ProbeJson = {
      streams: [
        { index: 0, codec_type: 'video', width: 1280, height: 720, tags: { rotate: '270' } },
      ],
    }
    expect(parseProbe(json, 0).video).toMatchObject({ rotation: 270, width: 720, height: 1280 })
  })

  it('skips cover art', () => {
    const json: ProbeJson = {
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 600,
          height: 600,
          disposition: { attached_pic: 1 },
        },
        { index: 1, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
      ],
    }
    expect(parseProbe(json, 5).video).toMatchObject({ stream: 1, codec: 'h264' })
    expect(parseProbe(json, 5).bytes).toBe(5)
  })

  it('throws for files with no video', () => {
    const json: ProbeJson = {
      streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3', channels: 2 }],
    }
    expect(() => parseProbe(json, 0)).toThrow(NoVideoError)
  })
})
