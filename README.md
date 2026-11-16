# Relay

Relay is a Windows x64 launcher for Minecraft Java Edition. It keeps each instance’s worlds, settings, and mods in its own folder and shares downloaded game files between instances.

## Install and play

1. Download `Relay-Setup-<version>.exe` from [GitHub Releases](https://github.com/NoobIsADev/Relay/releases).
2. Open Relay and select **Sign in**, then **Continue in browser**. Complete the Microsoft device-code prompt with an account that owns Minecraft Java Edition.
3. Create an instance, choose a Minecraft version and loader, and select **Play**. First launch downloads the required game files and Java runtime.
4. Use **Discover** to install Modrinth mods, modpacks, shaders, and resource packs. Select an instance to filter for compatible downloads. Modpacks create separate instances.

Vanilla, Fabric, Legacy Fabric, Forge, LiteLoader, and Quilt are available in the instance picker. Available loaders and versions depend on the selected Minecraft release. NeoForge is also supported when a Modrinth pack requires it.

Settings include the Light Blue, Midnight, Mint, Lavender, and Windows themes, a custom accent, notification sounds and toasts, memory limits, and Java overrides. Instance names, accents, memory, and Java settings can be customized independently.

## Microsoft sign-in

Relay uses the same Prismarine Auth device-code flow as SpectorClient by default. Microsoft may show **Minecraft for Nintendo Switch**, the sign-in title that this library uses. Your system browser completes sign-in, then Relay requests your Minecraft Java profile. On Windows, Relay stores its token cache encrypted with Electron safeStorage. An approved public application ID can be set under **Settings → Microsoft account → Advanced sign-in** if needed.

## Build and publish

Install Node.js 22.12 or newer, Git, and the GitHub CLI. For publishing, sign in once with `gh auth login` using an account with write access to `NoobIsADev/Relay`.

```powershell
npm ci
npm start
npm run check
npm run dist
```

Run `PUSH-AND-RELEASE.bat` from the repository’s `main` checkout. The first run uses the current version, and subsequent runs bump the patch version. It builds the installer, commits and pushes the source, tags the commit, uploads the installer, blockmap and updater manifest to a draft, and publishes the release after all three files are uploaded. Use `PUSH-AND-RELEASE.bat minor` for a minor release, `PUSH-AND-RELEASE.bat 1.2.3` to set a version, or `npm run release -- --dry-run` to check the destination and version.

Installed copies check GitHub Releases at startup and periodically. A downloaded release can be installed from the launcher, or it installs on normal exit. The Windows installer is unsigned.

Relay stores its library under `%APPDATA%\Relay`. Relay is an independent launcher and is unaffiliated with Mojang, Microsoft, and Modrinth.

## Artwork

The Relay mark comes from the supplied logo. The built-in ImageGen tool generated the voxel river background at `assets/river.jpg` using this prompt.

> Wide panoramic desktop game launcher hero artwork, stylized 3D voxel Minecraft-like landscape. A quiet pale-blue dawn above a glacier-blue winding river, blocky grassy cliffs and scattered spruce trees, detailed stepped stone, dramatic right-weighted composition, distant fog softly dissolving into negative space across the left third for a text overlay. Cool misty indigo foreground and brighter icy aqua highlights to the right. Cozy and exploratory, premium game key art, sharp geometry, no characters, no lettering, no logo, no UI, no watermark. A 3:1 wide crop through the middle must preserve the river and cliff. Also works as soft darkened small thumbnail.
