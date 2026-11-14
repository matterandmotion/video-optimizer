<script lang="ts">
  // A temporary page for trying the engine on one video. The app itself replaces it.
  import { onDestroy } from 'svelte'
  import { ENCODE_THREADS, READER_THREADS } from './engine/args'
  import { CancelledError, Engine } from './engine/client'
  import { EngineError } from './engine/errors'
  import type { EngineInfo } from './engine/protocol'
  import type { SourceInfo } from './engine/types'
  import { formatBytes, formatDuration, formatFps, formatSaved } from './lib/format'
  import { failureMessage, codecName } from './lib/messages'
  import { readMp4 } from './lib/mp4'
  import {
    USES,
    checkSource,
    planEncode,
    type Quality,
    type Settings,
    type Sound,
    type Use,
  } from './lib/plan'
  import Select from './ui/Select.svelte'

  // One engine encodes; the other reads files, so it never waits for an encode.
  const engine = new Engine({ name: 'encoder', threads: ENCODE_THREADS, recycleAbove: 512 << 20 })
  const reader = new Engine({ name: 'reader', threads: READER_THREADS })

  const USE_OPTIONS = [
    { value: 'background', label: 'Background' },
    { value: 'hero', label: 'Hero' },
    { value: 'content', label: 'Content' },
  ] as const
  const QUALITY_OPTIONS = [
    { value: 'lower', label: 'Lower' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'higher', label: 'Higher' },
  ] as const
  const SOUND_OPTIONS = [
    { value: 'keep', label: 'Keep' },
    { value: 'remove', label: 'Remove' },
  ] as const

  type Status = 'empty' | 'reading' | 'ready' | 'encoding' | 'done' | 'stopped' | 'failed'

  let input: HTMLInputElement
  let info = $state<EngineInfo | null>(null)
  let file = $state<File | null>(null)
  let source = $state<SourceInfo | null>(null)
  let use = $state<Use>('background')
  let quality = $state<Quality>('balanced')
  let sound = $state<Sound | undefined>()
  let status = $state<Status>('empty')
  let progress = $state(0)
  let failure = $state<{ message: string; details: string } | null>(null)
  let result = $state<{ url: string; name: string; bytes: number; ms: number; codec: string }>()

  const settings = $derived<Settings>({ use, quality, sound })
  const plan = $derived(source ? planEncode(source, settings) : null)
  const canKeepSound = $derived(!!source?.audio && USES[use].sound !== 'never')

  reader.init().then((i) => (info = i))

  async function choose(chosen: File | undefined) {
    if (!chosen) return
    engine.cancel()
    clearResult()
    file = chosen
    source = null
    failure = null
    status = 'reading'
    try {
      const probed = await reader.probe(chosen)
      const problem = checkSource(probed)
      if (problem) return fail(failureMessage(problem, probed.video.codec))
      source = probed
      status = 'ready'
    } catch (e) {
      fail(e)
    }
  }

  async function optimize() {
    if (!file || !plan) return
    clearResult()
    failure = null
    status = 'encoding'
    progress = 0
    try {
      const done = await engine.encode(file, plan, (p) => (progress = p.ratio))
      const video = readMp4(done.bytes).tracks.find((t) => t.handler === 'vide')
      result = {
        url: URL.createObjectURL(new Blob([done.bytes], { type: 'video/mp4' })),
        name: `${file.name.replace(/\.[^.]+$/, '')}.mp4`,
        bytes: done.bytes.length,
        ms: done.ms,
        codec: video?.codec ?? '',
      }
      status = 'done'
    } catch (e) {
      if (e instanceof CancelledError) status = 'stopped'
      else fail(e)
    }
  }

  function fail(e: unknown) {
    status = 'failed'
    if (typeof e === 'string') failure = { message: e, details: '' }
    else if (e instanceof EngineError)
      failure = { message: failureMessage(e.kind, source?.video.codec), details: e.details }
    else failure = { message: failureMessage('failed'), details: String(e) }
  }

  function clearResult() {
    if (result) URL.revokeObjectURL(result.url)
    result = undefined
  }

  onDestroy(() => {
    engine.cancel()
    reader.cancel()
    clearResult()
  })

  const describeSource = (s: SourceInfo) =>
    [
      `${s.video.width} × ${s.video.height}`,
      formatDuration(s.duration),
      formatFps(s.video.fps),
      codecName(s.video.codec) + (s.video.colour.hdr ? ' HDR' : ''),
      formatBytes(s.bytes),
    ].join(' · ')

  const button =
    'rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-40'
  const secondary = `${button} border border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900`
  const primary = `${button} bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200`
  const muted = 'text-neutral-500 dark:text-neutral-400'
