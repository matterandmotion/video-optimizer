import { describe, expect, it } from 'vitest'
import { planEncode } from '../lib/plan'
import {
  ENCODE_THREADS,
  READER_THREADS,
  encodeArgs,
  frameArgs,
  probeArgs,
  videoFilter,
} from './args'
import type { SourceInfo } from './types'

const phone: SourceInfo = {
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  bytes: 10_000_000,
  duration: 14.2,
  video: {
    stream: 0,
    codec: 'h264',
    profile: 'High',
    width: 1920,
    height: 1080,
    codedWidth: 1920,
    codedHeight: 1080,
    rotation: 0,
    sar: [1, 1],
    fps: [60000, 1001],
    vfr: false,
    pixelFormat: 'yuv420p',
    bitDepth: 8,
    colour: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'tv', hdr: null },
  },
  audio: { stream: 1, codec: 'aac', channels: 2, sampleRate: 48000 },
}

const hdr: SourceInfo = {
  ...phone,
  video: {
    ...phone.video,
    codec: 'hevc',
    pixelFormat: 'yuv420p10le',
    bitDepth: 10,
    fps: [30, 1],
    colour: {
      matrix: 'bt2020nc',
      primaries: 'bt2020',
      transfer: 'arib-std-b67',
      range: 'tv',
      hdr: 'hlg',
    },
  },
}

/** One option and its value per line, as the command would be written by hand. */
const join = (args: string[]) =>
  args
    .map((a, i) => (i > 0 && a.startsWith('-') && Number.isNaN(Number(a)) ? `\n${a}` : a))
    .join(' ')
    .replaceAll(' \n', '\n')

describe('encodeArgs', () => {
  it('makes a Background video from a 1080p60 phone clip', () => {
    const plan = planEncode(phone, { use: 'background', quality: 'balanced' })
    expect(join(encodeArgs('/in/input.mov', '/out/output.mp4', plan, ENCODE_THREADS)))
      .toMatchInlineSnapshot(`
        "-hide_banner
        -loglevel info
        -threads 2
        -filter_threads 2
        -i /in/input.mov
        -map 0:0
        -an
        -sn
        -dn
        -map_metadata -1
        -map_metadata:s:v -1
        -map_chapters -1
        -vf fps=30000/1001,scale=1280:720:flags=lanczos:in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p
        -c:v libx264
        -preset slow
        -crf 28
        -profile:v high
        -level:v 3.1
        -refs 5
        -maxrate 3000k
        -bufsize 6000k
        -g 120
        -threads 8
        -color_primaries bt709
        -color_trc bt709
        -colorspace bt709
        -color_range tv
        -movflags +faststart
        -fflags +bitexact
        -f mp4 /out/output.mp4"
      `)
  })

  it('keeps the sound for Content', () => {
    const plan = planEncode(phone, { use: 'content', quality: 'balanced' })
    expect(join(encodeArgs('/in/input.mov', '/out/output.mp4', plan, ENCODE_THREADS)))
      .toMatchInlineSnapshot(`
        "-hide_banner
        -loglevel info
        -threads 2
        -filter_threads 2
        -i /in/input.mov
        -map 0:0
        -map 0:1
        -sn
        -dn
        -map_metadata -1
        -map_metadata:s:v -1
        -map_metadata:s:a -1
        -map_chapters -1
        -vf fps=60000/1001,scale=1920:1080:flags=lanczos:in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p
        -c:v libx264
        -preset medium
        -crf 25
        -profile:v high
        -level:v 4.2
        -refs 3
        -maxrate 8000k
        -bufsize 16000k
        -g 120
        -threads 8
        -color_primaries bt709
        -color_trc bt709
        -colorspace bt709
        -color_range tv
        -c:a aac
        -b:a 128k
        -ac 2
        -ar 48000
        -movflags +faststart
        -fflags +bitexact
        -f mp4 /out/output.mp4"
      `)
  })

  it('tone-maps HDR to standard range', () => {
    const plan = planEncode(hdr, { use: 'hero', quality: 'higher' })
    expect(join(encodeArgs('/in/input.mov', '/out/output.mp4', plan, ENCODE_THREADS)))
      .toMatchInlineSnapshot(`
        "-hide_banner
        -loglevel info
        -threads 2
        -filter_threads 2
        -i /in/input.mov
        -map 0:0
        -an
        -sn
        -dn
        -map_metadata -1
        -map_metadata:s:v -1
        -map_chapters -1
        -vf fps=30/1,zscale=w=1920:h=1080:f=lanczos:tin=arib-std-b67:pin=2020:min=2020_ncl:rin=limited:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,setsar=1,format=yuv420p
        -c:v libx264
        -preset slow
        -crf 23
        -profile:v high
        -level:v 4.0
        -refs 4
        -maxrate 6000k
        -bufsize 12000k
        -g 120
        -threads 8
        -color_primaries bt709
        -color_trc bt709
        -colorspace bt709
        -color_range tv
        -movflags +faststart
        -fflags +bitexact
        -f mp4 /out/output.mp4"
      `)
  })

  it('sets every thread count', () => {
    const plan = planEncode(phone, { use: 'hero', quality: 'balanced' })
    const args = encodeArgs('/in/a.mp4', '/out/b.mp4', plan, ENCODE_THREADS)
    const input = args.indexOf('-i')
    expect(args.slice(0, input)).toEqual([
      ...['-hide_banner', '-loglevel', 'info'],
      ...['-threads', '2', '-filter_threads', '2'],
    ])
    expect(args.slice(input).join(' ')).toContain('-threads 8')
  })
})

