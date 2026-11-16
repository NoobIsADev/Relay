const api = window.relay;
const main = document.querySelector('#main');
const modal = document.querySelector('#modal');
const signin = document.querySelector('#signin');
const $ = (selector, within = document) => within.querySelector(selector);
const labels = { vanilla: 'Vanilla', fabric: 'Fabric', legacyfabric: 'Legacy Fabric', forge: 'Forge', liteloader: 'LiteLoader', quilt: 'Quilt', neoforge: 'NeoForge' };
const categoryNames = { mod: 'Mods', modpack: 'Modpacks', resourcepack: 'Resource packs', shader: 'Shaders' };
const themeNames = {
  midnight: 'Midnight', graphite: 'Graphite', ocean: 'Deep Ocean', amethyst: 'Amethyst',
  sky: 'Light blue', mint: 'Mint', lavender: 'Lavender', system: 'Use system theme'
};
const defaultAccents = {
  midnight: '#85c4ff', graphite: '#c8d8ee', ocean: '#6ce3e8', amethyst: '#d1b2ff',
  sky: '#1668bd', mint: '#0e7558', lavender: '#6648a8'
};
const sharedPreferences = { sharedResourcePacks: 'resourcepacks', sharedShaderPacks: 'shaderpacks' };
const count = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let data;
let page = 'library';
let activeItem = '';
let discover = { type: 'mod', query: '', index: 'downloads', offset: 0, instance: '' };
let renderId = 0;
let versionPromise;
let popularPromise;
let progress = new Map();
const downloads = new Map();
const startingDownloads = new Set();
let authBusy = false;
let authCode;
let authError = '';
let authTarget = '';
let projectSequence = 0;
const pendingPreferences = new Map();
let preferenceError = '';
let preferencesSaved = false;
let instanceRailMarkup = '';
let soundContext;

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function svg(name) {
  return '<span class="icon" aria-hidden="true" style="--icon:url(../assets/icons/' + name + '.svg)"></span>';
}
function source(url) {
  try {
    const value = new URL(url);
    return value.protocol === 'https:' && value.hostname === 'cdn.modrinth.com' && !value.port &&
      !value.username && !value.password ? value.href : '';
  } catch {
    return '';
  }
}
function image(url, fallback, cls) {
  const imageUrl = source(url);
  return imageUrl ? '<img class="' + cls + '" src="' + esc(imageUrl) + '" alt="" loading="lazy">' :
    '<span class="' + cls + '">' + svg(fallback) + '</span>';
}
function instanceArt(item, cls) {
  const custom = item.customIcon;
  const local = typeof custom === 'string' && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(custom);
  const url = local ? custom : source(item.icon);
  return '<img class="instance-art ' + cls + (url ? '' : ' default-art') + '" src="' +
    esc(url || '../assets/logo.png') + '" alt="" decoding="async">';
}
function button(label, icon, action, options = {}) {
  return '<button type="button" class="button ' + (options.style || '') + '" data-action="' + action +
    '"' + (options.id ? ' data-id="' + esc(options.id) + '"' : '') + (options.disabled ? ' disabled' : '') + '>' +
    (icon ? svg(icon) : '') + esc(label) + '</button>';
}
function iconButton(label, icon, action, id = '') {
  return '<button type="button" class="icon-button" title="' + esc(label) + '" aria-label="' + esc(label) +
    '" data-action="' + action + '" data-id="' + esc(id) + '">' + svg(icon) + '</button>';
}
function option(value, name, selected) {
  return '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(name) + '</option>';
}
function field(label, input) {
  return '<label class="field">' + esc(label) + input + '</label>';
}
function empty(icon, title, line, action = '') {
  return '<div class="empty"><span class="empty-icon">' + svg(icon) + '</span><div><strong>' + esc(title) +
    '</strong><p>' + esc(line) + '</p></div>' + action + '</div>';
}
function heading(title, sub, right = '') {
  return '<div class="page-head"><div><h1>' + esc(title) + '</h1><p class="sub">' + esc(sub) + '</p></div>' + right + '</div>';
}
function itemById(id) {
  return data.instances.find(item => item.id === id);
}
function validAccent(value) {
  return /^#[0-9a-f]{6}$/i.test(value || '') ? value : '';
}
function cover(url) {
  const safe = source(url);
  return safe ? ' style="--cover:url(&quot;' + esc(safe.replaceAll('"', '%22')) + '&quot;)"' : '';
}
function loaderLine(item) {
  return 'Minecraft ' + item.minecraft + ' · ' + labels[item.loader];
}
function theme(theme, color) {
  const actual = theme === 'system' ? systemTheme.matches ? 'midnight' : 'sky' : theme;
  document.documentElement.dataset.theme = actual;
  const style = document.documentElement.style;
  const hex = validAccent(color);
  if (hex) {
    const channels = hex.slice(1).match(/../g).map(part => {
      const value = parseInt(part, 16) / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    const light = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
    style.setProperty('--accent', hex);
    style.setProperty('--on-accent', light > .178 ? '#071323' : '#fff');
    style.setProperty('--accent-soft', 'color-mix(in srgb,' + hex + ',var(--pure) 82%)');
  } else {
    for (const key of ['--accent', '--on-accent', '--accent-soft']) style.removeProperty(key);
  }
}

function playTone(kind = 'success', customVolume) {
  if (!data || (!data.settings.sounds && customVolume === undefined)) return;
  const volume = (customVolume ?? data.settings.volume) / 100;
  if (!volume) return;
  try {
    soundContext ||= new AudioContext();
    soundContext.resume().catch(() => {});
    const frequencies = kind === 'error' ? [293, 220] : [523, 659, 784];
    frequencies.forEach((frequency, index) => {
      const oscillator = soundContext.createOscillator();
      const envelope = soundContext.createGain();
      const time = soundContext.currentTime + index * 0.075;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(.0001, time);
      envelope.gain.exponentialRampToValueAtTime(Math.max(.001, volume * .095), time + .018);
      envelope.gain.exponentialRampToValueAtTime(.0001, time + .22);
      oscillator.connect(envelope).connect(soundContext.destination);
      oscillator.start(time);
      oscillator.stop(time + .23);
    });
  } catch {
    // Audio is optional when a system sound device is unavailable.
  }
}
function toast(message, kind = 'success') {
  playTone(kind);
  if (data && !data.settings.toasts && kind !== 'error') return;
  const element = document.createElement('div');
  element.className = 'toast ' + kind;
  element.innerHTML = svg(kind === 'error' ? 'circle-alert' : 'circle-check') + '<span>' + esc(message) +
    '</span>' + iconButton('Dismiss notification', 'x', 'dismiss-toast');
  $('#toasts').append(element);
  setTimeout(() => element.remove(), kind === 'error' ? 8400 : 4800);
}
function errorText(error) {
  return (error?.message || 'Relay could not complete this action.').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 470);
}
function modalError(error, within = modal) {
  const target = $('.error-text', within);
  if (!target) return toast(errorText(error), 'error');
  target.textContent = errorText(error);
  target.hidden = false;
}
function showDialog(title, body, footer = '', sub = '', artwork = '') {
  const name = '<div><h2 id="modal-title">' + esc(title) + '</h2>' + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') + '</div>';
  const heading = artwork ? '<div class="dialog-project-heading">' + artwork + name + '</div>' : name;
  modal.innerHTML = '<div class="dialog-inner"><div class="dialog-head split">' + heading + iconButton('Close dialog', 'x', 'close-dialog') +
    '</div><div class="dialog-body">' + body + '</div><p class="error-text" hidden></p>' +
    (footer ? '<div class="dialog-actions row">' + footer + '</div>' : '') + '</div>';
  if (!modal.open) modal.showModal();
}
function refreshInstanceRail() {
  const rail = $('#rail-instances');
  const markup = data.instances.map(item => {
    const detail = item.minecraft + ' / ' + labels[item.loader];
    const selected = page === 'instance' && activeItem === item.id ? ' aria-current="page"' : '';
    return '<button type="button" class="rail-instance" data-action="view-instance" data-id="' + esc(item.id) +
      '" title="' + esc(item.name + ' · ' + detail) + '"' + selected + '>' +
      instanceArt(item, 'rail-instance-icon') + '<span class="rail-instance-label"><strong>' + esc(item.name) +
      '</strong><small>' + esc(detail) + '</small></span></button>';
  }).join('');
  rail.hidden = data.instances.length === 0;
  if (markup === instanceRailMarkup) return;
  instanceRailMarkup = markup;
  const scrollTop = rail.scrollTop;
  const focused = rail.contains(document.activeElement) ? document.activeElement.dataset.id : '';
  rail.innerHTML = markup;
  rail.scrollTop = scrollTop;
  if (focused) Array.from(rail.children).find(button => button.dataset.id === focused)?.focus({ preventScroll: true });
}
function refreshChrome() {
  const account = data.account;
  $('#account').innerHTML = '<span class="avatar">' + (account ? esc(account.name.slice(0, 2).toUpperCase()) : svg('user-round')) +
    '</span><span class="truncate"><strong>' + esc(account?.name || 'Sign in') + '</strong><small>Microsoft account</small></span>';
  const updating = ['ready', 'scheduled', 'installing'].includes(data.update?.state);
  const updateButton = $('#rail-update');
  updateButton.innerHTML = svg(updating ? 'arrow-down-to-line' : 'refresh-cw') +
    (updating ? 'Update pending' : 'Relay ' + esc(data.appVersion));
  for (const nav of document.querySelectorAll('[data-page]')) {
    if (nav.dataset.page === (page === 'instance' ? 'library' : page)) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  refreshInstanceRail();
}
async function refresh(draw = true) {
  const first = !data;
  data = await api.state();
  if (first) for (const job of data.downloads) downloads.set(job.id, job);
  applySavedTheme();
  refreshChrome();
  if (draw) render();
}
function navigate(next) {
  page = next;
  main.scrollTop = 0;
  refreshChrome();
  render();
}
function projectCard(project, quick = false) {
  const key = project.slug || project.project_id;
  const details = '<button type="button" class="project" data-action="project" data-id="' + esc(key) + '">' +
    '<span class="row">' + image(project.icon_url, 'package', 'project-icon') + '<span class="truncate"><h3>' + esc(project.title) +
    '</h3><span class="tile-note">' + esc(project.author || categoryNames[project.project_type]) + '</span></span></span><span class="desc">' +
    esc(project.description) + '</span><span class="stats">' + svg('download') + count.format(project.downloads || 0) + '</span></button>';
  if (!quick) return details;
  return '<div class="project-tile">' + details + '<div class="project-actions"><button type="button" class="button" ' +
    'data-action="quick-install" data-id="' + esc(project.project_id) + '" data-title="' + esc(project.title) +
    '" data-type="' + esc(project.project_type) + '"></button></div></div>';
}
function actionFor(item, mode = 'primary') {
  const playing = data.running.includes(item.id);
  const pending = progress.get(item.id);
  return button(playing ? 'Stop' : pending ? 'Preparing…' : 'Play', playing ? 'square' : 'play', playing ? 'stop' : 'play',
    { id: item.id, style: mode, disabled: Boolean(pending) });
}
function tile(item) {
  return '<div class="tile" style="--item:' + (validAccent(item.accent) || 'var(--accent)') + '">' +
    '<button type="button" class="tile-top" data-action="view-instance" data-id="' + esc(item.id) + '">' +
    instanceArt(item, 'tile-icon') + '<span class="truncate"><h3>' + esc(item.name) + '</h3><span class="tile-note">' +
    esc(loaderLine(item)) + '</span></span></button><div class="row trim">' +
    iconButton('Open instance folder', 'folder-open', 'folder', item.id) + actionFor(item) + '</div></div>';
}
function progressHtml(message) {
  return message ? '<div class="live-progress" role="status">' + esc(message) + '<div class="line-progress"></div></div>' : '';
}

function library(token) {
  const list = data.instances;
  const welcome = list.length ? '' : '<section class="hero"><div class="hero-copy"><p class="eyebrow">' +
    svg('box') + 'Minecraft Java Edition</p><h2>Make it your world.</h2>' +
    '<p class="sub">Create an instance, pick a loader, and add content from Modrinth.</p><div class="row">' +
    button('Create instance', 'plus', 'create', { style: 'primary' }) +
    button('Browse Modrinth', 'compass', 'discover', { style: 'secondary' }) + '</div></div></section>';
  main.innerHTML = '<div class="shell">' + heading('Your library', 'Manage your Minecraft Java Edition instances.',
    button('New instance', 'plus', 'create', { style: 'primary' })) + welcome +
    '<section class="section"><div class="split"><h2>Instances</h2><span class="tile-note">' +
    list.length + (list.length === 1 ? ' instance' : ' instances') + '</span></div><div id="game-progress">' +
    progressHtml([...progress.values()][0]) + '</div>' +
    (list.length ? '<div class="grid">' + list.map(tile).join('') + '</div>' :
      empty('box', 'Your library is empty', 'Add an instance to start playing.')) +
    '</section><section class="section"><div class="split"><h2>Popular on Modrinth</h2>' +
    button('Explore', 'arrow-right', 'discover') + '</div><div id="popular"><p class="loading">Loading popular mods…</p></div></section></div>';
  popularPromise ||= api.search({ type: 'mod', index: 'downloads' }).catch(error => {
    popularPromise = undefined;
    throw error;
  });
  popularPromise.then(result => {
    if (token === renderId) $('#popular').innerHTML = '<div class="project-grid">' + result.hits.slice(0, 3).map(project => projectCard(project)).join('') + '</div>';
  }).catch(error => {
    if (token === renderId) $('#popular').innerHTML = empty('wifi-off', 'Modrinth is unavailable', errorText(error));
  });
}

function instanceView() {
  const item = itemById(activeItem);
  if (!item) return navigate('library');
  const status = data.running.includes(item.id) ? 'Playing' : item.installed ? 'Installed' : 'Ready to install';
  main.innerHTML = '<div class="shell"><div class="row" style="margin-bottom:12px">' + button('Library', 'arrow-left', 'library') +
    '</div>' + heading(item.name, loaderLine(item) + ' · ' + status,
      '<div class="row">' + button('Folder', 'folder-open', 'folder', { id: item.id }) +
      button('Edit', 'pencil', 'edit', { id: item.id }) + '</div>') +
    '<section class="hero"' + cover(item.cover) + '><div class="hero-copy"><p class="eyebrow">' + svg('box') +
    esc(labels[item.loader]) + '</p><h2>' + esc(item.name) + '</h2><p class="sub">' + esc(loaderLine(item) +
      (item.loaderVersion ? ' · Loader ' + item.loaderVersion : '')) + '</p><div class="row">' + actionFor(item) +
    button(item.installed ? 'Repair files' : 'Install game files', item.installed ? 'wrench' : 'download',
      'install-game', { id: item.id, style: 'secondary', disabled: progress.has(item.id) || data.running.includes(item.id) }) +
    '</div></div></section><section class="section"><div id="game-progress">' + progressHtml(progress.get(item.id)) +
    '</div><div class="split"><h2>Installed Modrinth content</h2>' +
    button('Add content', 'plus', 'discover-for', { id: item.id }) + '</div>' +
    (item.content.length ? '<div class="grid">' + item.content.map(entry => '<div class="tile"><div class="tile-top">' +
      image(entry.icon, 'package', 'tile-icon') + '<div class="truncate"><h3>' + esc(entry.name) + '</h3><p class="tile-note">' +
      esc(entry.versionName) + (entry.shared ? ' · Shared' : '') +
      '</p></div></div><div class="row trim">' + iconButton('Remove ' + entry.name, 'trash-2', 'remove-content', entry.project) +
      '</div></div>').join('') + '</div>' :
      empty('layers', item.modpack ? 'Modpack files installed' : 'No individually installed content', item.modpack ?
        'This pack’s bundled files are available in its instance folder.' : 'Find compatible mods, shaders, and resource packs in Discover.')) +
    '</section></div>';
}

function discoverPage() {
  renderId++;
  main.innerHTML = '<div class="shell">' + heading('Discover', 'Find mods, modpacks, shaders, and resource packs on Modrinth.') +
    '<div class="pills">' + Object.entries(categoryNames).map(([key, label]) => '<button type="button" class="pill" data-action="category" data-id="' +
      key + '" aria-pressed="' + (discover.type === key) + '">' + esc(label) + '</button>').join('') + '</div>' +
    '<div class="controls"><label class="query">' + svg('search') + '<input id="search" type="search" aria-label="Search Modrinth" placeholder="Search Modrinth…" value="' +
    esc(discover.query) + '"></label><select id="sort" aria-label="Sort projects">' +
    [['downloads', 'Most downloaded'], ['relevance', 'Relevance'], ['follows', 'Most followed'], ['newest', 'Newest'], ['updated', 'Recently updated']]
      .map(([value, name]) => option(value, name, discover.index)).join('') + '</select>' +
    (discover.type === 'modpack' ? '' : '<select id="compatible" aria-label="Filter by instance">' +
      option('', 'All versions', discover.instance) + data.instances.map(item => option(item.id, item.name, discover.instance)).join('') + '</select>') +
    '</div><div id="catalog-progress" aria-live="polite"></div><div id="results" aria-live="polite"></div></div>';
  refreshDownloads();
  $('#search').addEventListener('input', event => {
    discover.query = event.target.value;
    discover.offset = 0;
    clearTimeout(event.target.relaySearch);
    ++renderId;
    event.target.relaySearch = setTimeout(() => { if (page === 'discover') loadSearch(); }, 260);
  });
  $('#sort').onchange = event => { discover.index = event.target.value; discover.offset = 0; loadSearch(); };
  if ($('#compatible')) $('#compatible').onchange = event => { discover.instance = event.target.value; discover.offset = 0; loadSearch(); };
  loadSearch();
}

async function loadSearch() {
  const id = ++renderId;
  const target = $('#results');
  if (!target) return;
  target.innerHTML = '<p class="loading">Searching Modrinth…</p>';
  try {
    const result = await api.search({ ...discover, instance: discover.type === 'modpack' ? '' : discover.instance });
    if (id !== renderId) return;
    const projectList = result.hits || [];
    target.innerHTML = projectList.length ? '<div class="project-grid">' + projectList.map(project => projectCard(project, true)).join('') +
      '</div><div class="row pager">' +
      button('Previous', 'arrow-left', 'previous', { disabled: discover.offset === 0 }) + '<span class="hint">' +
      (discover.offset + 1) + '–' + (discover.offset + projectList.length) + ' of ' + count.format(result.total_hits) + '</span>' +
      button('Next', 'arrow-right', 'next', { disabled: discover.offset + projectList.length >= Math.min(result.total_hits, 5000) }) + '</div>' :
      empty('search', 'No matching projects', 'Try a different search or select another instance.');
    refreshDownloads();
  } catch (error) {
    if (id === renderId) target.innerHTML = empty('wifi-off', 'Could not reach Modrinth', errorText(error), button('Retry', 'refresh-cw', 'retry-search'));

  }
}


function colorField(value, fallback) {
  return '<div class="row"><input type="color" name="color" aria-label="Custom accent color" value="' +
    esc(validAccent(value) || fallback) + '"><label class="check"><input type="checkbox" name="accentEnabled"' +
    (value ? ' checked' : '') + '> Use custom accent</label></div>';
}
function javaField(value) {
  return '<div class="row" style="flex-wrap:nowrap"><input name="java" maxlength="1024" value="' + esc(value) +
    '" placeholder="Managed by Relay" aria-label="Java executable">' + button('Browse', 'folder-open', 'pick-java') + '</div>';
}
function updateControls() {
  const state = data.update?.state;
  return button('Check for updates', 'refresh-cw', 'check-update', {
    disabled: ['checking', 'downloading', 'ready', 'scheduled', 'installing'].includes(state)
  }) +
    button('GitHub', 'external-link', 'github');
}
function displayedSettings() {
  let values = data.settings;
  for (const patch of pendingPreferences.values()) {
    values = { ...values, ...patch, shared: { ...values.shared, ...patch.shared } };
  }
  return values;
}
function applySavedTheme() {
  const values = displayedSettings();
  theme(values.theme, values.accent);
}
function settingsStatus() {
  const status = $('#settings-status');
  if (!status) return;
  status.textContent = preferenceError || (pendingPreferences.size ? 'Saving…' :
    preferencesSaved ? 'Saved automatically' : 'Changes save automatically');
  status.classList.toggle('error', Boolean(preferenceError));
}
function settingsAccount() {
  return '<p class="hint">' + esc(data.account ? 'Signed in as ' + data.account.name : 'Sign in with a Minecraft: Java Edition Microsoft account.') +
    '</p><div>' + button(data.accounts.length ? 'Manage accounts' : 'Sign in', 'user-round', 'signin') + '</div>';
}
function preferencePatch(form, control) {
  const name = control.name;
  const fields = form.elements;
  if (name === 'color' || name === 'accentEnabled') {
    return { accent: fields.accentEnabled.checked ? fields.color.value : '' };
  }
  if (Object.hasOwn(sharedPreferences, name)) return { shared: { [sharedPreferences[name]]: control.checked } };
  if (control.type === 'checkbox') return { [name]: control.checked };
  if (control.type === 'range' || control.type === 'number') return { [name]: control.valueAsNumber };
  return { [name]: control.value };
}
function restorePreference(name, key) {
  const form = $('#settings-form');
  if (!form) return;
  const fields = form.elements;
  const saved = data.settings;
  const control = fields[name];
  if (key === 'accent') {
    fields.accentEnabled.checked = Boolean(saved.accent);
    fields.color.value = saved.accent || defaultAccents[document.documentElement.dataset.theme];
  } else if (control.type === 'checkbox') {
    control.checked = Object.hasOwn(sharedPreferences, name) ? saved.shared[sharedPreferences[name]] : saved[name];
  } else if (control.type === 'range' || control.tagName === 'SELECT') {
    control.value = saved[name];
  } else {
    control.setAttribute('aria-invalid', 'true');
  }
}
async function savePreference(form, control) {
  const name = control.name;
  preferenceError = '';
  control.removeAttribute('aria-invalid');
  if (name === 'ram' && !control.validity.valid) {
    preferenceError = 'Enter memory between 1024 and 32768 MB in steps of 256.';
    control.setAttribute('aria-invalid', 'true');
    settingsStatus();
    return;
  }

  const patch = preferencePatch(form, control);
  const key = Object.hasOwn(patch, 'accent') ? 'accent' : name;
  pendingPreferences.set(key, patch);
  settingsStatus();
  let failed = false;
  try {
    const saved = await api.settings(patch);
    data.settings = saved.settings;
    data.account = saved.account;
    data.accounts = saved.accounts;
    if (patch.shared) data.instances = saved.instances;
    if (name === 'microsoftClientId' && $('#settings-account')) $('#settings-account').innerHTML = settingsAccount();
    refreshChrome();
    preferencesSaved = true;
  } catch (error) {
    failed = true;
    preferenceError = errorText(error);
    if (page !== 'settings') toast(preferenceError, 'error');
  } finally {
    const current = pendingPreferences.get(key) === patch;
    if (current) pendingPreferences.delete(key);
    if (key === 'accent' || key === 'theme') applySavedTheme();
    if (failed && current) restorePreference(name, key);
    settingsStatus();
  }
}
function settingsPage() {
  const setting = displayedSettings();
  const actual = document.documentElement.dataset.theme;
  main.innerHTML = '<div class="shell">' + heading('Settings', 'Personalize Relay and manage your Minecraft setup.',
    '<p id="settings-status" class="settings-status" role="status"></p>') +
    '<form id="settings-form" class="settings-form"><div class="settings-grid">' +
    '<section class="panel fields"><h2>Appearance</h2>' + field('Theme', '<select name="theme">' +
    Object.entries(themeNames).map(([value, name]) => option(value, name, setting.theme)).join('') + '</select>') +
    '<div class="field">Accent color' + colorField(setting.accent, defaultAccents[actual]) + '</div></section>' +
    '<section class="panel fields"><h2>Sounds & notifications</h2><label class="check"><input name="sounds" type="checkbox"' +
    (setting.sounds ? ' checked' : '') + '> Play notification sounds</label>' +
    '<label class="check"><input name="toasts" type="checkbox"' + (setting.toasts ? ' checked' : '') + '> Show notification toasts</label>' +
    field('Volume', '<input name="volume" type="range" min="0" max="100" value="' + setting.volume + '">') +
    '<div>' + button('Preview sound', 'volume-2', 'test-sound') + '</div></section>' +
    '<section class="panel fields"><h2>Minecraft</h2>' +
    field('Default memory (MB)', '<input name="ram" type="number" min="1024" max="32768" step="256" value="' + setting.ram + '" required>') +
    '<div class="field">Custom Java executable' + javaField(setting.java) + '<span>Leave blank to download the right Java runtime automatically.</span></div></section>' +
    '<section class="panel fields"><h2>Microsoft account</h2>' +
    '<div class="fields" id="settings-account">' + settingsAccount() + '</div>' +
    '<details><summary>Advanced sign-in</summary>' + field('Microsoft application ID',
      '<input name="microsoftClientId" value="' + esc(setting.microsoftClientId) +
      '" placeholder="Use Relay default" maxlength="40"><span>Optional approved public application ID.</span>') +
    '</details></section><section class="panel fields"><h2>Shared files</h2>' +
    '<label class="check"><input type="checkbox" name="sharedResourcePacks"' +
    (setting.shared.resourcepacks ? ' checked' : '') + '> Share resource packs across all instances</label>' +
    '<label class="check"><input type="checkbox" name="sharedShaderPacks"' +
    (setting.shared.shaderpacks ? ' checked' : '') + '> Share shader packs across all instances</label>' +
    '<p class="hint">Turning sharing on combines the folders. Turning it off copies the shared files back into each instance.</p>' +
    '<div>' + button('Open shared folder', 'folder-open', 'shared-folder') + '</div></section></div></form>' +
    '<section class="panel"><div class="split"><div><h2>Launcher updates</h2><p id="update-message" class="sub">' +
    esc(data.update?.message || 'Relay ' + data.appVersion) + '</p></div><div id="update-controls" class="row">' +
    updateControls() + '</div></div></section></div>';
  const form = $('#settings-form');
  const fields = form.elements;
  form.oninput = event => {
    const name = event.target.name;
    if (!['color', 'accentEnabled', 'theme'].includes(name)) return;
    if (name === 'color') fields.accentEnabled.checked = true;
    theme(fields.theme.value, fields.accentEnabled.checked ? fields.color.value : '');
    if (name === 'theme' && !fields.accentEnabled.checked) {
      fields.color.value = defaultAccents[document.documentElement.dataset.theme];
    }
  };
  form.onchange = event => {
    if (event.target.name) savePreference(form, event.target);
  };
  form.onkeydown = event => {
    if (event.key === 'Enter' && event.target.matches('input[type=number],input:not([type])')) {
      event.preventDefault();
      event.target.blur();
    }
  };
  form.onsubmit = event => event.preventDefault();
  settingsStatus();
}
function render() {
  const id = ++renderId;
  main.setAttribute('aria-busy', 'false');
  if (page === 'library') library(id);
  if (page === 'discover') discoverPage();
  if (page === 'instance') instanceView();
  if (page === 'settings') settingsPage();
}

function iconField(item = {}) {
  return '<div class="field">Instance icon<div class="row"><span data-icon-preview>' +
    instanceArt(item, 'editor-instance-icon') + '</span>' +
    button('Choose image', 'folder-open', 'choose-instance-icon') +
    button('Reset icon', 'refresh-cw', 'reset-instance-icon', { disabled: !item.customIcon }) + '</div></div>';
}
function previewInstanceIcon(form, customIcon) {
  form.dataset.customIcon = customIcon;
  $('[data-icon-preview]', form).innerHTML = instanceArt({ customIcon, icon: form.dataset.projectIcon }, 'editor-instance-icon');
  $('[data-action=reset-instance-icon]', form).disabled = !customIcon;
}

function createDialog() {
  showDialog('New instance',
    '<form id="instance-form">' + field('Instance name', '<input name="name" placeholder="My Minecraft instance" required maxlength="64">') +
    field('Minecraft version', '<select name="minecraft" required disabled><option>Loading versions…</option></select>') +
    '<label class="check" style="margin-bottom:9px"><input type="checkbox" name="snapshots"> Show snapshots and old alpha/beta versions</label>' +
    field('Mod loader', '<select name="loader">' +
      Object.entries(labels).filter(([key]) => key !== 'neoforge').map(([key, name]) => option(key, name, 'vanilla')).join('') + '</select>') +
    '<div id="loader-field" hidden>' + field('Loader version', '<select name="loaderVersion"></select>') + '</div>' +
    iconField() +
    '<div class="field">Instance accent' + colorField('', defaultAccents[document.documentElement.dataset.theme]) + '</div></form>',
    button('Cancel', '', 'close-dialog') + '<button class="button primary" type="submit" form="instance-form" disabled>' + svg('plus') +
    'Create instance</button>');
  const form = $('#instance-form');
  const f = form.elements;
  const submit = $('button[type=submit]', modal);
  let loaderGeneration = 0;
  let releases;
  let latest;
  async function selectLoader() {
    const generation = ++loaderGeneration;
    $('.error-text', modal).hidden = true;
    const loader = f.loader.value;
    const version = f.minecraft.value;
    $('#loader-field', form).hidden = loader === 'vanilla';
    submit.disabled = !version || loader !== 'vanilla';
    if (!submit.disabled || !version) return;
    f.loaderVersion.disabled = true;
    f.loaderVersion.innerHTML = '<option>Checking compatibility…</option>';
    try {
      const list = await api.loaders(loader, version);
      if (generation !== loaderGeneration || !form.isConnected) return;
      const preferred = list.find(entry => entry.recommended) || list.find(entry => entry.stable) || list[0];
      f.loaderVersion.innerHTML = preferred ? list.map(entry => option(entry.id, entry.id +
        (entry.recommended ? ' (recommended)' : ''), preferred.id)).join('') : '<option>No compatible versions</option>';
      f.loaderVersion.disabled = !preferred;
      submit.disabled = !preferred;
    } catch (error) {
      if (generation !== loaderGeneration || !form.isConnected) return;
      f.loaderVersion.innerHTML = '<option>Could not load versions</option>';
      modalError(error);
    }
  }
  function selectMinecraft() {
    if (!releases) return;
    const list = releases.filter(entry => f.snapshots.checked || entry.type === 'release');
    const current = list.some(entry => entry.id === f.minecraft.value) ? f.minecraft.value : latest.release;
    f.minecraft.innerHTML = list.map(entry => option(entry.id, entry.id + (entry.id === latest.release ? ' (latest release)' : ''), current)).join('');
    f.minecraft.disabled = false;
    selectLoader();
  }
  f.snapshots.onchange = selectMinecraft;
  f.minecraft.onchange = selectLoader;
  f.loader.onchange = selectLoader;
  versionPromise ||= api.versions().catch(error => { versionPromise = undefined; throw error; });
  versionPromise.then(result => {
    if (!form.isConnected) return;
    releases = result.versions;
    latest = result.latest;
    selectMinecraft();
  }).catch(error => { if (form.isConnected) modalError(error); });
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const item = await api.create({
        name: f.name.value, minecraft: f.minecraft.value, loader: f.loader.value,
        loaderVersion: f.loaderVersion.value, accent: f.accentEnabled.checked ? f.color.value : '',
        customIcon: form.dataset.customIcon || ''
      });
      modal.close();
      await refresh(false);
      activeItem = item.id;
      navigate('instance');
      toast('Created ' + item.name);
    } catch (error) {
      modalError(error);
      submit.disabled = false;
    }
  };
}

