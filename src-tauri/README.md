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

Two renderer behaviors use Rust. The window buttons in CraftDock's own titlebar call `window_minimize`, `window_toggle_maximize`, and `window_close`; the window is created with the OS decorations off so only that titlebar is visible. Settings → Report Issue calls `report_issue`, which opens the fixed `https://github.com/Geegamr/CraftDock/issues` URL through `tauri-plugin-opener` and accepts no URL from the webview.

## Capability boundary

The `main-capability` capability allows `core:default` and grants `opener:allow-open-url` only for the exact issue-tracker URL. The only registered Rust commands are the three window controls and the fixed issue-tracker action; they take no paths, URLs, or process arguments from the webview. No filesystem, shell, process, dialog, persistent store, authentication, server, Java, instance, or IPC-to-Node commands are registered. The existing renderer relies on Electron APIs in many other flows; those flows are deliberately unsupported in this target and must not be treated as migrated. In browser/dev mode, the existing `window.open` fallback remains available.

The Tauri identifier uses a `.tauri` suffix so this target's app data/window identity does not collide with the existing Electron product identifier.
