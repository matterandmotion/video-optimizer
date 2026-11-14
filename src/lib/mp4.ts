/**
 * A small ISO-BMFF (MP4) reader: enough to check an output's structure and describe it.
 * Used after every encode as a self-check, and by the tests.
 */

export interface Mp4Info {
  /** Top-level boxes in file order, e.g. `['ftyp', 'moov', 'free', 'mdat']`. */
  boxes: string[]
  /** The index (`moov`) comes before the media (`mdat`): playback starts while loading. */
  faststart: boolean
  /** `mvhd` creation time; 0 when unset. */
  creationTime: number
  /** A location box or key anywhere in the index (`©xyz`, `loci`, Apple's ISO 6709 key). */
  hasLocation: boolean
  tracks: Mp4Track[]
}

export interface Mp4Track {
  /** `vide` or `soun`. */
  handler: string
  /** Codec string for `<source type>` and the manifest, e.g. `avc1.64001f`, `mp4a.40.2`. */
  codec: string | null
  /** Display size from `tkhd` (0 for audio). */
  width: number
  height: number
  /** The `tkhd` matrix isn't the identity: a player would rotate or flip the video. */
  transformed: boolean
  /** Seconds, from `mdhd`. */
  duration: number
  timescale: number
  /** Number of samples (frames for video). */
  samples: number
  /** Every sample lasts the same time (from `stts`). */
  constantRate: boolean
  /** `timescale / delta` when the rate is constant. */
  fps: [number, number] | null
  /** The track has an edit list (`edts`). */
  editList: boolean
}

interface Box {
  type: string
  /** Offset of the box's payload (after the header). */
  start: number
  /** Offset just past the box. */
  end: number
}

/** Throws when the bytes aren't an MP4 with an index. */
export function readMp4(bytes: Uint8Array): Mp4Info {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const top = children(view, 0, bytes.byteLength)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) throw new Error('not an MP4: no moov box')
  const mdat = top.findIndex((b) => b.type === 'mdat')
  const mvhd = children(view, moov.start, moov.end).find((b) => b.type === 'mvhd')
  return {
    boxes: top.map((b) => b.type),
    faststart: mdat === -1 || top.indexOf(moov) < mdat,
    creationTime: mvhd ? readTime(view, mvhd.start) : 0,
    hasLocation: hasLocation(bytes.subarray(moov.start, moov.end)),
    tracks: children(view, moov.start, moov.end)
      .filter((b) => b.type === 'trak')
      .map((trak) => readTrack(view, trak)),
  }
}

function readTrack(view: DataView, trak: Box): Mp4Track {
  const find = (path: string[], from: Box = trak): Box | undefined => {
    let box: Box | undefined = from
    for (const type of path) {
      box = box && children(view, box.start, box.end).find((b) => b.type === type)
    }
    return box
  }
  const tkhd = find(['tkhd'])!
  const mdhd = find(['mdia', 'mdhd'])!
  const hdlr = find(['mdia', 'hdlr'])!
  const stbl = find(['mdia', 'minf', 'stbl'])
  const stsd = stbl && find(['stsd'], stbl)
  const stts = stbl && find(['stts'], stbl)

  // tkhd: version 1 uses 64-bit times. The matrix and size follow the fixed fields.
  const v1 = view.getUint8(tkhd.start) === 1
  const matrixAt = tkhd.start + (v1 ? 52 : 40)
  const identity = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]
  const transformed = identity.some((v, i) => view.getInt32(matrixAt + i * 4) !== v)
  const width = view.getUint32(matrixAt + 36) / 0x10000
  const height = view.getUint32(matrixAt + 40) / 0x10000

  const m1 = view.getUint8(mdhd.start) === 1
  const timescale = view.getUint32(mdhd.start + (m1 ? 20 : 12))
  const units = m1 ? Number(view.getBigUint64(mdhd.start + 24)) : view.getUint32(mdhd.start + 16)

  const deltas: [count: number, delta: number][] = []
  if (stts)
    for (let i = 0, n = view.getUint32(stts.start + 4); i < n; i++)
      deltas.push([view.getUint32(stts.start + 8 + i * 8), view.getUint32(stts.start + 12 + i * 8)])
  const constantRate = deltas.length === 1
  return {
    handler: fourcc(view, hdlr.start + 8),
    codec: stsd ? readCodec(view, stsd) : null,
    width,
    height,
    transformed,
    duration: timescale ? units / timescale : 0,
    timescale,
    samples: deltas.reduce((sum, [count]) => sum + count, 0),
    constantRate,
    fps: constantRate ? reduce([timescale, deltas[0][1]]) : null,
    editList: !!find(['edts']),
  }
}