function editDialog(item) {
  showDialog('Edit instance', '<form id="edit-instance">' +
    field('Instance name', '<input name="name" value="' + esc(item.name) + '" required maxlength="64">') +
    iconField(item) +
    '<div class="field">Instance accent' + colorField(item.accent, defaultAccents[document.documentElement.dataset.theme]) + '</div>' +
    field('Memory override (MB)', '<input name="ram" type="number" min="1024" max="32768" step="256" placeholder="Use global setting" value="' + (item.ram || '') + '">') +
    '<div class="field">Java override' + javaField(item.java) + '</div></form>',
    button('Delete instance', 'trash-2', 'delete-instance', { id: item.id, style: 'danger' }) +
    '<button class="button primary" type="submit" form="edit-instance">' + svg('check') + 'Save</button>', loaderLine(item));
  const form = $('#edit-instance');
  form.dataset.customIcon = item.customIcon || '';
  form.dataset.projectIcon = item.icon || '';
  form.onsubmit = async event => {
    event.preventDefault();
    const f = form.elements;
    const submit = $('button[type=submit]', modal);
    submit.disabled = true;
    try {
      await api.edit(item.id, {
        name: f.name.value, accent: f.accentEnabled.checked ? f.color.value : '', ram: Number(f.ram.value),
        java: f.java.value, customIcon: form.dataset.customIcon
      });
      modal.close();
      await refresh();
      toast('Instance updated');
    } catch (error) {
      modalError(error);
      submit.disabled = false;
    }
  };
}
function confirmDialog(title, text, label, action, id) {
  showDialog(title, '<p class="sub">' + esc(text) + '</p>',
    button('Cancel', '', 'close-dialog') + button(label, 'trash-2', action, { id, style: 'danger' }));
}


