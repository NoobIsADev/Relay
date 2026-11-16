const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron: electron } = require('playwright');

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await predicate()) return;
    await delay(1500);
  }
  throw new Error('The installed launcher did not reopen.');
}

function powershell(executable, command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, RELAY_SMOKE_EXE: executable }, encoding: 'utf8', windowsHide: true
  }).trim();
}

(async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'relay-nsis-smoke-'));
  const directory = path.join(root, 'installed');
  const executable = path.join(directory, 'Relay.exe');
  const archive = path.join(directory, 'resources', 'app.asar');
  const marker = path.join(root, 'install-arguments.json');
  const installer = path.resolve(process.argv[2]);
  const findWindows = 'Get-Process Relay -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:RELAY_SMOKE_EXE }';
  const isOpen = () => powershell(executable, findWindows + ' | Where-Object MainWindowTitle | Select-Object -First 1 -ExpandProperty Id');
  const stopTestApp = () => powershell(executable, findWindows + ' | Stop-Process -Force -ErrorAction SilentlyContinue');

  // Deliberately omit /S for first setup to catch an interactive installer wizard.
  const firstInstall = spawnSync(installer, ['/D=' + directory], { timeout: 90000, windowsHide: true });
  assert.equal(firstInstall.status, 0, firstInstall.error?.message || 'Initial setup failed.');
  await waitUntil(isOpen);
  stopTestApp();
  await fs.utimes(archive, 2000, 2000);
  console.log('One-click setup installed and opened Relay without input.');

  const app = await electron.launch({ executablePath: executable, args: ['--user-data-dir=' + path.join(root, 'profile')] });
  let closed = false;
  try {
    await app.evaluate(({ app }, marker) => {
      const path = process.getBuiltinModule('path');
      const { createRequire } = process.getBuiltinModule('module');
      const load = createRequire(path.join(app.getAppPath(), 'package.json'));
      const { autoUpdater } = load('electron-updater');
      autoUpdater.currentVersion = load('semver').parse('0.0.0');
      const apply = autoUpdater.quitAndInstall.bind(autoUpdater);
      autoUpdater.quitAndInstall = (...args) => {
        process.getBuiltinModule('fs').writeFileSync(marker, JSON.stringify(args));
        apply(...args);
      };
    }, marker);
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: 'Your library' }).waitFor();
    await app.waitForEvent('close', { timeout: 120000 });
    closed = true;
    assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), [true, true]);
    await waitUntil(async () => {
      const modified = await fs.stat(archive).then(info => info.mtimeMs > 2000000, () => false);
      return modified && isOpen();
    });
    console.log('Relay silently installed its GitHub update over the existing install and reopened automatically.');
  } finally {
    if (!closed) await app.close().catch(() => {});
    stopTestApp();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