</script>

<input
  bind:this={input}
  type="file"
  accept="video/*,.mp4,.m4v,.mov,.webm,.mkv,.avi,.mts,.m2ts,.3gp"
  class="hidden"
  onchange={(e) => choose(e.currentTarget.files?.[0])}
/>

<div class="mx-auto flex min-h-dvh max-w-3xl flex-col px-4 py-6 sm:px-6">
  <header>
    <h1 class="text-base font-semibold">Video Optimizer</h1>
    <p class="mt-1 text-sm {muted}">
      Work in progress. This page tries the engine on one video; the app comes next.
    </p>
  </header>

  <main class="mt-6 flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        class={secondary}
        disabled={status === 'encoding'}
        onclick={() => input.click()}>Choose a video</button
      >
      <Select
        label="Use"
        value={use}
        options={USE_OPTIONS}
        disabled={status === 'encoding'}
        onchange={(v) => (use = v)}
      />
      <Select
        label="Quality"
        value={quality}
        options={QUALITY_OPTIONS}
        disabled={status === 'encoding'}
        onchange={(v) => (quality = v)}
      />
      {#if canKeepSound}
        <Select
          label="Sound"
          value={plan?.audio ? 'keep' : 'remove'}
          options={SOUND_OPTIONS}
          disabled={status === 'encoding'}
          onchange={(v) => (sound = v)}
        />
      {/if}
    </div>

    {#if file}
      <section aria-label="Video" class="flex flex-col gap-1 text-sm">
        <p class="font-medium break-all">{file.name}</p>
        {#if status === 'reading'}
          <p class={muted}>Reading…</p>
        {:else if source && plan}
          <p class={muted}>{describeSource(source)}</p>
          <p>
            Makes {plan.width} × {plan.height} · {formatFps(plan.fps)} · H.264 at CRF {plan.crf} ·
            {plan.audio ? `AAC ${plan.audio.bitrate} kbit/s` : 'no sound'}{source.video.colour.hdr
              ? ' · HDR converted to standard range'
              : ''}
          </p>
        {/if}
      </section>
    {/if}

    {#if source && plan}
      <div class="flex flex-wrap items-center gap-2">
        {#if status === 'encoding'}
          <button type="button" class={secondary} onclick={() => engine.cancel()}>Stop</button>
          <progress
            class="h-1.5 w-48 overflow-hidden rounded-full bg-neutral-200 accent-neutral-900 dark:bg-neutral-800 dark:accent-white"
            aria-label="Encoding {file?.name}"
            max="1"
            value={progress}
          ></progress>
          <span class="text-sm tabular-nums {muted}">{Math.round(progress * 100)}%</span>
        {:else}
          <button type="button" class={primary} onclick={optimize}>Optimize</button>
        {/if}
        {#if status === 'stopped'}
          <span class="text-sm {muted}">Stopped.</span>
        {/if}
      </div>
    {/if}

    {#if failure}
      <div class="text-sm">
        <p class="text-red-700 dark:text-red-400">{failure.message}</p>
        {#if failure.details}
          <details class="mt-2">
            <summary class="cursor-pointer {muted}">Details</summary>
            <pre
              class="mt-2 overflow-x-auto text-xs whitespace-pre-wrap {muted}">{failure.details}</pre>
          </details>
        {/if}
      </div>
    {/if}

    {#if result && source}
      <section aria-label="Result" class="flex flex-col gap-3 text-sm">
        <p class="tabular-nums">
          {formatBytes(result.bytes)} · {formatSaved(source.bytes, result.bytes)} smaller · made in
          {formatDuration(result.ms / 1000)}
          <span class={muted}>({result.codec})</span>
        </p>
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="max-h-[60vh] w-full rounded-md bg-neutral-100 dark:bg-neutral-900"
          src={result.url}
          controls
          muted
          playsinline
        ></video>
        <p>
          <a class={`${primary} inline-block`} href={result.url} download={result.name}
            >Download {result.name}</a
          >
        </p>
      </section>
    {/if}
  </main>

  <footer class="mt-auto flex flex-wrap justify-between gap-x-6 gap-y-1 pt-10 text-sm {muted}">
    <p>Files are processed on this device and never uploaded.</p>
    {#if info}
      <p>
        {info.threads === 'multi'
          ? 'Multi-threaded.'
          : 'Using one thread: encoding will be slower.'}
      </p>
    {/if}
  </footer>
</div>