function showAccounts() {
  if (authBusy) return showSignIn();
  if (!data.accounts.length) return openSignIn('');
  showDialog('Microsoft accounts', '<div class="accounts-list">' + data.accounts.map(profile => {
    const selected = data.account?.id === profile.id;
    return '<div class="account-row"><span class="avatar">' + esc(profile.name.slice(0, 2).toUpperCase()) +
      '</span><div class="truncate"><strong>' + esc(profile.name) + '</strong>' +
      (selected ? '<p class="tile-note">Active account</p>' : '') + '</div><div class="row account-actions">' +
      (selected ? '' : button('Use account', 'check', 'select-account', { id: profile.id })) +
      iconButton('Sign in again as ' + profile.name, 'refresh-cw', 'reconnect-account', profile.id) +
      iconButton('Remove ' + profile.name, 'trash-2', 'remove-account', profile.id) + '</div></div>';
  }).join('') + '</div>', button('Add account', 'plus', 'add-account', { style: 'primary' }));
}
function openSignIn(id) {
  if (authBusy) return showSignIn();
  authTarget = id;
  authError = '';
  if (modal.open) modal.close();
  showSignIn();
}
function showSignIn() {
  const expected = data.accounts.find(profile => profile.id === authTarget);
  signin.innerHTML = '<div class="dialog-inner"><div class="dialog-head split"><div><h2>Sign in with Microsoft</h2>' +
    '<p class="sub">' + esc(expected ? 'Reconnect the Microsoft account for ' + expected.name + '.' :
      'Use an account that owns Minecraft Java Edition.') + '</p></div>' +
    iconButton('Close sign-in dialog', 'x', 'close-signin') + '</div>' +
    (authCode ? '<p>Enter this code in your browser and finish signing in.</p><output class="code">' +
      esc(authCode.userCode) + '</output><div class="row">' + button('Copy code', 'copy', 'copy-code') +
      button('Open Microsoft', 'external-link', 'open-code', { style: 'primary' }) + '</div>' :
      authBusy ? progressHtml('Requesting a code from Microsoft…') :
      button('Continue in browser', 'external-link', 'start-signin', { style: 'primary' })) +
    '<p class="error-text"' + (authError ? '>' + esc(authError) : ' hidden>') + '</p></div>';
  if (!signin.open) signin.showModal();
}
async function beginSignIn() {
  if (authBusy) return;
  authBusy = true;
  authError = '';
  authCode = undefined;
  showSignIn();
  try {
    const account = await api.signIn(authTarget);
    if (signin.open) signin.close();
    await refresh();
    toast('Signed in as ' + account.name);
  } catch (error) {
    authBusy = false;
    authCode = undefined;
    authError = errorText(error);
    if (signin.open) showSignIn();
    else toast(authError, 'error');
  } finally {
    authBusy = false;
    authCode = undefined;
  }
}
async function projectDialog(slug, target = discover.instance) {
  const sequence = ++projectSequence;
  showDialog('Modrinth project', '<p class="loading">Loading project…</p>');
  try {
    const { project, versions } = await api.project(slug, target);
    if (!modal.open || sequence !== projectSequence) return;
    const isPack = project.project_type === 'modpack';
    const jobId = downloadId(project.id, isPack ? '' : target);
    const selected = versions.find(version => version.version_type === 'release') || versions[0];
    const instanceSelect = isPack ? '<p class="hint">This modpack creates its own instance.</p>' :
      field('Install into', '<select id="install-target">' + option('', 'Choose an instance', target) +
        data.instances.map(item => option(item.id, item.name, target)).join('') + '</select>');
    const versionSelect = selected ? field('Content version', '<select id="project-version">' + versions.map(version =>
      option(version.id, version.version_number + ' · ' + version.game_versions.slice(0, 3).join(', '), selected.id)).join('') + '</select>') :
      '<p class="hint">No compatible versions are available for this instance.</p>';
    showDialog(project.title, '<p class="detail-text">' + esc(project.description) + '</p>' + instanceSelect + versionSelect +
      '<div class="row project-install-result" hidden><span role="status"></span>' +
      button('Open instance', 'arrow-up-right', 'installed-instance') + '</div>' +
      '<div id="modal-catalog-progress" data-job="' + esc(jobId) + '"></div>',
      button('View on Modrinth', 'external-link', 'open-modrinth', { id: project.project_type + '/' + project.slug }) +
      button(isPack ? 'Install modpack' : 'Install', 'download', 'install-content', {
        id: project.id, style: 'primary', disabled: !selected || (!isPack && !target)
      }), count.format(project.downloads || 0) + ' downloads', image(project.icon_url, 'package', 'project-icon detail-logo'));
    const select = $('#install-target', modal);
    if (select) select.onchange = () => projectDialog(slug, select.value);
    const version = $('#project-version', modal);
    if (version) {
      version.onchange = () => {
        const installed = isPack ? data.instances.find(item => item.modpack?.project === project.id && item.modpack.version === version.value) :
          itemById(target)?.content.find(entry => entry.project === project.id && entry.version === version.value);
        const result = $('.project-install-result', modal);
        result.hidden = !installed;
        $('[role=status]', result).textContent = installed?.shared ? 'Installed in shared files' : 'Installed';
        const open = $('button', result);
        open.hidden = !isPack || !installed;
        open.dataset.id = isPack ? installed?.id || '' : '';
        const install = $('[data-action=install-content]', modal);
        const busy = downloadPending(jobId);
        install.disabled = busy || (!isPack && (!target || Boolean(installed)));
        if (select) select.disabled = busy;
        version.disabled = busy;
        const label = busy ? 'Installing…' : installed ? isPack ? 'Install another copy' : 'Installed' : isPack ? 'Install modpack' : 'Install';
        install.innerHTML = svg(installed && !isPack && !busy ? 'check' : 'download') + label;
      };
      version.onchange();
    }
    refreshDownloads();
  } catch (error) {
    if (modal.open && sequence === projectSequence) modalError(error);
  }
}

