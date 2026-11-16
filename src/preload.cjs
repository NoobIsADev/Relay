const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke('relay:' + channel, ...args);

contextBridge.exposeInMainWorld('relay', {
  state: () => invoke('state'),
  versions: () => invoke('versions'),
  loaders: (loader, minecraft) => invoke('loaders', loader, minecraft),
  create: data => invoke('instance:create', data),
  edit: (id, data) => invoke('instance:edit', id, data),
  chooseInstanceIcon: () => invoke('instance:choose-icon'),
  folder: id => invoke('instance:folder', id),
  delete: id => invoke('instance:delete', id),
  installGame: (id, repair) => invoke('game:install', id, repair),
  play: id => invoke('game:play', id),
  stop: id => invoke('game:stop', id),
  search: data => invoke('catalog:search', data),
  project: (slug, id) => invoke('catalog:details', slug, id),
  installProject: (slug, version, id) => invoke('catalog:install', slug, version, id),
  removeProject: (id, project) => invoke('catalog:remove', id, project),
  signIn: id => invoke('account:sign-in', id),
  selectAccount: id => invoke('account:select', id),
  removeAccount: id => invoke('account:remove', id),
  openCode: () => invoke('account:browser'),
  copyCode: code => invoke('account:copy', code),
  settings: data => invoke('settings:save', data),
  openSharedFolder: () => invoke('settings:shared-folder'),
  java: () => invoke('settings:java'),
  checkUpdates: () => invoke('updates:check'),
  window: action => invoke('window:action', action),
  open: url => invoke('open:link', url),
  onEvent(listener) {
    ipcRenderer.on('relay:event', (_event, data) => listener(data));
  }
});
