const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');

async function testJava(root) {
  const { openStore } = require('../src/storage.cjs');
  const { createGame } = require('../src/game.cjs');
  const store = await openStore(root);
  const id = randomUUID();
  await store.change(state => {
    state.instances.push({ id, name: 'Linux smoke test', minecraft: '1.21.1', loader: 'vanilla' });
  });
  await createGame(root, store, event => { if (event.message) console.log(event.message); }).perform(id, null);
  assert.equal(store.instance(id).installed, '1.21.1');
  const runtime = path.join(root, 'java', 'java-runtime-delta');
  const [release] = await fs.readdir(runtime);
  execFileSync(path.join(runtime, release, 'bin', 'java'), ['-version'], { stdio: 'inherit' });
}

async function testAppImage(root, file) {
  const { _electron: electron } = require('playwright');
  const testingUpdate = process.env.VERIFY_UPDATE === 'true';
  if (testingUpdate) {
    const target = path.join(root, path.basename(file));
    await fs.copyFile(file, target);
    await fs.chmod(target, 0o755);
    await fs.utimes(target, 1, 1);
    file = target;
  }
  const app = await electron.launch({
    executablePath: path.resolve(file),
    args: ['--user-data-dir=' + root],
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1', XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_CONFIG_HOME: path.join(root, 'config') }
  });
  let closed = false;
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    await page.getByRole('heading', { name: 'Your library' }).waitFor();
    console.log('AppImage window opened.');
    if (testingUpdate) {
      await app.evaluate(({ app, dialog }) => {
        const path = process.getBuiltinModule('path');
        const { createRequire } = process.getBuiltinModule('module');
        const load = createRequire(path.join(app.getAppPath(), 'package.json'));
        const { autoUpdater } = load('electron-updater');
        autoUpdater.currentVersion = load('semver').parse('0.0.0');
        autoUpdater.autoInstallOnAppQuit = false;
        dialog.showOpenDialog = () => new Promise(resolve => {
          globalThis.finishPicker = () => resolve({ canceled: true, filePaths: [] });
        });
      });
    }
    const actualImage = await app.evaluate(() => process.env.APPIMAGE);
    assert.equal(await fs.realpath(actualImage), await fs.realpath(file));
    const state = await page.evaluate(() => window.relay.state());
    assert.equal(state.settings.theme, 'midnight');
    console.log('AppImage rendered Relay through its Linux entry point.');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('select[name=theme]').selectOption('graphite');
    await page.getByText('Saved automatically', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.relay.state().then(relay => relay.settings.theme)), 'graphite');

    if (testingUpdate) {
      await page.getByRole('button', { name: 'Browse', exact: true }).click();
      console.log('Holding updates while the Java file picker is open.');
      await page.getByText(/will install when Minecraft and current tasks finish/).waitFor({ timeout: 120000 });
      console.log('Update downloaded and waiting for the file picker.');
      assert.equal((await fs.stat(file)).mtimeMs, 1000);
      const restarted = app.waitForEvent('close', { timeout: 45000 });
      await app.evaluate(() => globalThis.finishPicker());
      await restarted;
      closed = true;
      assert.ok((await fs.stat(file)).mtimeMs > 1000);
      console.log('Relay checked for updates, waited for the file picker, and replaced the AppImage automatically.');
    }
  } finally {
    if (!closed) await app.close();
  }
}

(async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'relay-linux-smoke-'));
  try {
    if (process.argv[2] === '--java') await testJava(root);
    else await testAppImage(root, process.argv[2]);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 2 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