function downloadId(project, target = '') {
  return target + '/' + project;
}
function downloadPending(id) {
  return downloads.has(id) || startingDownloads.has(id);
}
function refreshDownloads() {
  const queue = $('#catalog-progress');
  if (queue) queue.innerHTML = [...downloads.values()].map(job =>
    progressHtml((job.title ? job.title + ' · ' : '') + job.message)).join('');
  const current = $('#modal-catalog-progress', modal);
  if (current) current.innerHTML = progressHtml(downloads.get(current.dataset.job)?.message);
  $('#project-version', modal)?.dispatchEvent(new Event('change'));
  for (const install of document.querySelectorAll('[data-action=quick-install]')) {
    const isPack = install.dataset.type === 'modpack';
    const target = isPack ? '' : discover.instance;
    const installed = itemById(target)?.content.some(entry => entry.project === install.dataset.id);
    const busy = downloadPending(downloadId(install.dataset.id, target));
    const label = busy ? 'Installing…' : installed ? 'Installed' : 'Install';
    install.disabled = busy || installed || (!target && !isPack);
    install.innerHTML = svg(installed ? 'check' : 'download') + label;
    install.setAttribute('aria-label', label + ' ' + install.dataset.title);
    if (!target && !isPack) install.title = 'Choose an instance from the filter to install content.';
  }
}

