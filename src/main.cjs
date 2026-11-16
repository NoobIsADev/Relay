const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { autoUpdater } = require('electron-updater');
const { openStore, cleanVersion } = require('./storage.cjs');
const { createAuth } = require('./auth.cjs');
const { createGame, loaderNames, loaders, titles } = require('./game.cjs');
const { createCatalog, details, search } = require('./catalog.cjs');
const { contents, createSharing, sharedFolders } = require('./sharing.cjs');

const ui = path.join(__dirname, 'index.html');
const uiUrl = pathToFileURL(ui).href;
const themeNames = ['midnight', 'graphite', 'ocean', 'amethyst', 'sky', 'mint', 'lavender', 'system'];
const windows = process.platform === 'win32';
const linux = process.platform === 'linux';
let window;
let store;
let auth;
let game;
let catalog;
let sharing;
let doing;
let checking;
let settingsWrites = Promise.resolve();
let pendingSettings = 0;
let closeAfterSettings = false;
let updateStatus = { state: 'idle' };

function emit(event) {
  if (window && !window.isDestroyed()) window.webContents.send('relay:event', event);
}

function state() {
  const current = store.get();
  return {
    settings: current.settings, account: auth.account(),
    instances: current.instances.map(item => ({ ...item, content: contents(current, item) })),
    appVersion: app.getVersion(), running: game.running(), update: updateStatus
  };
}

async function exclusive(fn) {
  if (doing) throw new Error('Another installation or library change is in progress.');
  doing = true;
  try {
    return await fn();
  } finally {
    doing = false;
  }
}

