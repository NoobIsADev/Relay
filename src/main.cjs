const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } = require('electron');
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
let updateTimer;
let downloadedVersion;
let openFileDialogs = 0;

function emit(event) {
  if (window && !window.isDestroyed()) window.webContents.send('relay:event', event);
}

function state() {
  const current = store.get();
  return {
    settings: current.settings, account: auth.account(), accounts: auth.accounts(),
    instances: current.instances.map(item => ({ ...item, content: contents(current, item) })),
    appVersion: app.getVersion(), running: game.running(), downloads: catalog.active(), update: updateStatus
  };
}

async function exclusive(fn) {
  if (updateStatus.state === 'installing') throw new Error('Relay is restarting to apply an update.');
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

function customIcon(value = '') {
  if (value !== '' && (typeof value !== 'string' || value.length > 60000 ||
      !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value))) {
    throw new Error('Choose a PNG or JPEG instance icon.');
  }
  return value;
}

async function chooseFile(title, filters) {
  if (updateStatus.state === 'installing') throw new Error('Relay is restarting to apply an update.');
  openFileDialogs++;
  try {
    const result = await dialog.showOpenDialog(window, {
      title, properties: ['openFile'], ...(filters ? { filters } : {})
    });
    return result.canceled ? '' : result.filePaths[0];
  } finally {
    openFileDialogs--;
  }
}

async function chooseIcon() {
  const file = await chooseFile('Choose an instance icon', [{ name: 'PNG and JPEG images', extensions: ['png', 'jpg', 'jpeg'] }]);
  if (!file) return '';
  const handle = await fs.open(file, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 8 * 1024 ** 2) throw new Error('Choose an image smaller than 8 MB.');
    const image = nativeImage.createFromBuffer(await handle.readFile());
    const { width, height } = image.getSize();
    if (image.isEmpty() || width > 4096 || height > 4096) {
      throw new Error('Choose a PNG or JPEG image up to 4096 pixels wide and high.');
    }
    const edge = Math.min(width, height);
    const square = image.crop({ x: Math.floor((width - edge) / 2), y: Math.floor((height - edge) / 2), width: edge, height: edge });
    return customIcon(square.resize({ width: 96, height: 96, quality: 'best' }).toDataURL());
  } finally {
    await handle.close();
  }
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
      if (changedAccount) auth.ensureIdle();
      await catalog.commit(() => sharing.saveSettings(next));
    });
  } else {
    await sharing.saveSettings(next);
  }
  return state();
}

function enqueueSettings(payload) {
  if (updateStatus.state === 'installing') throw new Error('Relay is restarting to apply an update.');
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
    accent: accent(payload.accent), icon: '', customIcon: customIcon(payload.customIcon), cover: '', ram: 0, java: '',
    created: Date.now(), lastPlayed: 0, content: []
  };
  await fs.mkdir(store.dir(item.id), { recursive: true });
  await catalog.commit(() => sharing.add(item));
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
    if (Object.hasOwn(payload, 'customIcon')) target.customIcon = customIcon(payload.customIcon);
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

function busyForUpdate() {
  return doing || pendingSettings > 0 || openFileDialogs > 0 || game.running().length > 0 || auth.pending() || catalog.busy();
}

function scheduleUpdate() {
  if (!downloadedVersion || updateTimer) return;
  const waiting = busyForUpdate();
  const nextState = waiting ? 'ready' : 'scheduled';
  if (updateStatus.state !== nextState) {
    update({ state: nextState, message: 'Relay ' + downloadedVersion + (waiting ?
      ' will install when Minecraft and current tasks finish.' : ' will install automatically and restart Relay.') });
  }
  updateTimer = setTimeout(() => {
    updateTimer = undefined;
    if (waiting || busyForUpdate()) return scheduleUpdate();
    update({ state: 'installing', message: 'Installing Relay ' + downloadedVersion + '…' });
    autoUpdater.quitAndInstall(true, true);
  }, waiting ? 2000 : 5000);
  updateTimer.unref();
}

function checkUpdates(manual = false) {
  if (!app.isPackaged || (!windows && !(linux && process.env.APPIMAGE))) {
    if (manual) {
      const distribution = linux ? 'Run Relay directly from its AppImage' : 'Install Relay using the Windows setup file';
      update({ state: 'development', message: distribution + ' to use automatic updates.' });
    }
    return;
  }
  if (checking || downloadedVersion || updateStatus.state === 'downloading') return;
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
  autoUpdater.on('update-downloaded', info => {
    downloadedVersion = info.version;
    scheduleUpdate();
  });
  autoUpdater.on('error', () => {
    const installing = updateStatus.state === 'installing';
    clearTimeout(updateTimer);
    updateTimer = undefined;
    downloadedVersion = undefined;
    update({ state: 'error', message: installing ? 'Could not install the Relay update.' : 'Could not download the latest Relay update.' });
  });
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
    'instance:choose-icon': chooseIcon,
    'instance:folder': async id => {
      store.instance(id);
      const dir = store.dir(id);
      await fs.mkdir(dir, { recursive: true });
      const error = await shell.openPath(dir);
      if (error) throw new Error('Relay could not open the instance folder.');
    },
    'instance:delete': id => exclusive(() => catalog.commit(async () => {
      store.instance(id);
      if (game.busy(id)) throw new Error('Close Minecraft before deleting this instance.');
      if (catalog.active().some(job => job.instance === id)) throw new Error('Wait for this instance’s downloads to finish before deleting it.');
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
    })),
    'game:install': (id, repair) => exclusive(() => game.perform(id, null, Boolean(repair))),
    'game:play': id => exclusive(async () => game.perform(id, await auth.login())),
    'game:stop': id => game.stop(id),
    'catalog:search': payload => search({ ...payload, item: payload.instance ? store.instance(payload.instance) : null }),
    'catalog:details': (slug, id) => details(slug, id ? store.instance(id) : null),
    'catalog:install': (slug, version, id) => {
      if (updateStatus.state === 'installing') throw new Error('Relay is restarting to apply an update.');
      const item = id ? store.instance(id) : null;
      return catalog.install(slug, version, item);
    },
    'catalog:remove': (id, project) => exclusive(() => catalog.commit(() => removeContent(id, project))),
    'account:sign-in': id => auth.signIn(id),
    'account:select': id => auth.select(id),
    'account:remove': id => auth.remove(id),
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
    'settings:java': () => chooseFile('Choose a Java executable', windows ? [{ name: 'Java executable', extensions: ['exe'] }] : undefined),
    'updates:check': () => checkUpdates(true),
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
    if (!doing && !catalog.busy()) {
      if (busyForUpdate()) autoUpdater.autoInstallOnAppQuit = false;
      return;
    }
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
    await auth.migrate().catch(error => console.warn('Could not migrate the legacy Microsoft cache:', error.code));
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
