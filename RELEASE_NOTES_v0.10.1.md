# CraftDock v0.10.1

Released: November 11, 2026

## Skin manager

- Corrected Minecraft's flipped bottom-face texture orientation on the head, hat, body, arms, legs, and outer layers.
- Loading the active profile skin now shows its real Classic or Slim model.
- The currently shown skin can be saved to the library, and saving an existing library skin updates that entry in place instead of creating a duplicate.
- Saved outfits now include the active cape and restore it when the outfit is selected.
- The cape preview uses the full Minecraft cape atlas: outside, inside, left, right, top, and bottom strips, with a one-pixel-thick slab parented to the character.

## Skin downloads

- Downloading a player skin now resolves Mojang's profile metadata and saves the correct Slim or Classic model.
- Legacy `http://textures.minecraft.net` skin URLs are upgraded to HTTPS before download.
- When profile metadata is unavailable, the PNG is inspected using skinview3d's unused-arm-strip detection.
- The download preview shows whether the skin was detected as Slim or Classic.

## Notes

- Existing saved skins keep their previously stored model. Re-download them to refresh an incorrect Slim/Classic value.
- Version declarations are synchronized across Electron, Tauri, the lockfiles, README, and the renderer.

## Artifacts

- `CraftDock-Setup-0.10.1.exe` — Windows x64 installer
- `CraftDock.0.10.1.exe` — Windows x64 portable executable
- `CraftDock.Tauri.0.10.1.exe` — Tauri Windows x64 standalone executable

The Windows builds are unsigned because no code-signing certificate is configured; Windows SmartScreen may warn on first launch. The release also includes `latest.yml` and the installer blockmap for the in-app updater.

## SHA-256 checksums

```text
547e52d0bdb5f3e80d803684d009f99e384c0cc32bf4647c8c31653d3a3b232b  CraftDock-Setup-0.10.1.exe
a163760305845b0388aaff4dbe0bbd8d62668b3003f7f3ee43f73e0d6e8077eb  CraftDock.0.10.1.exe
dbc4154fe9725e12a3ec378e9f71cad401f14c5af340082a576f72e76c1d4e1c  CraftDock.Tauri.0.10.1.exe
```
