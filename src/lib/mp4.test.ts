import { describe, expect, it } from 'vitest'
import { readMp4 } from './mp4'

// Minimal MP4s built box by box.

const bytes = (...parts: (Uint8Array | number[])[]) => {
  const all = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)))
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of all) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const u16 = (n: number) => [n >> 8, n & 0xff]
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const latin1 = (s: string) => [...s].map((c) => c.charCodeAt(0))
const zeros = (n: number) => new Array(n).fill(0)
const box = (type: string, ...payload: (Uint8Array | number[])[]) => {
  const body = bytes(...payload)
  return bytes(u32(8 + body.length), latin1(type), body)
}

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]
const ROTATE_90 = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000]

const tkhd = (width: number, height: number, matrix = IDENTITY) =>
  box(
    'tkhd',
    zeros(4),
    zeros(20),
    zeros(16),
    matrix.flatMap(u32),
    u32(width << 16),
    u32(height << 16),
  )
const mdhd = (timescale: number, duration: number) =>
  box('mdhd', zeros(4), zeros(8), u32(timescale), u32(duration), zeros(4))
const hdlr = (handler: string) => box('hdlr', zeros(8), latin1(handler), zeros(12), [0])
const stts = (...entries: [number, number][]) =>
  box(
    'stts',
    zeros(4),
    u32(entries.length),
    entries.flatMap(([n, d]) => [...u32(n), ...u32(d)]),
  )
const stsd = (entry: Uint8Array) => box('stsd', zeros(4), u32(1), entry)
const avc1 = (profile: number, compat: number, level: number) =>
  box('avc1', zeros(78), box('avcC', [1, profile, compat, level, 0xff, 0xe1]))
// esds: ES descriptor (3) > decoder config (4, AAC is 0x40) > specific info (5, LC is 2).
const esds = box(
  'esds',
  zeros(4),
  [3, 25, ...u16(1), 0],
  [4, 17, 0x40, 0x15, ...zeros(11)],
  [5, 2, (2 << 3) | 1, 0x90],
)
const mp4a = box('mp4a', zeros(28), esds)

const videoTrak = (options: { matrix?: number[]; deltas?: [number, number][] } = {}) =>
  box(
    'trak',
    tkhd(1280, 720, options.matrix),
    box('edts', box('elst', zeros(4), u32(0))),
    box(
      'mdia',
      mdhd(15360, 30720),
      hdlr('vide'),
      box(
        'minf',
        box('stbl', stsd(avc1(0x64, 0x00, 0x1f)), stts(...(options.deltas ?? [[60, 512]]))),
      ),
    ),
  )
const audioTrak = box(
  'trak',
  tkhd(0, 0),
  box(
    'mdia',
    mdhd(48000, 96000),
    hdlr('soun'),
    box('minf', box('stbl', stsd(mp4a), stts([94, 1024]))),
  ),
)
const mvhd = (created = 0) => box('mvhd', zeros(4), u32(created), zeros(92))
const ftyp = box('ftyp', latin1('isom'), u32(512), latin1('isomiso2avc1mp41'))
const mdat = box('mdat', zeros(16))

describe('readMp4', () => {
  it('reads a faststart MP4 with video and sound', () => {
    const file = bytes(ftyp, box('moov', mvhd(), videoTrak(), audioTrak), box('free'), mdat)
    expect(readMp4(file)).toEqual({
      boxes: ['ftyp', 'moov', 'free', 'mdat'],
      faststart: true,
      creationTime: 0,
      hasLocation: false,
      tracks: [
        {
          handler: 'vide',
          codec: 'avc1.64001f',
          width: 1280,
          height: 720,
          transformed: false,
          duration: 2,
          timescale: 15360,
          samples: 60,
          constantRate: true,
          fps: [30, 1],
          editList: true,
        },
        {
          handler: 'soun',
          codec: 'mp4a.40.2',
          width: 0,
          height: 0,
          transformed: false,
          duration: 2,
          timescale: 48000,
          samples: 94,
          constantRate: true,
          fps: [375, 8],
          editList: false,
        },
      ],
    })
  })

  it('notices the index after the media', () => {
    expect(readMp4(bytes(ftyp, mdat, box('moov', mvhd(), videoTrak()))).faststart).toBe(false)
  })

  it('notices a rotation matrix and a variable frame rate', () => {
    const trak = videoTrak({
      matrix: ROTATE_90,
      deltas: [
        [30, 512],
        [1, 1024],
        [29, 512],
      ],
    })
    const [track] = readMp4(bytes(ftyp, box('moov', mvhd(), trak), mdat)).tracks
    expect(track).toMatchObject({ transformed: true, constantRate: false, fps: null, samples: 60 })
  })

  it('notices location and creation time', () => {
    const udta = box('udta', box('\xa9xyz', u16(18), u16(0), latin1('+40.7128-074.0060/')))
    const info = readMp4(bytes(ftyp, box('moov', mvhd(3_000_000_000), videoTrak(), udta), mdat))
    expect(info.hasLocation).toBe(true)
    expect(info.creationTime).toBe(3_000_000_000)
    const apple = box('meta', latin1('com.apple.quicktime.location.ISO6709'))
    expect(readMp4(bytes(ftyp, box('moov', mvhd(), apple), mdat)).hasLocation).toBe(true)
  })

  it('reads 64-bit box sizes', () => {
    const large = bytes(u32(1), latin1('mdat'), u32(0), u32(24), zeros(8))
    expect(readMp4(bytes(ftyp, box('moov', mvhd()), large)).boxes).toEqual(['ftyp', 'moov', 'mdat'])
  })

  it('throws for files without an index', () => {
    expect(() => readMp4(bytes(ftyp, mdat))).toThrow('no moov box')
    expect(() => readMp4(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })
})
