import type { Rational } from '../engine/types'

/** Decimal units, like file managers and browser dev tools: 148 KB, 2.4 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 10_000) return `${(bytes / 1000).toFixed(1)} KB`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** Share of the original saved: `94.9%`, or negative (`−19.6%`) when the output is larger. */
export function formatSaved(original: number, output: number): string {
  if (original === 0) return '—'
  const saved = (1 - output / original) * 100
  return saved < 0 ? `−${(-saved).toFixed(1)}%` : `${saved.toFixed(1)}%`
}

/** `0:14`, `2:05`, `1:02:03`, rounded to the nearest second. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** `30 fps`, `29.97 fps`, `12.5 fps`. */
export function formatFps([num, den]: Rational): string {
  return `${Number((num / den).toFixed(2))} fps`
}
