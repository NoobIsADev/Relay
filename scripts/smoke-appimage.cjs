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
  const app = await electron.launch({
    executablePath: path.resolve(file),
    args: ['--user-data-dir=' + root],
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1', XDG_CACHE_HOME: path.join(root, 'cache') }
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: 'Your library' }).waitFor();
    const actualImage = await app.evaluate(() => process.env.APPIMAGE);
    assert.equal(await fs.realpath(actualImage), await fs.realpath(file));
    const state = await page.evaluate(() => window.relay.state());
    assert.equal(state.settings.theme, 'midnight');
    console.log('AppImage rendered Relay through its Linux entry point.');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('select[name=theme]').selectOption('graphite');
    await page.getByText('Saved automatically', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.relay.state().then(relay => relay.settings.theme)), 'graphite');

    if (process.env.VERIFY_UPDATE === 'true') {
      await app.evaluate(({ app }) => {
        const path = process.getBuiltinModule('path');
        const { createRequire } = process.getBuiltinModule('module');
        const load = createRequire(path.join(app.getAppPath(), 'package.json'));
        const { autoUpdater } = load('electron-updater');
        autoUpdater.currentVersion = load('semver').parse('0.0.0');
        autoUpdater.autoInstallOnAppQuit = false;
      });
      const check = page.getByRole('button', { name: 'Check for updates', exact: true });
      if (await check.isEnabled()) await check.click();
      await page.getByText('Relay ' + state.appVersion + ' is ready to install.', { exact: true }).first().waitFor({ timeout: 120000 });
      assert.equal(await page.evaluate(() => window.relay.state().then(relay => relay.update.state)), 'ready');
      console.log('The Linux updater downloaded the AppImage from GitHub Releases.');
    }
  } finally {
    await app.close();
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
