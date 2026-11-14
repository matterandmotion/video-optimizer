import { describe, expect, it } from 'vitest'
import { classify } from './errors'

describe('classify', () => {
  it('reads the reason from FFmpeg’s log', () => {
    expect(
      classify([
        '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x3b57e0] moov atom not found',
        '/in/input.mp4: Invalid data found when processing input',
      ]),
    ).toBe('unreadable')
    expect(classify(['Decoder (codec av1) not found for input stream #0:0'])).toBe('codec')
    expect(classify(['Cannot enlarge memory arrays to size 2147483648 bytes (OOM).'])).toBe(
      'memory',
    )
    expect(classify(['[libx264 @ 0x1] Error: Cannot allocate memory'])).toBe('memory')
    expect(classify(["Stream map '0:3' matches no streams."])).toBe('no-video')
    expect(classify(['Error initializing filter', 'Invalid argument'])).toBe('failed')
  })
})