function number(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}
function accent(value) {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : '';
}
function confinedString(value, fallback = '', max = 1024) {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

async function saveSettings(payload) {
  const previous = store.get().settings;
  const id = confinedString(payload.microsoftClientId, previous.microsoftClientId, 40).toLowerCase();
  if (id && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(id)) throw new Error('Enter a valid Microsoft application ID.');
  const shared = Object.fromEntries(sharedFolders.map(folder => [
    folder, typeof payload.shared?.[folder] === 'boolean' ? payload.shared[folder] : previous.shared[folder]
  ]));
  const changedSharing = sharedFolders.some(folder => shared[folder] !== previous.shared[folder]);
  const changedAccount = id !== previous.microsoftClientId;
  const next = {
    theme: themeNames.includes(payload.theme) ? payload.theme : previous.theme,
    accent: typeof payload.accent === 'string' ? accent(payload.accent) : previous.accent,
    sounds: typeof payload.sounds === 'boolean' ? payload.sounds : previous.sounds,
    toasts: typeof payload.toasts === 'boolean' ? payload.toasts : previous.toasts,
    volume: number(payload.volume, 0, 100, previous.volume),
    ram: number(payload.ram, 1024, 32768, previous.ram),
    java: confinedString(payload.java, previous.java), microsoftClientId: id, shared
  };
  if (changedSharing || changedAccount) {
    await exclusive(async () => {
      if (changedSharing && game.running().length) throw new Error('Close Minecraft before changing shared folders.');
      if (changedAccount) await auth.signOut();
      await sharing.saveSettings(next);
    });
  } else {
    await sharing.saveSettings(next);
  }
  return state();
}

function enqueueSettings(payload) {
  pendingSettings++;
  const save = settingsWrites.then(() => saveSettings(payload));
  settingsWrites = save.catch(() => {});
  return save.finally(() => {
    pendingSettings--;
    if (!pendingSettings && closeAfterSettings && window && !window.isDestroyed()) {
      closeAfterSettings = false;
      setImmediate(() => { if (!window.isDestroyed()) window.close(); });
    }
  });
}

async function createInstance(payload) {
  const minecraft = cleanVersion(payload.minecraft);
  const loader = payload.loader;
  if (!Object.hasOwn(loaderNames, loader) || loader === 'neoforge') throw new Error('Choose a supported mod loader.');
  const loaderVersion = loader === 'vanilla' ? '' : cleanVersion(payload.loaderVersion);
  const name = confinedString(payload.name, '', 64);
  if (!name) throw new Error('Enter an instance name.');
  const item = {
    id: randomUUID(), minecraft, loader, loaderVersion, name,
    accent: accent(payload.accent), icon: '', cover: '', ram: 0, java: '',
    created: Date.now(), lastPlayed: 0, content: []
  };
  await fs.mkdir(store.dir(item.id), { recursive: true });
  await sharing.add(item);
  return item;
}

async function editInstance(id, payload) {
  store.instance(id);
  if (game.busy(id)) throw new Error('Close Minecraft before editing this instance.');
  const name = confinedString(payload.name, '', 64);
  if (!name) throw new Error('Enter an instance name.');
  return store.change(data => {
    const target = data.instances.find(item => item.id === id);
    Object.assign(target, { name, accent: accent(payload.accent), ram: payload.ram ? number(payload.ram, 1024, 32768, 0) : 0, java: confinedString(payload.java) });
  });
}

async function removeContent(id, project) {
  const item = store.instance(id);
  if (game.busy(id)) throw new Error('Close Minecraft before changing installed content.');
  const entry = contents(store.get(), item).find(value => value.project === project);
  if (!entry) throw new Error('This project is no longer installed.');
  const original = sharing.file(item, entry.relative);
  const temp = original + '.' + randomUUID() + '.removed';
  const moved = await fs.rename(original, temp).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  try {
    await store.change(data => {
      if (entry.shared) data.sharedContent = data.sharedContent.filter(value => value.project !== project);
      else {
        const target = data.instances.find(value => value.id === id);
        target.content = target.content.filter(value => value.project !== project);
      }
    });
  } catch (error) {
    if (moved) await fs.rename(temp, original);
    throw error;
  }
  if (moved) await fs.rm(temp, { force: true });
}

function update(event) {
  updateStatus = event;
  emit({ type: 'update', ...event });
}

function checkUpdates(manual = false) {
  if (!app.isPackaged || (!windows && !(linux && process.env.APPIMAGE))) {
    if (manual) {
      const distribution = linux ? 'Run Relay directly from its AppImage' : 'Install Relay using the Windows setup file';
      update({ state: 'development', message: distribution + ' to use automatic updates.' });
    }
    return;
  }
  if (checking || ['ready', 'downloading'].includes(updateStatus.state)) return;
  checking = Promise.resolve(autoUpdater.checkForUpdates())
    .catch(() => update({ state: 'error', message: 'Could not check GitHub for an update.' }))
    .finally(() => { checking = null; });
}

function configureUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => update({ state: 'checking', message: 'Checking GitHub Releases…' }));
  autoUpdater.on('update-available', info => update({ state: 'downloading', message: 'Downloading Relay ' + info.version }));
  autoUpdater.on('update-not-available', () => update({ state: 'current', message: 'Relay is up to date.' }));
  autoUpdater.on('download-progress', progress => update({ state: 'downloading', message: 'Downloading update · ' + Math.round(progress.percent) + '%' }));
  autoUpdater.on('update-downloaded', info => update({ state: 'ready', message: 'Relay ' + info.version + ' is ready to install.' }));
  autoUpdater.on('error', () => update({ state: 'error', message: 'Could not download the latest Relay update.' }));
  setTimeout(checkUpdates, 6000).unref();
  setInterval(checkUpdates, 4 * 60 * 60 * 1000).unref();
}

