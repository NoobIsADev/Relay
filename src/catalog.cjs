const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const yauzl = require('yauzl');
const { cleanVersion, inside } = require('./storage.cjs');
const { download, getJson } = require('./network.cjs');
const { contents, folderOf, isShared } = require('./sharing.cjs');

const api = 'https://api.modrinth.com/v2';
const types = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', modpack: '' };
const modrinthHosts = ['cdn.modrinth.com'];
const packHosts = [...modrinthHosts, 'github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com',
  'release-assets.githubusercontent.com', 'gitlab.com'];
const loaders = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };

function key(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(value)) throw new Error('Invalid Modrinth project or version.');
  return value;
}
function json(route, params = {}) {
  return getJson(api + route + '?' + new URLSearchParams(params), { cache: 60000 });
}
function options(item, type) {
  if (!item || type === 'modpack') return {};
  const result = { game_versions: JSON.stringify([item.minecraft]) };
  if (type === 'mod') {
    const loader = item.loader === 'legacyfabric' ? 'fabric' : item.loader;
    if (loader === 'vanilla') return null;
    result.loaders = JSON.stringify([loader]);
  }
  return result;
}

function search({ query = '', type = 'mod', index = 'downloads', offset = 0, item }) {
  if (!Object.hasOwn(types, type)) throw new Error('Unknown content type.');
  const filters = options(item, type);
  if (!filters) return { hits: [], total_hits: 0 };
  const facets = [['project_type:' + type]];
  if (filters.game_versions) facets.push(JSON.parse(filters.game_versions).map(v => 'versions:' + v));
  if (filters.loaders) facets.push(JSON.parse(filters.loaders).map(v => 'categories:' + v));
  return json('/search', {
    query: String(query).slice(0, 140), facets: JSON.stringify(facets), limit: 18,
    index: ['downloads', 'relevance', 'follows', 'newest', 'updated'].includes(index) ? index : 'downloads',
    offset: Math.max(0, Math.min(Number(offset) || 0, 5000))
  });
}

async function details(slug, item) {
  const project = await json('/project/' + key(slug));
  return { project, versions: await versionsFor(project, item) };
}

function versionsFor(project, item) {
  const filters = options(item, project.project_type);
  return filters ? json('/project/' + key(project.id) + '/version', filters) : [];
}

function preferredVersion(versions) {
  return versions.find(version => version.version_type === 'release') || versions[0];
}

function primary(version) {
  const file = version.files.find(file => file.primary) || version.files[0];
  if (!file?.url || !file.hashes?.sha512 || !Number.isSafeInteger(file.size)) {
    throw new Error('Modrinth did not provide a verified download.');
  }
  return file;
}

function zipOpen(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}
function entryStream(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}

