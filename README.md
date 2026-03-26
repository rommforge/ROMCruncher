# RomMForge

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

- Drop `.dat` or `.xml` files into the `dat/` folder next to the executable — they are indexed automatically on startup
- Add individual files or entire folders to audit
- CHD files are verified using the SHA1 reported by `chdman info`
- Non-CHD files (ISO, BIN, etc.) are verified by direct SHA1/CRC32 hash
- Results show per-file match status and game name from the DAT

### Job Report
After every batch Create/Extract/Convert run, a summary table shows each file's result (success/fail) and DAT match status.

## Setup

1. Download or build `rommforge.exe`
2. Place it in a folder — the app creates `input/`, `output/`, `temp/`, and `dat/` subfolders automatically
3. Open **Settings** and set the path to `chdman.exe` (available as part of a MAME installation)
4. Optionally drop DAT files into the `dat/` subfolder

## Building from Source

**Requirements:**
- [Node.js](https://nodejs.org/) v18+
- [Rust](https://rustup.rs/) (stable)
- [Tauri CLI](https://tauri.app/start/prerequisites/)

```bash
npm install
npm run tauri build
```

The compiled executable will be at `src-tauri/target/release/rommforge.exe`.

## Tech Stack

- [Tauri v2](https://tauri.app/) — Rust backend
- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) — frontend
- [Vite](https://vitejs.dev/) — build tool
