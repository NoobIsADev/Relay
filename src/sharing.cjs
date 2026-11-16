const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { inside, readJson, writeAtomic } = require('./storage.cjs');

const sharedFolders = ['resourcepacks', 'shaderpacks'];

function folderOf(relative) {
  return relative.split('/')[0];
}

function isShared(settings, folder) {
  return sharedFolders.includes(folder) && settings.shared?.[folder] === true;
}

function contents(state, instance) {
  return [
    ...(instance.content || []).filter(entry => !isShared(state.settings, folderOf(entry.relative))),
    ...state.sharedContent.filter(entry => isShared(state.settings, folderOf(entry.relative)))
      .map(entry => ({ ...entry, shared: true }))
  ];
}

function relativeTo(root, filename) {
  return path.relative(root, filename).split(path.sep).join('/');
}

async function stat(file) {
  return fs.lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function remove(file, info) {
  if (info.isSymbolicLink()) await fs.unlink(file);
  else await fs.rm(file, { recursive: info.isDirectory() });
}

async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function sameFile(first, second, firstInfo, secondInfo) {
  return firstInfo.isFile() && secondInfo.isFile() && firstInfo.size === secondInfo.size &&
    await hash(first) === await hash(second);
}

async function copy(source, destination) {
  await fs.cp(source, destination, {
    recursive: true, errorOnExist: true, force: false,
    async filter(file) {
      const info = await fs.lstat(file);
      if (!info.isFile() && !info.isDirectory()) {
        throw new Error('Relay cannot share linked files or folders inside a pack. Move the link out of the pack folder and try again.');
      }
      return true;
    }
  });
}

function createSharing(root, store) {
  const sharedRoot = path.join(root, 'shared');
  const transfer = path.join(sharedRoot, '.relay-transfer');
  const journal = path.join(transfer, 'journal.json');

  function resolve(filename) {
    return inside(root, filename);
  }

  async function recover() {
    const plan = await readJson(journal, null);
    if (plan && plan.id !== store.get().sharingCommit) {
      for (const action of [...plan.steps].reverse()) {
        const destination = resolve(action.destination);
        const staged = resolve(action.staged);
        const backup = resolve(action.backup);
        const saved = await stat(backup);
        const replacement = await stat(destination);
        if (saved) {
          if (replacement) await remove(destination, replacement);
          await fs.rename(backup, destination);
        } else if (!action.hadPrevious && replacement && !await stat(staged)) {
          await remove(destination, replacement);
        }
      }
    }
    await fs.rm(transfer, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }

  async function transact(run) {
    await recover();
    const plan = { id: randomUUID(), steps: [] };
    await writeAtomic(journal, JSON.stringify(plan));
    let temporary = 0;
    const tmp = () => path.join(transfer, 'stage-' + temporary++);
    async function swap(destination, staged, previous) {
      const backup = tmp();
      plan.steps.push({
        destination: relativeTo(root, destination),
        staged: relativeTo(root, staged),
        backup: relativeTo(root, backup),
        hadPrevious: Boolean(previous)
      });
      await writeAtomic(journal, JSON.stringify(plan));
      if (previous) await fs.rename(destination, backup);
      if (await stat(destination)) throw new Error('A pack folder changed during the transfer. Try again.');
      await fs.rename(staged, destination);
    }
    try {
      const apply = await run(tmp, swap);
      await store.change(data => {
        apply(data);
        data.sharingCommit = plan.id;
      });
    } catch (error) {
      await recover();
      throw error;
    }
    await recover().catch(error => console.warn('Could not clean up committed shared folder backups:', error.code));
  }

  async function importContents(local, shared, tmp, swap) {
    const renamed = new Map();
    const names = new Map((await fs.readdir(shared)).map(name => [name.toLowerCase(), name]));
    for (const name of await fs.readdir(local)) {
      const original = inside(local, name);
      const info = await fs.lstat(original);
      if (!info.isFile() && !info.isDirectory()) throw new Error('Relay cannot combine a pack folder that contains links.');
      const parsed = path.parse(name);
      let target = name;
      let suffix = 2;
      while (names.has(target.toLowerCase())) {
        const existing = names.get(target.toLowerCase());
        const existingPath = inside(shared, existing);
        if (await sameFile(original, existingPath, info, await fs.lstat(existingPath))) {
          target = existing;
          break;
        }
        target = parsed.name + ' (' + suffix++ + ')' + parsed.ext;
      }
      if (!names.has(target.toLowerCase())) {
        const staged = tmp();
        await copy(original, staged);
        await swap(inside(shared, target), staged, false);
        names.set(target.toLowerCase(), target);
      }
      renamed.set(name.toLowerCase(), target);
    }
    return renamed;
  }

  async function switchFolder(instance, folder, enable, tmp, swap) {
    const base = store.dir(instance.id);
    const local = path.join(base, folder);
    const shared = path.join(sharedRoot, folder);
    await fs.mkdir(base, { recursive: true });
    await fs.mkdir(shared, { recursive: true });
    const common = await fs.lstat(shared);
    if (!common.isDirectory() || common.isSymbolicLink()) throw new Error('Relay needs a regular shared ' + folder + ' folder.');

    const previous = await stat(local);
    const linked = previous?.isSymbolicLink();
    if (linked) {
      const currentTarget = await fs.realpath(local).catch(() => '');
      if (currentTarget.toLowerCase() !== (await fs.realpath(shared)).toLowerCase()) {
        throw new Error(instance.name + ' uses its own link for ' + folder + '. Move that link before changing Relay sharing.');
      }
    } else if (previous && !previous.isDirectory()) {
      throw new Error(instance.name + ' has a file where the ' + folder + ' folder should be.');
    }

    if (enable && linked) {
      return new Map((await fs.readdir(shared)).map(name => [name.toLowerCase(), name]));
    }
    if (!enable && previous && !linked) {
      throw new Error(instance.name + ' already has a separate ' + folder + ' folder. Move it before separating shared files.');
    }

    const renamed = enable && previous ? await importContents(local, shared, tmp, swap) : new Map();
    const staged = tmp();
    if (enable) await fs.symlink(shared, staged, 'junction');
    else await copy(shared, staged);
    await swap(local, staged, previous);
    return renamed;
  }

  function mergeMetadata(instance, folder, renamed, entries) {
    for (const entry of instance.content || []) {
      if (folderOf(entry.relative) !== folder) continue;
      const target = renamed.get(path.posix.basename(entry.relative).toLowerCase());
      if (target && !entries.some(existing => existing.project === entry.project)) {
        entries.push({ ...entry, relative: folder + '/' + target });
      }
    }
  }

  async function saveSettings(settings) {
    const snapshot = store.get();
    const changing = sharedFolders.filter(folder => isShared(settings, folder) !== isShared(snapshot.settings, folder));
    if (!changing.length) return store.change(data => { data.settings = settings; });

    await transact(async (tmp, swap) => {
      const changes = [];
      for (const folder of changing) {
        const enable = isShared(settings, folder);
        const entries = enable ? [] : snapshot.sharedContent.filter(entry => folderOf(entry.relative) === folder);
        for (const instance of snapshot.instances) {
          const renamed = await switchFolder(instance, folder, enable, tmp, swap);
          if (enable) mergeMetadata(instance, folder, renamed, entries);
        }
        changes.push({ folder, enable, entries });
      }
      return data => {
        for (const { folder, enable, entries } of changes) {
          data.sharedContent = data.sharedContent.filter(entry => folderOf(entry.relative) !== folder);
          if (enable) data.sharedContent.push(...entries);
          for (const instance of data.instances) {
            instance.content = (instance.content || []).filter(entry => folderOf(entry.relative) !== folder);
            if (!enable) instance.content.push(...entries);
          }
        }
        data.settings = settings;
      };
    });
  }

  async function add(instance) {
    const enabled = sharedFolders.filter(folder => isShared(store.get().settings, folder));
    const register = data => { data.instances.unshift(instance); };
    if (!enabled.length) return store.change(register);
    await transact(async (tmp, swap) => {
      for (const folder of enabled) await switchFolder(instance, folder, true, tmp, swap);
      return register;
    });
  }

  function file(instance, relative) {
    if (isShared(store.get().settings, folderOf(relative))) return inside(sharedRoot, relative);
    return inside(store.dir(instance.id), relative);
  }

  return { recover, saveSettings, add, file, root: sharedRoot };
}

module.exports = { contents, createSharing, folderOf, isShared, sharedFolders };
