# Firefox AMO source build instructions

This source package rebuilds the Firefox extension submitted to addons.mozilla.org.
The project does not bundle or minify first-party JavaScript. The release script selects
the Firefox manifest fields, generates `storeConfig.js`, copies the required files, and
creates the final ZIP archive.

## Build environment

- Operating system: Windows, macOS, or Linux
- Node.js: 22 or later
- npm: 10 or later
- Network access is required only for `npm ci`

## Build the submitted extension

From the extracted source package root, run:

```bash
npm ci
npm run build:firefox
```

The resulting extension archive is:

```text
dist/bilitato-firefox-v1.6.0.zip
```

The unpacked extension is written to:

```text
dist/bilitato-firefox-v1.6.0/
```

Reviewers can compare that unpacked directory with the contents of the submitted add-on
archive. ZIP container metadata can vary between tools, so comparisons should be made on
the extracted files.

## Optional verification

```bash
npm test
node --check background.js
node --check content.js
node --check offscreen.js
```

## Bundled third-party libraries

- `html2canvas` 1.4.1: https://github.com/niklasvh/html2canvas
- `@ffmpeg/ffmpeg` 0.12.15: https://github.com/ffmpegwasm/ffmpeg.wasm
- `@ffmpeg/core` 0.12.10: https://github.com/ffmpegwasm/ffmpeg.wasm
- `@ffmpeg/util` 0.12.2: https://github.com/ffmpegwasm/ffmpeg.wasm

These libraries are included locally in the extension. The extension does not download or
execute remote code.
