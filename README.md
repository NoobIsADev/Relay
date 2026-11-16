# Relay

Relay is a Minecraft Java Edition launcher for Windows and Linux on x86-64. It keeps each instance’s worlds, settings, and mods in its own folder and shares downloaded game files between instances.

## Install and play

1. Download the Windows installer or the Linux x86-64 AppImage from [GitHub Releases](https://github.com/NoobIsADev/Relay/releases). Make the AppImage executable with `chmod +x Relay-*-x86_64.AppImage`, then run that file directly from a folder you can write to.
2. Open Relay and select **Sign in**, then **Continue in browser**. Complete the Microsoft device-code prompt with an account that owns Minecraft Java Edition.
3. Create an instance, choose a Minecraft version and loader, and select **Play**. First launch downloads the required game files and Java runtime.
4. Use **Discover** to install Modrinth mods, modpacks, shaders, and resource packs. Select an instance to filter for compatible downloads. Modpacks create separate instances.

Vanilla, Fabric, Legacy Fabric, Forge, LiteLoader, and Quilt are available in the instance picker. Available loaders and versions depend on the selected Minecraft release. NeoForge is also supported when a Modrinth pack requires it.

Settings include Light Blue, Midnight, Mint, Lavender, and system themes, a custom accent, notification sounds and toasts, memory limits, and Java overrides. Instance names, accents, memory, and Java settings can be customized independently.

Under **Settings → Shared files**, you can share resource packs and shader packs independently across every instance. Relay combines existing files into the shared folder and gives different files with the same name a numbered suffix. Turning sharing off gives each instance its own copy of the shared files. Pack selection still happens in each game instance.

## Microsoft sign-in

Relay uses the same Prismarine Auth device-code flow as SpectorClient by default. Microsoft may show **Minecraft for Nintendo Switch**, the sign-in title that this library uses. Your system browser completes sign-in, then Relay requests your Minecraft Java profile. Relay encrypts its token cache using the operating system’s secure storage. On Linux without a supported desktop keyring, sign-in lasts until Relay exits. An approved public application ID can be set under **Settings → Microsoft account → Advanced sign-in** if needed.

## Build and publish

Install Node.js 22.12 or newer, Git, and the GitHub CLI. For publishing, sign in once with `gh auth login` using an account with write access to `NoobIsADev/Relay`.

```powershell
npm ci
npm start
npm run check
npm run dist
```

On Linux, run `npm run dist:linux` to build the AppImage locally.

Run `PUSH-AND-RELEASE.bat` on Windows from the repository’s `main` checkout. The first run uses the current version, and subsequent runs bump the patch version. It builds the Windows installer, pushes and tags the commit, and builds the AppImage from that tag on GitHub Actions. Once both builds are ready, it publishes them together with their updater manifests. Use `PUSH-AND-RELEASE.bat minor` for a minor release, `PUSH-AND-RELEASE.bat 1.2.3` to set a version, or `npm run release -- --dry-run` to check the destination and version.

Installed Windows copies and AppImages check GitHub Releases at startup and periodically. A downloaded release can be installed from the launcher, or it installs on normal exit. Keep the AppImage in a writable folder so Relay can replace it during an update. The Windows installer is unsigned.

If Linux reports that FUSE is unavailable, run the AppImage with `APPIMAGE_EXTRACT_AND_RUN=1` in the environment.

Relay stores its library under `%APPDATA%\Relay` on Windows and `${XDG_CONFIG_HOME:-$HOME/.config}/Relay` on Linux. Relay is an independent launcher and is unaffiliated with Mojang, Microsoft, and Modrinth.

## Artwork

The Relay mark comes from the supplied logo. The built-in ImageGen tool generated the voxel river background at `assets/river.jpg` using this prompt.

> Wide panoramic desktop game launcher hero artwork, stylized 3D voxel Minecraft-like landscape. A quiet pale-blue dawn above a glacier-blue winding river, blocky grassy cliffs and scattered spruce trees, detailed stepped stone, dramatic right-weighted composition, distant fog softly dissolving into negative space across the left third for a text overlay. Cool misty indigo foreground and brighter icy aqua highlights to the right. Cozy and exploratory, premium game key art, sharp geometry, no characters, no lettering, no logo, no UI, no watermark. A 3:1 wide crop through the middle must preserve the river and cliff. Also works as soft darkened small thumbnail.
