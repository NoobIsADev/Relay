const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const defaults = {
  theme: 'midnight', accent: '', sounds: true, volume: 45, toasts: true, ram: 4096, java: '', microsoftClientId: '',
  shared: { resourcepacks: false, shaderpacks: false }
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && arguments.length > 1) return fallback;
    throw error;
  }
}

async function writeAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function inside(root, relative) {
  const parts = String(relative).split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' ||
    /[\\:\x00-\x1f<>|?*"]|[ .]$|^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error('Unsafe file path in download.');
  }
  return path.join(root, ...parts);
}

function cleanVersion(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._+-]{0,100}$/i.test(value)) {
    throw new Error('Choose a valid Minecraft and loader version.');
  }
  return value;
}

async function openStore(root) {
  const file = path.join(root, 'library.json');
  const stored = await readJson(file, {});
  let state = {
    settings: { ...defaults, ...stored.settings, shared: { ...defaults.shared, ...stored.settings?.shared } },
    instances: stored.instances || [], account: stored.account || null,
    accounts: stored.accounts || (stored.account ? [stored.account] : []),
    activeAccountId: stored.activeAccountId || stored.account?.id || null,
    sharedContent: stored.sharedContent || [], sharingCommit: stored.sharingCommit || ''
  };
  let saving = Promise.resolve();
  return {
    get: () => state,
    async change(update) {
      const action = saving.catch(() => {}).then(async () => {
        const next = structuredClone(state);
        update(next);
        await writeAtomic(file, JSON.stringify(next, null, 2));
        state = next;
        return state;
      });
      saving = action;
      return action;
    },
    instance(id) {
      const item = state.instances.find(entry => entry.id === id);
      if (!item) throw new Error('This instance is no longer in your library.');
      return item;
    },
    dir(id) {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid instance.');
      return path.join(root, 'instances', id);
    }
  };
}

module.exports = { cleanVersion, defaults, inside, openStore, readJson, writeAtomic };