function register() {
  const api = {
    state,
    async versions() {
      const result = await titles();
      return { latest: result.latest, versions: result.versions.map(({ id, type }) => ({ id, type })) };
    },
    loaders,
    'instance:create': payload => exclusive(() => createInstance(payload)),
    'instance:edit': (id, payload) => exclusive(() => editInstance(id, payload)),
    'instance:folder': async id => {
      store.instance(id);
      const dir = store.dir(id);
      await fs.mkdir(dir, { recursive: true });
      const error = await shell.openPath(dir);
      if (error) throw new Error('Relay could not open the instance folder.');
    },
    'instance:delete': id => exclusive(async () => {
      store.instance(id);
      if (game.busy(id)) throw new Error('Close Minecraft before deleting this instance.');
      const folder = store.dir(id);
      const trash = folder + '.removed';
      const exists = await fs.rename(folder, trash).then(() => true, error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      try {
        await store.change(data => { data.instances = data.instances.filter(item => item.id !== id); });
      } catch (error) {
        if (exists) await fs.rename(trash, folder);
        throw error;
      }
      // The folder is moved to the OS recycle bin after the library entry is committed.
      if (exists) await shell.trashItem(trash).catch(() => {});
    }),
    'game:install': (id, repair) => exclusive(() => game.perform(id, null, Boolean(repair))),
    'game:play': id => exclusive(async () => game.perform(id, await auth.login(false))),
    'game:stop': id => game.stop(id),
    'catalog:search': payload => search({ ...payload, item: payload.instance ? store.instance(payload.instance) : null }),
    'catalog:details': (slug, id) => details(slug, id ? store.instance(id) : null),
    'catalog:install': (slug, version, id) => exclusive(() => {
      const item = id ? store.instance(id) : null;
      if (item && game.busy(item.id)) throw new Error('Close Minecraft before installing content into this instance.');
      return catalog.install(slug, version, item);
    }),
    'catalog:remove': (id, project) => exclusive(() => removeContent(id, project)),
    'account:sign-in': async () => (await auth.login(true)).account,
    'account:sign-out': () => auth.signOut(),
    'account:browser': () => auth.openCode(),
    'account:copy': code => {
      if (typeof code !== 'string' || !/^[A-Z\d-]{4,20}$/i.test(code)) throw new Error('No active device code.');
      clipboard.writeText(code);
    },
    'settings:save': enqueueSettings,
    'settings:shared-folder': async () => {
      await Promise.all(sharedFolders.map(folder => fs.mkdir(path.join(sharing.root, folder), { recursive: true })));
      if (await shell.openPath(sharing.root)) throw new Error('Relay could not open the shared files folder.');
    },
    'settings:java': async () => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Choose a Java executable', properties: ['openFile'],
        ...(windows ? { filters: [{ name: 'Java executable', extensions: ['exe'] }] } : {})
      });
      return result.canceled ? '' : result.filePaths[0];
    },
    'updates:check': () => checkUpdates(true),
    'updates:install': () => {
      if (updateStatus.state !== 'ready') throw new Error('No update is ready to install.');
      if (doing || game.running().length) throw new Error('Close Minecraft and wait for active installs before restarting.');
      if (pendingSettings) throw new Error('Wait for settings to finish saving before restarting.');
      autoUpdater.quitAndInstall();
    },
    'window:action': action => {
      if (action === 'minimize') window.minimize();
      if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
      if (action === 'close') window.close();
    },
    'open:link': url => {
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.username || target.password || target.port ||
          !['modrinth.com', 'github.com', 'aka.ms'].includes(target.hostname)) throw new Error('This link cannot be opened from Relay.');
      return shell.openExternal(target.href);
    }
  };
  for (const [channel, handler] of Object.entries(api)) {
    ipcMain.handle('relay:' + channel, (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame?.url !== uiUrl) throw new Error('Request came from an unknown page.');
      return handler(...args);
    });
  }
}

function createWindow() {
  window = new BrowserWindow({
    title: 'Relay', width: 1260, height: 850, minWidth: 850, minHeight: 670,
    frame: false, show: false, backgroundColor: '#111b2c',
    icon: path.join(__dirname, windows ? '../assets/relay.ico' : '../assets/logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (pendingSettings) {
      event.preventDefault();
      closeAfterSettings = true;
      return;
    }
    if (!doing) return;
    event.preventDefault();
    emit({ type: 'busy-close' });
  });
  window.loadFile(ui);
}

if (windows) app.setAppUserModelId('dev.noobisadev.relay');
app.setPath('userData', app.commandLine.getSwitchValue('user-data-dir') || path.join(app.getPath('appData'), 'Relay'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const root = app.getPath('userData');
    store = await openStore(root);
    sharing = createSharing(root, store);
    await sharing.recover();
    auth = createAuth(root, store, emit);
    game = createGame(root, store, emit);
    catalog = createCatalog(root, store, emit, sharing);
    register();
    createWindow();
    if (app.isPackaged) configureUpdater();
  }).catch(error => {
    dialog.showErrorBox('Relay could not start', error.message);
    app.quit();
  });
}
app.on('window-all-closed', () => app.quit());
