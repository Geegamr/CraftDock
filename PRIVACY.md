# Privacy Policy

**Last updated: 5 November 2026, version 1.0**

CraftDock is a desktop Minecraft launcher. There is no CraftDock account, no CraftDock server, and no analytics. This page explains what stays on your computer and what goes to other services when you use the app.

## The short version

- No telemetry, no analytics, no crash reporting, no advertising, no tracking.
- No personal data is sold or shared, because none is collected.
- Instances, worlds, mods, settings, and playtime stay on your computer.
- Microsoft sign-in tokens stay on your computer, encrypted.
- Some features ask other services for data. Those services see your IP address and what you asked for, as they would if you used them in a browser.

## Who is responsible

CraftDock is developed by an individual developer. Contact: [GitHub issues](https://github.com/Geegamr/CraftDock/issues) or [Discord](https://discord.gg/zfmemagrZR).

## Data stored on your computer

CraftDock keeps its data in a folder named craftdock-data:

- In the portable build, next to the executable.
- In the installed build, in your user profile: the CraftDock folder inside your application data folder, for example the AppData/Roaming folder on Windows, and the equivalent application-support folder on macOS and Linux.
- In a development build, in the project folder.

That folder holds:

- Instances: mods, worlds, configs, resource packs, screenshots, and logs.
- Servers: server files, backups, and console logs.
- Accounts: your Minecraft username and UUID, skin address, and your Microsoft and Xbox authentication tokens, in craftdock_accounts.json.
- Settings: Java paths, preferences, playtime counters, and cached lists and images.

Tokens are encrypted with AES-256-GCM using a random key created per installation and stored beside the data. That protects them from casual reading of the file, but not from someone who already controls your user account or has your disk. Treat the data folder as sensitive.

None of it is uploaded anywhere. Delete the data folder or uninstall CraftDock to remove all of it.

## What is sent to other services

CraftDock talks directly to the services below. Each request exposes your IP address, a User-Agent with the app name and version, and whatever the request needs, as any app or browser would. Each service handles that data under its own privacy policy.

- Microsoft account and Xbox Live (login.microsoftonline.com, user.auth.xboxlive.com, xsts.auth.xboxlive.com): only when you sign in or a token refreshes. Receives the device code, client ID, and tokens. [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement)
- Minecraft services (api.minecraftservices.com, textures.minecraft.net): your Minecraft profile, entitlements, and skin. [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement)
- Mojang metadata and asset servers (launchermeta.mojang.com, resources.download.minecraft.net): version metadata, libraries, assets, and server jars. [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement)
- Modrinth (api.modrinth.com): search terms, project and version IDs, and downloads. [Modrinth privacy policy](https://modrinth.com/legal/privacy)
- CurseForge (api.curseforge.com, edge.forgecdn.net): search terms, mod and modpack IDs, and downloads. Requests are made with an API key belonging to the CraftDock developer, so CurseForge can associate them with that key. [CurseForge privacy policy](https://www.curseforge.com/legal/privacy)
- Mod loaders and server software (meta.fabricmc.net, meta.quiltmc.org, maven.neoforged.net, files.minecraftforge.net, maven.minecraftforge.net, fill.papermc.io, api.purpurmc.org, hangar.papermc.io, api.spiget.org, www.spigotmc.org): version lists and downloads, under their own policies.
- Adoptium (api.adoptium.net): Java runtime downloads, only when CraftDock needs a Java version you do not have. [Eclipse Foundation privacy policy](https://www.eclipse.org/legal/privacy/)
- GitHub (api.github.com): the update check, once per launch, and update downloads. [GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-privacy-statement)
- Cloudflare cdnjs (cdnjs.cloudflare.com): loads the three.js library used by the 3D skin preview, on every launch. [Cloudflare privacy policy](https://www.cloudflare.com/privacypolicy/)
- mc-heads.net: player avatar images, when an avatar is displayed. [mc-heads.net](https://mc-heads.net)
- ipify (api.ipify.org): only if you press Reveal IP while creating a server; returns your public IP so it can be filled in. [ipify privacy policy](https://www.ipify.org/legal/privacy-policy)

We do not receive any of these requests and run no server that logs them.

## Logs

CraftDock keeps an in-app console log on your computer for troubleshooting. It can contain file paths that include your Windows username, player names, server addresses, and download links. It is not uploaded automatically. If you paste a log into a bug report, you are publishing it, so remove anything you do not want public.

## Children

CraftDock is not directed at children under 13. Using Minecraft requires a Microsoft account, which has its own age requirements. No data is knowingly collected from anyone, of any age, because no data is collected at all.

## Your rights

Laws such as the GDPR and the CCPA/CPRA give you rights to access, correct, delete, and port your personal data and to object to its processing. CraftDock stores your data only on your computer and never sends it to us, so you exercise those rights directly: open the data folder, change it, or delete it. If you contact us we will help where we can, but we cannot access or delete data we never received.

The services listed above process data under their own policies. Contact them directly for requests about their records.

Where the GDPR applies, processing happens because you asked for it (signing in, downloading a mod) and for the legitimate interest of making the app work. No personal data is sold, used for targeted advertising, or used for automated decision-making.

## Security

Traffic to these services uses HTTPS, and tokens are encrypted at rest as described above. No system is perfectly secure. Protect your computer account and your Microsoft account with a strong password and two-factor authentication.

## Changes to this policy

If this policy changes, the new version ships with the app under Settings, Legal, and the date at the top changes. Significant changes are noted in the release notes.
