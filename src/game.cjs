const path = require('node:path');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { spawn } = require('node:child_process');
const { MinecraftFolder, Version, launch } = require('@xmcl/core');
const installer = require('@xmcl/installer');
const { cleanVersion, readJson, writeAtomic } = require('./storage.cjs');
const { getJson } = require('./network.cjs');

const loaderNames = {
  vanilla: 'Vanilla', fabric: 'Fabric', legacyfabric: 'Legacy Fabric',
  forge: 'Forge', liteloader: 'LiteLoader', quilt: 'Quilt', neoforge: 'NeoForge'
};
const loaderMeta = {
  fabric: 'https://meta.fabricmc.net/v2/versions',
  legacyfabric: 'https://meta.legacyfabric.net/v2/versions',
  quilt: 'https://meta.quiltmc.org/v3/versions'
};
const liteMeta = 'https://meta.prismlauncher.org/v1/com.mumfrey.liteloader';
const cache = 600000;
const runtimePlatforms = {
  win32: { x64: 'windows-x64', ia32: 'windows-x86', arm64: 'windows-arm64' },
  linux: { x64: 'linux', ia32: 'linux-i386', arm64: 'linux-arm64' }
};

async function titles() {
  return getJson(installer.DEFAULT_VERSION_MANIFEST_URL, { cache });
}

async function forgeVersions(minecraft) {
  try {
    return (await installer.getForgeVersionList({ minecraft, signal: AbortSignal.timeout(25000) })).versions
      .filter(item => item.mcversion === minecraft && (item.installer || item.universal));
  } catch (error) {
    if (/404/.test(error.message)) return [];
    throw error;
  }
}

async function loaders(loader, minecraft) {
  cleanVersion(minecraft);
  if (!Object.hasOwn(loaderNames, loader)) throw new Error('Unknown mod loader.');
  if (loader === 'vanilla') return [];
  if (loader === 'forge') {
    const list = await forgeVersions(minecraft);
    return list.map(item => ({ id: item.version, stable: item.type !== 'buggy', recommended: item.type === 'recommended' }));
  }
  if (loader === 'liteloader') {
    const { versions } = await getJson(liteMeta + '/index.json', { cache });
    return versions.filter(item => item.requires?.some(dependency => dependency.uid === 'net.minecraft' && dependency.equals === minecraft))
      .map(item => ({ id: item.version, stable: item.type === 'release', recommended: item.recommended }));
  }
  if (loader === 'neoforge') return [];
  try {
    const list = await getJson(loaderMeta[loader] + '/loader/' + encodeURIComponent(minecraft), { cache });
    return list.map(({ loader: item }) => ({ id: item.version, stable: item.stable ?? !item.version.includes('-') }));
  } catch (error) {
    if (error.status === 404 || error.status === 400) return [];
    throw error;
  }
}

function javaMajor(java) {
  return new Promise((resolve, reject) => {
    const child = spawn(java, ['-version'], { windowsHide: true, timeout: 5000 });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      const version = /version "(?:1\.)?(\d+)/.exec(output);
      if (!version || code !== 0) return reject(new Error('Java executable did not report its version.'));
      resolve(Number(version[1]));
    });
  });
}

