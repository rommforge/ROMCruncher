# ROMCruncher

> **Disclaimer:** This application was entirely vibe coded using [Claude AI](https://claude.ai). The author has no formal software development experience or background. While good-faith efforts have been made to ensure this tool only does what it is designed to do, bugs and unintended behavior are possible. **Always back up your data before converting anything.**

A GUI frontend for [chdman](https://docs.mamedev.org/tools/chdman.html), the CHD file utility from MAME. Built with Tauri v2, React 19, and TypeScript.

## Features

### Create CHD
Convert disc and disk images into CHD format. Auto-detects media type from file extension and size:
- **CD-ROM** — `.cue`, `.gdi`, or `.iso` under 1 GB
- **DVD-ROM** — `.iso` over 1 GB
- **Hard Disk** — `.img`, `.bin`
- **Raw** — `.raw`
- **LaserDisc** — `.avi`

Supports batch processing, archive extraction (`.zip`, `.7z`, `.rar`), compression options, hunk size, CPU thread control, and overwrite (`--force`).

### Extract CHD
Extract CHD files back to their original formats. Auto-detects CHD type via `chdman info` metadata tags. Supports split `.bin` per track for CD-ROM (`--splitbin`).

### Convert CHD
Re-encode CHD files using the current chdman version to ensure hash compatibility. Useful for updating CHDs created with older versions of MAME.

### CHD Info
Inspect any CHD file and view its full `chdman info` output.

### Verify CHD
Run `chdman verify` to validate CHD file integrity.

### DAT Audit
Verify CHD or disc image files against No-Intro, Redump, or TOSEC DAT databases.

- Use **+ Add File** or **+ Add Folder** in the DAT panel to load `.dat`/`.xml` files from anywhere on your system
- Alternatively, drop `.dat` or `.xml` files into the `dat/` folder next to the executable — they are indexed automatically on startup
- Extra DAT sources are saved in `settings.json` and restored between sessions
- Add individual files or entire folders to audit
- CHD files are matched against both the Data SHA1 and the top-level CHD SHA1 reported by `chdman info`, covering No-Intro, Redump, and MAME DAT formats
- Non-CHD files (ISO, BIN, etc.) are verified by direct SHA1/CRC32 hash
- Results show per-file match status and game name from the DAT

### Job Report
After every batch Create/Extract/Convert run, a summary table shows each file's result (success/fail) and DAT match status.

## Setup

1. Download or build `romcruncher.exe`
2. Place it in a folder — the app creates `input/`, `output/`, `temp/`, and `dat/` subfolders automatically
3. Open **Settings** and set the path to `chdman.exe` (available as part of a MAME installation)
4. Optionally load DAT files — either drop them into the `dat/` subfolder or use **+ Add File** / **+ Add Folder** in the DAT Audit panel to point to DAT files anywhere on your system

## Building from Source

**Requirements:**
- [Node.js](https://nodejs.org/) v18+
- [Rust](https://rustup.rs/) (stable)
- [Tauri CLI](https://tauri.app/start/prerequisites/)

```bash
npm install
npm run tauri build
```

The compiled executable will be at `src-tauri/target/release/romcruncher.exe`.

## Acknowledgements

ROMCruncher draws heavy inspiration from:

- [namDHC](https://github.com/umageddon/namDHC/) by umageddon
- [Compressatorium](https://github.com/pacnpal/compressatorium) by pacnpal

### Built on the shoulders of

ROMCruncher would not be possible without:

- [MAME](https://github.com/mamedev/mame/) — the source of `chdman`, the engine that powers all CHD operations
- [MAMERedump](https://github.com/MetalSlug/MAMERedump) — the DAT resources that make disc image auditing possible

## Tech Stack

- [Tauri v2](https://tauri.app/) — Rust backend
- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) — frontend
- [Vite](https://vitejs.dev/) — build tool