async function installContent(project, version, target) {
  const id = downloadId(project, target);
  if (downloadPending(id)) return;
  startingDownloads.add(id);
  refreshDownloads();
  try {
    const result = await api.installProject(project, version, target);
    await refresh(false);
    if (page === 'discover') {
      const compatible = $('#compatible');
      if (compatible) compatible.innerHTML = option('', 'All versions', discover.instance) +
        data.instances.map(item => option(item.id, item.name, discover.instance)).join('');
    } else if (page === 'library' || page === 'instance') {
      render();
    }
    toast('Installed ' + result.name);
  } finally {
    startingDownloads.delete(id);
    refreshDownloads();
  }
}

async function action(name, id, control) {
  const item = itemById(id);
  switch (name) {
    case 'dismiss-toast': control.closest('.toast').remove(); break;
    case 'close-dialog': ++projectSequence; modal.close(); break;
    case 'close-signin': signin.close(); break;
    case 'library': navigate('library'); break;
    case 'discover': discover.instance = ''; navigate('discover'); break;
    case 'discover-for': discover.instance = id; discover.offset = 0; discover.type = item.loader === 'vanilla' ? 'resourcepack' : 'mod'; navigate('discover'); break;
    case 'category': discover.type = id; discover.offset = 0; discoverPage(); break;
    case 'next': discover.offset += 18; await loadSearch(); main.scrollTop = 0; break;
    case 'previous': discover.offset = Math.max(0, discover.offset - 18); await loadSearch(); main.scrollTop = 0; break;
    case 'retry-search': await loadSearch(); break;
    case 'create': createDialog(); break;
    case 'view-instance': activeItem = id; navigate('instance'); break;
    case 'installed-instance':
      modal.close();
      activeItem = id;
      navigate('instance');
      break;
    case 'edit': editDialog(item); break;
    case 'folder': await api.folder(id); break;
    case 'delete-instance': confirmDialog('Delete ' + item.name + '?', 'The instance folder and its worlds will be moved to the Recycle Bin.', 'Delete instance', 'delete-confirmed', id); break;
    case 'delete-confirmed':
      control.disabled = true;
      await api.delete(id);
      if (discover.instance === id) discover.instance = '';
      modal.close();
      await refresh(false);
      navigate('library');
      toast('Deleted ' + item.name);
      break;
    case 'install-game':
      control.disabled = true;
      try {
        await api.installGame(id, Boolean(item.installed));
        await refresh();
        toast('Game files ready');
      } finally {
        control.disabled = false;
      }
      break;
    case 'play':
      if (!data.account) return showAccounts();
      control.disabled = true;
      try {
        await api.play(id);
        await refresh();
      } finally {
        control.disabled = false;
      }
      break;
    case 'stop': await api.stop(id); break;
    case 'signin': showAccounts(); break;
    case 'add-account': openSignIn(''); break;
    case 'reconnect-account': openSignIn(id); break;
    case 'select-account':
      await api.selectAccount(id);
      modal.close();
      await refresh();
      toast('Using ' + data.account.name);
      break;
    case 'remove-account': {
      const profile = data.accounts.find(entry => entry.id === id);
      confirmDialog('Remove ' + profile.name + '?', 'This clears that account’s saved sign-in from Relay.', 'Remove', 'remove-account-confirmed', id);
      break;
    }
    case 'start-signin': await beginSignIn(); break;
    case 'copy-code': await api.copyCode(authCode?.userCode); toast('Code copied'); break;
    case 'open-code': await api.openCode(); break;
    case 'remove-account-confirmed':
      await api.removeAccount(id);
      modal.close();
      await refresh();
      if (data.accounts.length) showAccounts();
      break;
    case 'project': await projectDialog(id, page === 'discover' ? discover.instance : ''); break;
    case 'open-modrinth': await api.open('https://modrinth.com/' + id); break;
    case 'install-content': await installContent(id, $('#project-version', modal).value, $('#install-target', modal)?.value || ''); break;
    case 'quick-install': await installContent(id, null, control.dataset.type === 'modpack' ? '' : discover.instance); break;
    case 'remove-content': {
      const entry = itemById(activeItem).content.find(entry => entry.project === id);
      const message = entry.shared ? 'This removes the downloaded file from all instances using the shared folder.' :
        'Relay will remove its downloaded file from this instance.';
      confirmDialog('Remove ' + entry.name + '?', message, 'Remove', 'remove-confirmed', id);
      break;
    }
    case 'remove-confirmed':
      control.disabled = true;
      await api.removeProject(activeItem, id);
      modal.close();
      await refresh();
      toast('Content removed');
      break;
    case 'choose-instance-icon': {
      const form = control.closest('form');
      control.disabled = true;
      try {
        const picked = await api.chooseInstanceIcon();
        if (picked && form.isConnected && modal.open) previewInstanceIcon(form, picked);
      } finally {
        control.disabled = false;
      }
      break;
    }
    case 'reset-instance-icon': previewInstanceIcon(control.closest('form'), ''); break;
    case 'pick-java': {
      const picked = await api.java();
      if (picked) {
        const field = control.parentElement.querySelector('input');
        field.value = picked;
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }
      break;
    }
    case 'test-sound': playTone('success', Number($('#settings-form').elements.volume.value)); break;
    case 'shared-folder': await api.openSharedFolder(); break;
    case 'check-update':
      await api.checkUpdates();
      if (page !== 'settings') navigate('settings');
      break;
    case 'github': await api.open('https://github.com/NoobIsADev/Relay/releases'); break;
  }
}