async function visitZip(file, visit) {
  const zip = await zipOpen(file);
  try {
    await new Promise((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', entry => Promise.resolve(visit(zip, entry)).then(() => zip.readEntry(), reject));
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

async function parallel(items, limit, task) {
  let cursor = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (!failure && cursor < items.length) {
      const item = items[cursor++];
      try {
        await task(item);
      } catch (error) {
        failure = error;
      }
    }
  }));
  if (failure) throw failure;
}

function pool(limit) {
  let active = 0;
  const waiting = [];
  return async task => {
    if (active < limit) active++;
    else await new Promise(resolve => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function createCatalog(root, store, send, sharing) {
  const jobs = new Map();
  const workOnInstall = pool(4);
  const downloadFile = pool(12);
  const commit = pool(1);
  const fetchFile = (...args) => downloadFile(() => download(...args));

  async function installPack(project, version, pickedFile, progress) {
    if (!pickedFile.filename.endsWith('.mrpack')) throw new Error('This version does not have a .mrpack download.');
    const id = randomUUID();
    const work = path.join(root, 'downloads', id);
    const game = path.join(work, 'game');
    const archive = path.join(work, 'download.mrpack');
    const dest = store.dir(id);
    let moved = false;
    try {
      progress('Downloading ' + project.title);
      await fetchFile(pickedFile.url, archive, { hosts: modrinthHosts, size: pickedFile.size, hashes: pickedFile.hashes });
      let manifest;
      await visitZip(archive, async (zip, entry) => {
        if (entry.fileName !== 'modrinth.index.json') return;
        if (manifest || entry.uncompressedSize > 10 * 1024 ** 2) throw new Error('Invalid modpack index.');
        const chunks = [];
        for await (const chunk of await entryStream(zip, entry)) chunks.push(chunk);
        manifest = JSON.parse(Buffer.concat(chunks));
      });
      if (manifest?.formatVersion !== 1 || manifest.game !== 'minecraft' ||
          !Array.isArray(manifest.files) || manifest.files.length > 10000) throw new Error('This modpack format is unsupported.');
      const gameVersion = cleanVersion(manifest.dependencies?.minecraft);
      const dependencies = Object.entries(manifest.dependencies).filter(([name]) => name !== 'minecraft');
      if (dependencies.length > 1 || dependencies.some(([name]) => !Object.hasOwn(loaders, name))) {
        throw new Error('This modpack requires an unsupported loader combination.');
      }
      const loader = dependencies.length ? loaders[dependencies[0][0]] : 'vanilla';
      const loaderVersion = dependencies.length ? cleanVersion(dependencies[0][1]) : '';
      const paths = new Set();
      const files = manifest.files.filter(file => file.env?.client !== 'unsupported');
      let total = 0;
      for (const file of files) {
        const filename = inside(game, file.path).toLowerCase();
        if (paths.has(filename) || !file.hashes?.sha512 || !Array.isArray(file.downloads) || file.downloads.length > 10 ||
            !Number.isSafeInteger(file.fileSize) || file.fileSize < 0) throw new Error('Invalid modpack file entry.');
        total += file.fileSize;
        if (total > 12 * 1024 ** 3) throw new Error('Modpack exceeds the installation size limit.');
        paths.add(filename);
      }
      let completed = 0;
      progress('Downloading ' + files.length + ' modpack files');
      await fs.mkdir(game, { recursive: true });
      await parallel(files, 10, async file => {
        let lastError = new Error('Missing modpack download source.');
        for (const url of file.downloads) {
          try {
            await fetchFile(url, inside(game, file.path), { hosts: packHosts, size: file.fileSize, hashes: file.hashes });
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (lastError) throw new Error('Could not install ' + file.path + '. ' + lastError.message);
        completed++;
        if (completed % 5 === 0 || completed === files.length) progress('Modpack files ' + completed + ' / ' + files.length);
      });
      let expanded = 0;
      for (const prefix of ['overrides/', 'client-overrides/']) {
        await visitZip(archive, async (zip, entry) => {
          if (!entry.fileName.startsWith(prefix) || entry.fileName.endsWith('/')) return;
          expanded += entry.uncompressedSize;
          const attributes = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (attributes === 0xa000 || expanded > 4 * 1024 ** 3) throw new Error('Invalid modpack override.');
          const target = inside(game, entry.fileName.slice(prefix.length));
          await fs.mkdir(path.dirname(target), { recursive: true });
          await pipeline(await entryStream(zip, entry), createWriteStream(target));
        });
      }
      const item = {
        id, name: String(manifest.name || project.title).slice(0, 64), minecraft: gameVersion, loader, loaderVersion,
        accent: '', icon: project.icon_url || '', cover: project.gallery?.find(image => image.featured)?.url || '',
        ram: 0, java: '', created: Date.now(), lastPlayed: 0,
        modpack: { project: project.id, version: version.id }, content: []
      };
      return await commit(async () => {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(game, dest);
        moved = true;
        await sharing.add(item);
        moved = false;
        return item;
      });
    } finally {
      await fs.rm(work, { recursive: true, force: true });
      if (moved) await fs.rm(dest, { recursive: true, force: true });
    }
  }

  async function installProject(project, version, item, progress) {
    const plans = new Map();
    const visited = new Set();

    async function plan(current, release, compatible) {
      if (visited.has(current.id)) {
        if (compatible?.size === 1 && plans.has(current.id) && plans.get(current.id).version !== release.id) {
          throw new Error('Two dependencies require different versions of ' + current.title + '.');
        }
        return;
      }
      if (visited.size >= 45) throw new Error('Too many Modrinth dependencies.');
      visited.add(current.id);
      const type = current.project_type;
      const filters = options(item, type);
      const acceptable = filters && release.game_versions.includes(item.minecraft) &&
        (!filters.loaders || JSON.parse(filters.loaders).some(loader => release.loaders.includes(loader)));
      if (!acceptable || release.project_id !== current.id || !types[type]) {
        throw new Error(current.title + ' does not support this Minecraft and loader combination.');
      }
      for (const dependency of release.dependencies || []) {
        if (dependency.dependency_type !== 'required') continue;
        const pinned = dependency.version_id ? await json('/version/' + key(dependency.version_id)) : null;
        const depId = pinned?.project_id || dependency.project_id;
        if (!depId) throw new Error('Missing required file ' + (dependency.file_name || 'listed by ' + current.title) + '.');
        const { project: dep, versions } = await details(depId, item);
        if (!pinned && !versions.length) throw new Error('No compatible version of ' + dep.title + ' is available.');
        await plan(dep, pinned || preferredVersion(versions), new Set(pinned ? [pinned.id] : versions.map(entry => entry.id)));
      }
      const file = primary(release);
      const relative = types[type] + '/' + file.filename;
      if (/[\\/]/.test(file.filename) || !/\.(jar|zip|litemod)$/i.test(file.filename)) throw new Error('Unsupported Modrinth filename.');
      if ([...plans.values()].some(entry => entry.relative.toLowerCase() === relative.toLowerCase())) {
        throw new Error('Two projects use the same filename.');
      }
      plans.set(current.id, { project: current.id, name: current.title, version: release.id, versionName: release.version_number, icon: current.icon_url || '', relative, compatible, file });
    }

    await plan(project, version);
    const pending = [...plans.values()];
    const staged = path.join(root, 'downloads', randomUUID());
    try {
      await fs.mkdir(staged, { recursive: true });
      let downloaded = 0;
      progress('Downloading files');
      await parallel(pending, 4, async entry => {
        entry.temp = path.join(staged, 'new-' + entry.project);
        await fetchFile(entry.file.url, entry.temp, { hosts: modrinthHosts, size: entry.file.size, hashes: entry.file.hashes });
        progress('Downloaded ' + ++downloaded + ' / ' + pending.length + ' files');
      });
      return await commit(() => commitProject(project, item, pending, staged, progress));
    } finally {
      await fs.rm(staged, { recursive: true, force: true });
    }
  }

  async function commitProject(project, item, pending, staged, progress) {
    const currentItem = store.instance(item.id);
    const currentContent = contents(store.get(), currentItem);
    const replace = [];
    const changed = [];
    progress('Installing files');
    try {
      for (const [index, entry] of pending.entries()) {
        const output = sharing.file(currentItem, entry.relative);
        const existing = currentContent.find(previous => previous.project === entry.project);
        const old = existing ? sharing.file(currentItem, existing.relative) : output;
        if (existing && (entry.version === existing.version || entry.compatible?.has(existing.version)) &&
            await fs.access(old).then(() => true, () => false)) continue;
        if (existing && entry.compatible && !entry.compatible.has(existing.version)) {
          throw new Error(project.title + ' requires a different version of ' + entry.name + '. Change that dependency first.');
        }
        if (currentContent.some(other => other.project !== entry.project &&
            other.relative.toLowerCase() === entry.relative.toLowerCase())) {
          throw new Error('Two projects use the same filename.');
        }
        const backup = path.join(staged, 'previous-' + index);
        await fs.mkdir(path.dirname(output), { recursive: true });
        const exists = await fs.access(output).then(() => true, () => false);
        if (exists && (!existing || old.toLowerCase() !== output.toLowerCase())) {
          throw new Error('A file named ' + path.basename(output) + ' already exists in the destination folder.');
        }
        const hadOld = await fs.rename(old, backup).then(() => true, error => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
        const replacement = { old, backup, output, hadOld, placed: false };
        replace.push(replacement);
        await fs.rename(entry.temp, output);
        replacement.placed = true;
        changed.push(entry);
      }
      const changedProjects = new Set(changed.map(entry => entry.project));
      await store.change(state => {
        const target = state.instances.find(value => value.id === item.id);
        target.content = (target.content || []).filter(entry => !changedProjects.has(entry.project));
        state.sharedContent = state.sharedContent.filter(entry => !changedProjects.has(entry.project));
        for (const { project, name, version, versionName, icon, relative } of changed) {
          const list = isShared(state.settings, folderOf(relative)) ? state.sharedContent : target.content;
          list.push({ project, name, version, versionName, icon, relative });
        }
      });
      return { name: project.title, total: changed.length };
    } catch (error) {
      for (const swap of replace.reverse()) {
        if (swap.placed) await fs.rm(swap.output, { force: true });
        if (swap.hadOld) await fs.rename(swap.backup, swap.old);
      }
      if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
        throw new Error('Relay could not replace a file in use. Close the game and try this update again.');
      }
      throw error;
    }
  }

  async function install(slug, versionId, item) {
    const projectKey = key(slug);
    const id = (item?.id || '') + '/' + projectKey;
    if (jobs.has(id)) throw new Error('This project is already downloading for this instance.');
    const job = { id, project: projectKey, instance: item?.id || '', title: '', message: '' };
    const progress = message => {
      job.message = message;
      send({ type: 'catalog-progress', job: { ...job } });
    };
    jobs.set(id, job);
    progress('Waiting to download');
    try {
      return await workOnInstall(async () => {
        progress('Finding a compatible version');
        const project = await json('/project/' + projectKey);
        job.title = project.title;
        const version = versionId ? await json('/version/' + key(versionId)) : preferredVersion(await versionsFor(project, item));
        if (!version) throw new Error('No compatible version is available for this instance.');
        if (version.project_id !== project.id) throw new Error('This version belongs to another Modrinth project.');
        if (project.project_type === 'modpack') return installPack(project, version, primary(version), progress);
        if (!item) throw new Error('Choose an instance to install into.');
        return installProject(project, version, item, progress);
      });
    } finally {
      jobs.delete(id);
      send({ type: 'catalog-progress', job: { ...job }, finished: true });
    }
  }

  return { install, commit, active: () => [...jobs.values()].map(job => ({ ...job })), busy: () => jobs.size > 0 };
}

module.exports = { createCatalog, details, search };