describe('videoFilter', () => {
  it('reads full-range and BT.601 video explicitly', () => {
    const spec = {
      width: 640,
      height: 360,
      colour: { kind: 'sdr', matrix: 'bt601', range: 'pc' } as const,
    }
    expect(videoFilter(spec, false)).toBe(
      'scale=640:360:flags=lanczos:in_color_matrix=bt601:in_range=pc:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p',
    )
  })

  it('reads RGB video without a matrix', () => {
    const spec = {
      width: 1000,
      height: 562,
      fps: [30, 1] as [number, number],
      colour: { kind: 'rgb' } as const,
    }
    expect(videoFilter(spec, true)).toBe(
      'fps=30/1,scale=1000:562:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p',
    )
  })
})

describe('frameArgs', () => {
  it('makes one RGBA still through the encode’s steps', () => {
    const plan = planEncode(hdr, { use: 'background', quality: 'balanced' })
    const spec = {
      stream: 0,
      time: 2.5,
      width: plan.width,
      height: plan.height,
      colour: plan.colour,
    }
    expect(join(frameArgs('/in/input.mov', '/out/frame.rgba', spec, READER_THREADS)))
      .toMatchInlineSnapshot(`
        "-hide_banner
        -loglevel info
        -threads 1
        -filter_threads 1
        -ss 2.500
        -i /in/input.mov
        -map 0:0
        -an
        -sn
        -dn
        -frames:v 1
        -vf zscale=w=1280:h=720:f=lanczos:tin=arib-std-b67:pin=2020:min=2020_ncl:rin=limited:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,setsar=1,format=yuv420p,scale=flags=accurate_rnd+full_chroma_int:in_color_matrix=bt709:in_range=tv,format=rgba
        -c:v rawvideo
        -threads 1
        -f rawvideo /out/frame.rgba"
      `)
  })

  it('reads the first frame without seeking', () => {
    const spec = {
      stream: 0,
      time: 0,
      width: 1280,
      height: 720,
      colour: { kind: 'sdr', matrix: 'bt709', range: 'tv' } as const,
    }
    expect(frameArgs('/in/a.mp4', '/out/f.rgba', spec, READER_THREADS)).not.toContain('-ss')
  })
})

describe('probeArgs', () => {
  it('writes JSON to a file', () => {
    expect(probeArgs('/in/a.mov', '/out/probe.json').join(' ')).toBe(
      '-v error -print_format json -show_format -show_streams -o /out/probe.json /in/a.mov',
    )
  })
})
