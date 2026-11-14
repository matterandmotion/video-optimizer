// The engine in a real browser, against the production build (`vite preview` applies
// public/_headers, so the CSP and cross-origin isolation are the real ones). Drives the
// temporary engine page; the app's own flow tests replace this once the UI exists.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { readMp4 } from '../src/lib/mp4.ts'
import { fixture, type Fixture } from './fixtures.js'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

/** Fails the test on any CSP violation, console error or uncaught exception. */
async function watch(page: Page): Promise<() => string[]> {
  const problems: string[] = []
  await page.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP: ${e.violatedDirective} ${e.blockedURI}`),
    ),
  )
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
  page.on('pageerror', (e) => problems.push(e.message))
  return () => problems
}

async function choose(page: Page, name: Fixture) {
  await page.locator('input[type=file]').setInputFiles(fixture(name))
}

async function violations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  return violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}

test('loads the multi-threaded engine, cross-origin isolated', async ({ page }) => {
  const problems = await watch(page)
  await page.goto('/')
  await expect(page.getByText('Multi-threaded.')).toBeVisible({ timeout: 30_000 })
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
  expect(problems()).toEqual([])
})

test('makes a web-ready MP4', async ({ page }) => {
  const problems = await watch(page)
  await page.goto('/')
  await choose(page, 'hd.mp4')
  await expect(page.getByText('1920 × 1080 · 0:02 · 30 fps · H.264 · 5.2 MB')).toBeVisible()
  await expect(
    page.getByText('Makes 1280 × 720 · 30 fps · H.264 at CRF 28 · no sound'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Optimize' }).click()
  await expect(page.getByRole('progressbar', { name: 'Encoding hd.mp4' })).toBeVisible()

  const link = page.getByRole('link', { name: 'Download hd.mp4' })
  await expect(link).toBeVisible({ timeout: 90_000 })
  const download = page.waitForEvent('download')
  await link.click()
  const path = await (await download).path()
  const bytes = new Uint8Array(readFileSync(path))

  const mp4 = readMp4(bytes)
  expect(mp4).toMatchObject({ faststart: true, hasLocation: false, creationTime: 0 })
  expect(mp4.tracks).toHaveLength(1)
  expect(mp4.tracks[0]).toMatchObject({
    codec: 'avc1.64001f',
    width: 1280,
    height: 720,
    fps: [30, 1],
    samples: 60,
    transformed: false,
  })
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path], {
      encoding: 'utf8',
    }),
  )
  expect(probe.streams[0]).toMatchObject({
    codec_name: 'h264',
    profile: 'High',
    pix_fmt: 'yuv420p',
    color_range: 'tv',
    color_space: 'bt709',
    color_primaries: 'bt709',
    color_transfer: 'bt709',
  })
  expect(problems()).toEqual([])
})

test('stops an encode, then encodes again', async ({ page }) => {
  const problems = await watch(page)
  await page.goto('/')
  await choose(page, 'hd.mp4')
  await page.getByLabel('Use').selectOption('Hero')
  await page.getByRole('button', { name: 'Optimize' }).click()
  // Stop once x264 is running.
  await expect(page.getByText(/^[1-9]\d?%$/)).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText('Stopped.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Optimize' })).toBeVisible()

  await page.getByLabel('Use').selectOption('Background')
  await page.getByRole('button', { name: 'Optimize' }).click()
  await expect(page.getByRole('link', { name: 'Download hd.mp4' })).toBeVisible({
    timeout: 90_000,
  })
  expect(problems()).toEqual([])
})

test('falls back to one thread when the page isn’t cross-origin isolated', async ({ page }) => {
  // As on a host that ignores public/_headers.
  await page.route('http://localhost:4173/**', async (route) => {
    const response = await route.fetch()
    const headers = { ...response.headers() }
    delete headers['cross-origin-opener-policy']
    delete headers['cross-origin-embedder-policy']
    await route.fulfill({ response, headers })
  })
  const problems = await watch(page)
  await page.goto('/')
  await expect(page.getByText('Using one thread: encoding will be slower.')).toBeVisible({
    timeout: 30_000,
  })
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false)
  await choose(page, 'base.mp4')
  await page.getByRole('button', { name: 'Optimize' }).click()
  await expect(page.getByRole('link', { name: 'Download base.mp4' })).toBeVisible({
    timeout: 60_000,
  })
  expect(problems()).toEqual([])
})

test('explains files it can’t read', async ({ page }) => {
  await page.goto('/')
  await choose(page, 'garbage.mp4')
  await expect(page.getByText('Can’t read this file.')).toBeVisible()
  await choose(page, 'av1.mp4')
  await expect(
    page.getByText(
      'This video uses AV1, which this tool can’t read. Export it as H.264 or HEVC first.',
    ),
  ).toBeVisible()
  await choose(page, 'audio.m4a')
  await expect(page.getByText('This file has no video.')).toBeVisible()
  // The reader still works afterwards.
  await choose(page, 'base.mp4')
  await expect(page.getByText(/^640 × 360 · 0:01/)).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`axe finds nothing in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await page.goto('/')
    await expect(page.getByText('Multi-threaded.')).toBeVisible({ timeout: 30_000 })
    expect(await violations(page), 'empty').toEqual([])
    await choose(page, 'base.mp4')
    await page.getByRole('button', { name: 'Optimize' }).click()
    await expect(page.getByRole('link', { name: /^Download/ })).toBeVisible({ timeout: 60_000 })
    expect(await violations(page), 'done').toEqual([])
    await choose(page, 'garbage.mp4')
    await expect(page.getByText('Can’t read this file.')).toBeVisible()
    expect(await violations(page), 'failed').toEqual([])
  })
}