/** The first sample entry's codec string (RFC 6381): `avc1.PPCCLL` or `mp4a.40.N`. */
function readCodec(view: DataView, stsd: Box): string | null {
  const entry = children(view, stsd.start + 8, stsd.end)[0]
  if (!entry) return null
  if (entry.type === 'avc1' || entry.type === 'avc3') {
    // Visual sample entry: 78 bytes of fixed fields before its child boxes.
    const avcC = children(view, entry.start + 78, entry.end).find((b) => b.type === 'avcC')
    if (!avcC) return entry.type
    const hex = (at: number) =>
      view
        .getUint8(avcC.start + at)
        .toString(16)
        .padStart(2, '0')
    return `${entry.type}.${hex(1)}${hex(2)}${hex(3)}`
  }
  if (entry.type === 'mp4a') {
    // Audio sample entry: 28 bytes of fixed fields, then esds.
    const esds = children(view, entry.start + 28, entry.end).find((b) => b.type === 'esds')
    const config = esds && decoderConfig(view, esds.start + 4, esds.end)
    return config ? `mp4a.${config.objectType.toString(16)}.${config.audioObjectType}` : 'mp4a'
  }
  return entry.type
}

/** Walks the esds descriptors to the decoder config (tag 4) and its specific info (tag 5). */
function decoderConfig(view: DataView, start: number, end: number) {
  let objectType = 0
  for (let at = start; at < end;) {
    const tag = view.getUint8(at++)
    let size = 0
    for (let i = 0; i < 4; i++) {
      const b = view.getUint8(at++)
      size = (size << 7) | (b & 0x7f)
      if (!(b & 0x80)) break
    }
    if (tag === 3) {
      // ES descriptor: id (2), flags (1), optional fields by flag, then nested descriptors.
      const flags = view.getUint8(at + 2)
      at += 3
      if (flags & 0x80) at += 2 // depends on another stream
      if (flags & 0x40) at += 1 + view.getUint8(at) // URL
      if (flags & 0x20) at += 2 // OCR stream
    } else if (tag === 4) {
      objectType = view.getUint8(at)
      at += 13
    } else if (tag === 5) {
      return { objectType, audioObjectType: view.getUint8(at) >> 3 }
    } else at += size
  }
  return null
}

function children(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = []
  for (let at = start; at + 8 <= end;) {
    let size = view.getUint32(at)
    const type = fourcc(view, at + 4)
    let header = 8
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8))
      header = 16
    } else if (size === 0) size = end - at
    if (size < header || at + size > end) break
    boxes.push({ type, start: at + header, end: at + size })
    at += size
  }
  return boxes
}

function fourcc(view: DataView, at: number): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(at + i))
  return s
}

/** mvhd's creation time (seconds since 1904), version 0 or 1. */
function readTime(view: DataView, at: number): number {
  return view.getUint8(at) === 1 ? Number(view.getBigUint64(at + 4)) : view.getUint32(at + 4)
}

const LOCATION_MARKERS = ['\xa9xyz', 'loci', 'com.apple.quicktime.location']

function hasLocation(moov: Uint8Array): boolean {
  // Latin-1 keeps one character per byte, so '©' matches the 0xA9 of '©xyz'.
  const text = new TextDecoder('latin1').decode(moov)
  return LOCATION_MARKERS.some((m) => text.includes(m))
}

function reduce([num, den]: [number, number]): [number, number] {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const g = gcd(num, den) || 1
  return [num / g, den / g]
}
