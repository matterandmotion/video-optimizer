import { describe, expect, it } from 'vitest'
import { codecName, failureMessage } from './messages'

describe('failureMessage', () => {
  it('says plainly why a file can’t be optimized', () => {
    expect(failureMessage('unreadable')).toBe('Can’t read this file.')
    expect(failureMessage('codec', 'av1')).toBe(
      'This video uses AV1, which this tool can’t read. Export it as H.264 or HEVC first.',
    )
    expect(failureMessage('too-large')).toMatch(/^Larger than 4.5 GB/)
  })

  it('names codecs as people know them', () => {
    expect(codecName('hevc')).toBe('HEVC')
    expect(codecName('cinepak')).toBe('CINEPAK')
  })
})
