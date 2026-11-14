import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration, formatFps, formatSaved } from './format'

describe('format', () => {
  it('formats sizes and savings', () => {
    expect(formatBytes(812_345)).toBe('812 KB')
    expect(formatBytes(6_312_345)).toBe('6.3 MB')
    expect(formatSaved(6_312_345, 812_345)).toBe('87.1%')
    expect(formatSaved(100, 120)).toBe('−20.0%')
  })

  it('formats durations', () => {
    expect(formatDuration(14.2)).toBe('0:14')
    expect(formatDuration(113.4)).toBe('1:53')
    expect(formatDuration(3723)).toBe('1:02:03')
    expect(formatDuration(0.4)).toBe('0:00')
  })

  it('formats frame rates', () => {
    expect(formatFps([30, 1])).toBe('30 fps')
    expect(formatFps([30000, 1001])).toBe('29.97 fps')
    expect(formatFps([60000, 1001])).toBe('59.94 fps')
    expect(formatFps([25, 2])).toBe('12.5 fps')
  })
})
