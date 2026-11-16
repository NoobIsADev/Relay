const path = require('node:path');
const fs = require('node:fs/promises');
const { Authflow } = require('prismarine-auth');
const { safeStorage, shell } = require('electron');
const { writeAtomic } = require('./storage.cjs');

function createAuth(root, store, send) {
  const encryptedFile = path.join(root, 'microsoft.bin');
  let running;
  let currentCode;
  let sessionAccount;
  let memory = {};
  let saves = Promise.resolve();

  function canPersist() {
    return safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  }

  function account() {
    return sessionAccount || (canPersist() ? store.get().account : null);
  }

  function persist() {
    if (!canPersist()) return Promise.resolve();
    const data = safeStorage.encryptString(JSON.stringify(memory));
    saves = saves.catch(() => {}).then(() => writeAtomic(encryptedFile, data));
    return saves;
  }

  function cache({ cacheName }) {
    return {
      getCached: async () => memory[cacheName] || {},
      setCached: async value => { memory[cacheName] = value; await persist(); },
      setCachedPartial: async value => {
        memory[cacheName] = { ...memory[cacheName], ...value };
        await persist();
      },
      reset: async () => { delete memory[cacheName]; await persist(); return {}; }
    };
  }

  async function openCode() {
    if (!currentCode || currentCode.expiresAt <= Date.now()) throw new Error('Start a new Microsoft sign-in.');
    await shell.openExternal(currentCode.url);
  }

  async function login(allowPrompt) {
    if (running) return running;
    running = (async () => {
      currentCode = undefined;
      if (!allowPrompt && !account()) throw new Error('Sign in with Microsoft before launching Minecraft.');
      if (!Object.keys(memory).length && canPersist()) {
        try {
          memory = JSON.parse(safeStorage.decryptString(await fs.readFile(encryptedFile)));
        } catch (error) {
          if (error.code !== 'ENOENT') {
            if (!allowPrompt) throw new Error('Sign in again to refresh your Microsoft session.');
          }
        }
      }
      const id = store.get().settings.microsoftClientId;
      const options = id ? { flow: 'msal', authTitle: id } : undefined;
      let prompted = false;
      const flow = new Authflow('relay-account', cache, options, data => {
        prompted = true;
        if (!allowPrompt) throw new Error('Interactive sign-in required.');
        const userCode = data.user_code || data.userCode;
        const candidate = new URL(data.verification_uri || data.verificationUri || 'https://www.microsoft.com/link');
        const safe = candidate.protocol === 'https:' && ['www.microsoft.com', 'microsoft.com', 'login.live.com', 'aka.ms', 'login.microsoftonline.com'].includes(candidate.hostname);
        const url = safe ? candidate : new URL('https://www.microsoft.com/link');
        if (url.pathname === '/link' && userCode) url.searchParams.set('otc', userCode);
        currentCode = { userCode, url: url.href, expiresAt: Date.now() + 1000 * (data.expires_in || 900) };
        send({ type: 'auth-code', ...currentCode });
        openCode().catch(() => {});
      });
      let session;
      try {
        session = await flow.getMinecraftJavaToken({ fetchProfile: true, fetchEntitlements: true });
      } catch (error) {
        if (!allowPrompt || prompted && !currentCode) throw new Error('Sign in again to refresh your Microsoft session.');
        if (/403|forbidden/i.test(error.message)) {
          throw new Error('Xbox or Minecraft Services rejected this sign-in. Try again or use an approved application ID in Settings.');
        }
        if (/expired|denied|cancel/i.test(error.message)) throw new Error('Microsoft sign-in expired or was declined. Start a new sign-in.');
        throw new Error('Microsoft sign-in could not finish. Check your connection and try again.');
      }
      if (!session.token || !session.profile?.id || !session.profile?.name) {
        if (allowPrompt && prompted) {
          memory = {};
          await persist();
        }
        throw new Error('Minecraft Java Edition did not return a player profile. Check that this Microsoft account owns the game and has set a Java username.');
      }
      sessionAccount = { name: session.profile.name, id: session.profile.id };
      const prior = store.get().account;
      if (canPersist() && (!prior || prior.id !== sessionAccount.id || prior.name !== sessionAccount.name)) {
        await store.change(state => { state.account = sessionAccount; });
      }
      return { account: sessionAccount, token: session.token };
    })();
    try {
      return await running;
    } finally {
      currentCode = undefined;
      running = undefined;
    }
  }

  async function signOut() {
    if (running) throw new Error('A sign-in is already in progress.');
    await saves.catch(() => {});
    await fs.rm(encryptedFile, { force: true });
    memory = {};
    sessionAccount = undefined;
    await store.change(state => { state.account = null; });
  }

  return { account, login, openCode, signOut, pending: () => Boolean(running) };
}

module.exports = { createAuth };
