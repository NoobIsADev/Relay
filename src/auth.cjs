const path = require('node:path');
const fs = require('node:fs/promises');
const { Authflow } = require('prismarine-auth');
const { safeStorage, shell } = require('electron');
const { writeAtomic } = require('./storage.cjs');

const profileId = /^[a-f0-9]{32}$/i;

function createAuth(root, store, send) {
  const directory = path.join(root, 'accounts');
  const legacyFile = path.join(root, 'microsoft.bin');
  const sessions = new Map();
  let running = false;
  let currentCode;
  let sessionSelection = null;

  function canPersist() {
    return safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  }

  function accounts() {
    const available = new Map(canPersist() ? store.get().accounts.map(profile => [profile.id, profile]) : []);
    for (const { profile } of sessions.values()) available.set(profile.id, profile);
    return [...available.values()];
  }

  function account() {
    const selected = sessionSelection || (canPersist() ? store.get().activeAccountId : null);
    const available = accounts();
    return available.find(profile => profile.id === selected) || available[0] || null;
  }

  function file(id) {
    if (!profileId.test(id)) throw new Error('Invalid Minecraft profile.');
    return path.join(directory, id + '.bin');
  }

  async function readEncrypted(filename) {
    const blob = await fs.readFile(filename).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return blob ? JSON.parse(safeStorage.decryptString(blob)) : null;
  }

  function persist(id, entry) {
    return writeAtomic(file(id), safeStorage.encryptString(JSON.stringify(entry)));
  }

  async function migrate() {
    const previous = store.get().account;
    if (!previous || !profileId.test(previous.id) || !canPersist()) return;
    // Leave the old cache available if the desktop keyring is temporarily locked.
    const legacy = await readEncrypted(legacyFile).catch(() => undefined);
    if (legacy === undefined) return;
    if (legacy && !await fs.access(file(previous.id)).then(() => true, () => false)) {
      await persist(previous.id, { clientId: store.get().settings.microsoftClientId, cache: legacy });
    }
    await store.change(state => { state.account = null; });
    await fs.rm(legacyFile, { force: true });
  }

  async function openCode() {
    if (!currentCode || currentCode.expiresAt <= Date.now()) throw new Error('Start a new Microsoft sign-in.');
    await shell.openExternal(currentCode.url);
  }

  function ensureIdle() {
    if (running) throw new Error('Finish the current Microsoft account operation first.');
  }

  async function operation(work) {
    ensureIdle();
    running = true;
    try {
      return await work();
    } finally {
      currentCode = undefined;
      running = false;
    }
  }

  async function authenticate(entry, interactive) {
    const cacheFactory = ({ cacheName }) => ({
      getCached: async () => entry.cache[cacheName] || {},
      setCached: async value => { entry.cache[cacheName] = value; },
      setCachedPartial: async value => { entry.cache[cacheName] = { ...entry.cache[cacheName], ...value }; },
      reset: async () => { delete entry.cache[cacheName]; return {}; }
    });
    const options = entry.clientId ? { flow: 'msal', authTitle: entry.clientId } : undefined;
    const flow = new Authflow('relay-account', cacheFactory, options, response => {
      if (!interactive) throw new Error('Interactive sign-in required.');
      const userCode = response.user_code || response.userCode;
      const candidate = new URL(response.verification_uri || response.verificationUri || 'https://www.microsoft.com/link');
      const safe = candidate.protocol === 'https:' && ['www.microsoft.com', 'microsoft.com', 'login.live.com', 'aka.ms', 'login.microsoftonline.com'].includes(candidate.hostname);
      const url = safe ? candidate : new URL('https://www.microsoft.com/link');
      if (url.pathname === '/link' && userCode) url.searchParams.set('otc', userCode);
      currentCode = { userCode, url: url.href, expiresAt: Date.now() + 1000 * (response.expires_in || 900) };
      send({ type: 'auth-code', ...currentCode });
      openCode().catch(() => {});
    });
    let session;
    try {
      session = await flow.getMinecraftJavaToken({ fetchProfile: true, fetchEntitlements: true });
    } catch (error) {
      if (!interactive) throw new Error('Sign in again to refresh your Microsoft session.');
      if (/403|forbidden/i.test(error.message)) {
        throw new Error('Xbox or Minecraft Services rejected this sign-in. Try again or use an approved application ID in Settings.');
      }
      if (/expired|denied|cancel/i.test(error.message)) throw new Error('Microsoft sign-in expired or was declined. Start a new sign-in.');
      throw new Error('Microsoft sign-in could not finish. Check your connection and try again.');
    }
    if (!session.token || !profileId.test(session.profile?.id || '') || !session.profile?.name) {
      throw new Error('Minecraft Java Edition did not return a player profile. Check that this Microsoft account owns the game and has set a Java username.');
    }
    return { account: { id: session.profile.id.toLowerCase(), name: session.profile.name }, token: session.token };
  }

  async function remember(profile, entry, select = false) {
    if (canPersist()) {
      await persist(profile.id, entry);
      const saved = store.get().accounts.find(existing => existing.id === profile.id);
      if (!saved || saved.name !== profile.name || (select && store.get().activeAccountId !== profile.id)) {
        await store.change(state => {
          if (saved) state.accounts = state.accounts.map(item => item.id === profile.id ? profile : item);
          else state.accounts.push(profile);
          if (select) state.activeAccountId = profile.id;
        });
      }
    }
    sessions.set(profile.id, { profile, entry });
    if (select) sessionSelection = profile.id;
  }

  function signIn(expectedId) {
    return operation(async () => {
      if (expectedId && !accounts().some(profile => profile.id === expectedId)) throw new Error('This account is no longer saved.');
      const entry = { clientId: store.get().settings.microsoftClientId, cache: {} };
      const result = await authenticate(entry, true);
      if (expectedId && result.account.id !== expectedId) {
        throw new Error('Microsoft returned a different account. Use Add account to save it separately.');
      }
      await remember(result.account, entry, true);
      return result.account;
    });
  }

  function login() {
    return operation(async () => {
      const profile = account();
      if (!profile) throw new Error('Sign in with Microsoft before launching Minecraft.');
      let entry = sessions.get(profile.id)?.entry;
      if (!entry && canPersist()) entry = await readEncrypted(file(profile.id)).catch(() => null);
      if (!entry || entry.clientId !== store.get().settings.microsoftClientId) {
        throw new Error('Sign in again to refresh your Microsoft session.');
      }
      const before = JSON.stringify(entry.cache);
      let result;
      try {
        result = await authenticate(entry, false);
      } catch (error) {
        // A token refresh may have succeeded before Minecraft Services returned an error.
        if (canPersist() && JSON.stringify(entry.cache) !== before) await persist(profile.id, entry);
        throw error;
      }
      if (result.account.id !== profile.id) throw new Error('Microsoft returned a different account. Sign in again from the account menu.');
      if (JSON.stringify(entry.cache) !== before || result.account.name !== profile.name) {
        await remember(result.account, entry);
      }
      return result;
    });
  }

  function select(id) {
    return operation(async () => {
      if (!accounts().some(profile => profile.id === id)) throw new Error('This account is no longer saved.');
      if (canPersist()) await store.change(state => { state.activeAccountId = id; });
      sessionSelection = id;
    });
  }

  function remove(id) {
    return operation(async () => {
      if (!accounts().some(profile => profile.id === id)) throw new Error('This account is no longer saved.');
      const wasSelected = account()?.id === id;
      if (canPersist()) {
        await fs.rm(file(id), { force: true });
        if (store.get().account?.id === id) await fs.rm(legacyFile, { force: true });
        await store.change(state => {
          state.accounts = state.accounts.filter(profile => profile.id !== id);
          if (state.activeAccountId === id) state.activeAccountId = state.accounts[0]?.id || null;
          if (state.account?.id === id) state.account = null;
        });
      }
      sessions.delete(id);
      if (wasSelected) sessionSelection = canPersist() ? null : accounts()[0]?.id || null;
    });
  }

  return { account, accounts, ensureIdle, login, migrate, openCode, remove, select, signIn, pending: () => running };
}

module.exports = { createAuth };
