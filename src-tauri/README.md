# CraftDock Tauri migration slice

This is a separate Tauri v2 desktop target. It loads the existing `src/index.html` and its current assets directly; no renderer markup or styling is forked. Electron remains the default app and keeps its existing preload/IPC implementation.

## Run on Windows

Prerequisites: Rust with the MSVC target, the Visual Studio C++ Build Tools, and WebView2. From the repository root:

```sh
cargo install tauri-cli --version '^2' --locked
npm run tauri
```

Tauri starts `scripts/serve-tauri-renderer.js` on `127.0.0.1:4173`; the small static server serves the existing renderer and `/assets/` paths before launching the native webview.

## Migrated behavior

**Settings → Report Issue** invokes the `report_issue` Rust command, which opens the fixed `https://github.com/Geegamr/CraftDock/issues` URL through `tauri-plugin-opener`; the command accepts no URL from the webview. The existing renderer title bar is used without the operating system's title bar, and its minimize, maximize/restore, and close buttons call three narrow Rust window commands. Electron continues using its existing window-control and external-link IPC.

## Capability boundary

The `main-capability` capability allows `core:default` and `core:window:allow-start-dragging`, and grants `opener:allow-open-url` only for the exact issue-tracker URL. The registered Rust commands are limited to that fixed issue-tracker action and minimize, maximize/restore, and close on the current Tauri webview window. The existing renderer title bar is the only draggable region. No filesystem, shell, process, dialog, persistent store, authentication, server, Java, or instance commands are registered. The existing renderer relies on Electron APIs in many other flows; those flows are deliberately unsupported in this first slice and must not be treated as migrated. In browser/dev mode, the existing `window.open` fallback remains available.

The Tauri identifier uses a `.tauri` suffix so this target's app data/window identity does not collide with the existing Electron product identifier. Bundling is disabled for now; this is a runnable migration target, not a production installer.
