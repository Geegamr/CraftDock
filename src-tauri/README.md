# CraftDock Tauri target

This is a separate Tauri v2 desktop target. It loads the existing `src/index.html` and its current assets directly; no renderer markup or styling is forked. Electron remains the default app and keeps its existing preload/IPC implementation.

## Run from source

Prerequisites: Rust with the MSVC target, the Visual Studio C++ Build Tools, and WebView2. From the repository root:

```sh
cargo install tauri-cli --version '^2' --locked
npm run tauri          # development run
npm run tauri:build    # standalone craftdock.exe
```

The development run starts `scripts/serve-tauri-renderer.js` on `127.0.0.1:4173` and points the webview at that URL, so the window shows a connection error whenever the helper server is not running. Development binaries are debug builds, which also attach a console window. Neither applies to the release build below.

## Standalone executable

`npm run tauri:build` (`cargo tauri build`) first runs `scripts/build-tauri-renderer.js`, which copies `src/*.html` and `assets/` into `src-tauri/dist`. That directory is the configured `frontendDist`, so the release binary embeds the renderer and its assets and needs no dev server, Node, or Electron at runtime.

Output: `src-tauri/target/release/craftdock.exe`, a Windows GUI subsystem binary that opens its window with no console. Bundling is disabled, so no installer is produced; the single exe can be copied and run anywhere WebView2 is installed.

## Migrated behavior

The window buttons in CraftDock's own titlebar call `window_minimize`, `window_toggle_maximize`, and `window_close`; the window is created with the OS decorations off so only that titlebar is visible. Settings → Report Issue calls `report_issue`, which opens the fixed `https://github.com/Geegamr/CraftDock/issues` URL through `tauri-plugin-opener` and accepts no URL from the webview.

Persistence and CurseForge use the same renderer code as Electron. The renderer builds a small `tauriBridge()` when `window.__TAURI__` is present, and `Store` / `resourceApi()` prefer it, so settings, instance metadata and CurseForge calls work without Electron's preload:

- `store_get` / `store_set` / `store_delete` mirror Electron's file store: one pretty-printed JSON file per key (`craftdock:appSettings` → `craftdock_appSettings.json`). Data lives in the app data directory (`%APPDATA%\com.craftdock.launcher.tauri\data` on Windows). Set `CRAFTDOCK_DATA_ROOT` to reuse another directory, such as this repository's `craftdock-data/data`.
- Account tokens are encrypted with the same portable AES-256-GCM scheme and `.craftdock_key` file as Electron, and are only decrypted on read, so tokens never sit in plaintext on disk.
- `curseforge_search` and `cf_get_mc_versions` call `https://api.curseforge.com/v1` with the Minecraft game ID `432`. The key is read at runtime from `CF_API_KEY`, then `.env` in the working directory, then `.env` / `craftdock.env` beside `craftdock.exe`; it is never exposed to the webview. For a copied release exe, put `.env` next to it or set the environment variable.

`electron-store`-specific behavior (DPAPI `safe:` tokens) is not decrypted by Rust: such an account is reported as needing a fresh login.

## Capability boundary

The `main-capability` capability allows `core:default` and grants `opener:allow-open-url` only for the exact issue-tracker URL. The registered Rust commands are the three window controls, the fixed issue-tracker action, the store commands, and the two CurseForge commands. Store commands accept a key and JSON value and resolve every path themselves inside the fixed data root; CurseForge commands accept search filters only and use a fixed base URL and game ID. No command takes a filesystem path, an arbitrary URL, or a process argument from the webview, and no API key is ever returned to it.

No filesystem, shell, process, dialog, skin, authentication, server, Java, instance-file, or IPC-to-Node commands are registered. The existing renderer relies on Electron APIs in many other flows (installing or launching an instance, opening folders, signing in, scanning Java); those flows are deliberately unsupported in this target and must not be treated as migrated. In browser/dev mode, the existing `window.open` fallback remains available.

The Tauri identifier uses a `.tauri` suffix so this target's app data/window identity does not collide with the existing Electron product identifier.