function createGame(root, store, send) {
  const folder = MinecraftFolder.from(path.join(root, 'game'));
  let job;
  const games = new Map();

  async function prepare(item, force = false) {
    const progress = message => send({ type: 'progress', id: item.id, message });
    const nativeRuntime = installer.createDefaultNodeInstallRuntime({ maxConcurrency: 18 });
    const execute = plan => installer.executeInstallManifest(plan, nativeRuntime).catch(error => {
      const failed = error.errors?.[0];
      if (failed?.destination) throw new Error('Could not download ' + path.basename(failed.destination) + '. Try installing again.');
      if (!error.message) throw new Error('Required game files could not be installed.');
      throw error;
    });
    const workflow = plan => installer.runInstallWorkflow(plan, execute);
    const files = (id, entries) => execute({
      schemaVersion: 1, tasks: [{ id, type: 'files', files: entries.filter(Boolean) }]
    });

    progress('Checking Minecraft ' + item.minecraft);
    const record = (await titles()).versions.find(version => version.id === item.minecraft);
    if (!record) throw new Error('Minecraft version is unavailable.');
    const versionFile = installer.resolveMinecraftVersionJsonInstallFile(record, folder);
    versionFile.replace = force;
    if (record.sha1) versionFile.checksum = { algorithm: 'sha1', value: record.sha1 };
    await files('minecraft-version', [versionFile]);
    const vanilla = await Version.parse(folder, item.minecraft);
    const meta = await readJson(versionFile.path);
    const requirement = meta.javaVersion || { majorVersion: 8, component: 'jre-legacy' };
    const alternate = item.java || store.get().settings.java;
    let java = alternate;
    if (java) {
      const major = await javaMajor(java).catch(() => { throw new Error('Relay could not open the custom Java executable.'); });
      if (major !== requirement.majorVersion) throw new Error('Minecraft ' + item.minecraft + ' requires Java ' + requirement.majorVersion + '. Choose a matching executable or clear the custom path.');
    } else {
      progress('Checking Java ' + requirement.majorVersion);
      const platform = runtimePlatforms[process.platform]?.[process.arch];
      const index = await getJson(installer.DEFAULT_RUNTIME_ALL_URL, { cache });
      const target = (index[platform]?.[requirement.component] || [])[0];
      if (!target) throw new Error('A managed Java runtime is unavailable. Choose a Java ' + requirement.majorVersion + ' executable in Settings.');
      const destination = path.join(root, 'java', requirement.component, cleanVersion(target.version.name));
      java = path.join(destination, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (force || !await fs.access(java, constants.X_OK).then(() => true, () => false)) {
        await workflow(installer.createJavaRuntimeInstallWorkflow({ target, destination }));
      }
    }

    progress('Checking Minecraft client and libraries');
    await files('vanilla-client', [
      installer.resolveMinecraftJarInstallFile(vanilla),
      ...installer.resolveLibraryInstallFiles(vanilla.libraries, folder),
      ...installer.resolveAssetMetadataInstallFiles(vanilla, folder)
    ]);
    let id = item.minecraft;
    if (item.loader !== 'vanilla') {
      progress('Installing ' + loaderNames[item.loader] + ' ' + item.loaderVersion);
      id = 'relay-' + item.loader + '-' + item.minecraft + '-' + item.loaderVersion;
      const output = folder.getVersionJson(id);
      if (loaderMeta[item.loader]) {
        const profile = await getJson(loaderMeta[item.loader] + '/loader/' +
          encodeURIComponent(item.minecraft) + '/' + encodeURIComponent(item.loaderVersion) + '/profile/json', { cache });
        if (profile.inheritsFrom !== item.minecraft) throw new Error('The loader returned a profile for a different Minecraft version.');
        await writeAtomic(output, JSON.stringify({ ...profile, id }));
      } else if (item.loader === 'liteloader') {
        const profile = await getJson(liteMeta + '/' + encodeURIComponent(item.loaderVersion) + '.json', { cache });
        if (!profile.requires?.some(dep => dep.uid === 'net.minecraft' && dep.equals === item.minecraft)) {
          throw new Error('This LiteLoader build is incompatible with Minecraft ' + item.minecraft + '.');
        }
        const libraries = profile.libraries.map(lib => {
          const url = lib.name.startsWith('org.ow2.asm:') ? 'https://repo.maven.apache.org/maven2/' :
            lib.url?.replace(/^http:\/\//, 'https://');
          return url ? { name: lib.name, url } : { name: lib.name };
        });
        const args = profile['+tweakers'].map(name => ' --tweakClass ' + name).join('');
        await writeAtomic(output, JSON.stringify({
          id, inheritsFrom: item.minecraft, libraries, mainClass: profile.mainClass,
          minecraftArguments: meta.minecraftArguments + args, type: 'release'
        }));
      } else {
        const hasProfile = !force && await fs.access(output).then(() => true, () => false);
        if (!hasProfile) {
          const opts = { versionId: id, inheritsFrom: item.minecraft, java, side: 'client' };
          if (item.loader === 'neoforge') {
            const { file, source } = await installer.resolveNeoForgedInstallerFile('neoforge', item.loaderVersion, folder, opts);
            const result = await workflow(installer.createModernForgeInstallWorkflow({
              id, minecraft: folder, minecraftVersion: item.minecraft, installer: file,
              artifactVersion: source, java, installOptions: opts
            }));
            id = result.version;
          } else {
            const build = (await forgeVersions(item.minecraft)).find(entry => entry.version === item.loaderVersion);
            if (!build) throw new Error('This Forge version is unavailable.');
            const artifact = installer.resolveForgeArtifactVersion(item.minecraft, item.loaderVersion);
            const { file } = installer.resolveForgeInstallerFile(artifact, build.installer || build.universal, folder, opts, !build.installer);
            if (build.installer) {
              const result = await workflow(installer.createModernForgeInstallWorkflow({
                id, minecraft: folder, minecraftVersion: item.minecraft, installer: file,
                artifactVersion: artifact, java, installOptions: opts
              }));
              id = result.version;
            } else {
              id = await workflow(installer.createLegacyForgeInstallWorkflow({
                id, minecraft: folder, minecraftVersion: item.minecraft, universal: file, artifactVersion: artifact, installOptions: opts
              }));
            }
          }
        }
      }
    }

    progress('Checking game assets and loader libraries');
    const resolved = id === item.minecraft ? vanilla : await Version.parse(folder, id);
    const libraryOptions = {
      libraryHost: library => library.download.path.includes('+legacyfabric.') ?
        new URL(library.download.path, 'https://maven.legacyfabric.net/').href : undefined
    };
    await files('game-files', [
      ...installer.resolveLibraryInstallFiles(resolved.libraries, folder, libraryOptions),
      ...await installer.resolveAssetObjectInstallFiles(vanilla, folder)
    ]);
    await store.change(state => {
      const saved = state.instances.find(entry => entry.id === item.id);
      saved.installed = id;
    });
    return { java, version: resolved };
  }

  async function perform(id, session, repair = false) {
    if (job) throw new Error('Relay is preparing another instance.');
    if (games.has(id)) throw new Error('This instance is already running.');
    const item = store.instance(id);
    job = id;
    try {
      await fs.mkdir(store.dir(id), { recursive: true });
      const { java, version } = await prepare(item, repair);
      if (!session) return;
      send({ type: 'progress', id, message: 'Starting Minecraft' });
      const child = await launch({
        gamePath: store.dir(id), resourcePath: folder.root, javaPath: java, version,
        gameProfile: session.account, accessToken: session.token, userType: 'msa',
        launcherName: 'Relay', launcherBrand: 'Relay', minMemory: 512,
        maxMemory: item.ram || store.get().settings.ram
      });
      games.set(id, child);
      const recent = [];
      const log = chunk => {
        const safe = String(chunk).replaceAll(session.token, '[redacted]');
        recent.push(safe);
        if (recent.length > 100) recent.shift();
      };
      child.stdout?.on('data', log);
      child.stderr?.on('data', log);
      let failure;
      child.once('error', error => { failure = error.message; log(failure); });
      child.once('close', code => {
        games.delete(id);
        writeAtomic(path.join(store.dir(id), 'relay-last-run.log'), recent.join('')).catch(() => {});
        send({ type: 'game-exit', id, code, error: failure, name: item.name });
      });
      await store.change(state => {
        state.instances.find(entry => entry.id === id).lastPlayed = Date.now();
      });
      send({ type: 'game-start', id, name: item.name });
    } finally {
      job = undefined;
      send({ type: 'progress', id, message: '' });
    }
  }

  return {
    perform,
    busy: id => job === id || games.has(id),
    running: () => [...games.keys()],
    stop(id) {
      if (!games.get(id)?.kill()) throw new Error('Minecraft is not running for this instance.');
    }
  };
}

module.exports = { createGame, loaders, loaderNames, titles };
