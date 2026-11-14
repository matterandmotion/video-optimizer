# Video Optimizer

Make videos small and web-ready, in the browser. Files are processed on your device and never uploaded.

Work in progress: the engine is done, the app comes next. For now the page tries the engine on one video at a time.

## Development

Requires Node 22+, pnpm, and `ffmpeg` on your PATH (the tests make their test videos with it).

```sh
pnpm install
pnpm dev            # dev server
pnpm check          # type check
pnpm test           # unit tests, and engine tests in Node with the real FFmpeg build
pnpm build          # production build in dist/
pnpm preview        # serve dist/ with production headers
pnpm test:e2e       # browser tests against the production build (Playwright)
```

Pull requests go to `staging`. `staging` is merged into `main`.

## How it works

Videos are encoded in a Web Worker by [ffmpeg-lite](https://github.com/matterandmotion/ffmpeg-lite): FFmpeg 5.1 and x264, compiled to WebAssembly, with only what's needed to make H.264 MP4s.

- The video file isn't copied into memory: FFmpeg reads it in slices as it goes (Emscripten's WORKERFS).
- When the page is cross-origin isolated, the multi-threaded build runs with x264 on 8 threads, the decoder on 2 and filters on 2. Otherwise a single-threaded build runs, more slowly.
- x264's output depends on its thread count, so the counts are fixed: the same video and settings give the same bytes in every browser, and in Node. The engine is tested in Node (`src/engine/engine.test.ts`), with test videos made by the native `ffmpeg` and compared with its own x264.
- Each output is checked after encoding (`src/lib/mp4.ts`): the index comes first so playback starts early, and there's no location or rotation left in it.

## Third-party software

The site ships ffmpeg-lite as separate files under `vendor/ffmpeg-lite/<version>/`. It's a separate program under **GPL-2.0-or-later**: FFmpeg (built with `--enable-gpl`) and x264 (GPL-2.0-or-later), with zimg (WTFPL) and zlib (zlib licence). The complete source of each version is attached to its [release](https://github.com/matterandmotion/ffmpeg-lite/releases). The app talks to it only through FFmpeg's command-line arguments.

## License

[MIT](LICENSE)