api.onEvent(event => {
  if (event.type === 'auth-code') {
    authCode = event;
    if (signin.open) showSignIn();
  }
  if (event.type === 'progress') {
    if (event.message) progress.set(event.id, event.message);
    else progress.delete(event.id);
    if (page === 'library' || page === 'instance') {
      const node = $('#game-progress');
      if (event.message && node?.firstElementChild) node.innerHTML = progressHtml(event.message);
      else render();
    }
  }
  if (event.type === 'catalog-progress') {
    if (event.finished) downloads.delete(event.job.id);
    else downloads.set(event.job.id, event.job);
    refreshDownloads();
  }
  if (event.type === 'game-start' || event.type === 'game-exit') {
    refresh(page !== 'settings').catch(error => toast(errorText(error), 'error'));
    if (event.type === 'game-start') toast('Starting ' + event.name);
    else if (event.error || (event.code !== 0 && event.code !== null)) {
      toast('Minecraft closed unexpectedly. Open the instance folder for the launch log.', 'error');
    }
  }
  if (event.type === 'update' && data) {
    data.update = event;
    refreshChrome();
    if ($('#update-message')) $('#update-message').textContent = event.message;
    if ($('#update-controls')) $('#update-controls').innerHTML = updateControls();
    if (event.state === 'scheduled') toast(event.message);
  }
  if (event.type === 'busy-close') toast('Wait for the current installation to finish before closing Relay.', 'error');
});

document.addEventListener('click', event => {
  const control = event.target.closest('button');
  if (!control || control.disabled || !data) return;
  if (control.dataset.window) api.window(control.dataset.window);
  if (control.dataset.page) {
    applySavedTheme();
    navigate(control.dataset.page);
  }
  if (control.id === 'account') showAccounts();
  if (control.dataset.action) {
    action(control.dataset.action, control.dataset.id, control).catch(error => {
      control.disabled = false;
      if (modal.open && control.closest('dialog') === modal) modalError(error);
      else if (signin.open) modalError(error, signin);
      else toast(errorText(error), 'error');
    });
  }
});
for (const node of document.querySelectorAll('[data-icon]')) node.outerHTML = svg(node.dataset.icon);
for (const node of document.querySelectorAll('[data-window]')) {
  node.innerHTML = svg({ minimize: 'minus', maximize: 'square', close: 'x' }[node.dataset.window]);
}
systemTheme.addEventListener('change', () => { if (data) applySavedTheme(); });
refresh().catch(error => {
  main.innerHTML = '<div class="shell">' + empty('circle-alert', 'Relay could not open your library', errorText(error)) + '</div>';
});
