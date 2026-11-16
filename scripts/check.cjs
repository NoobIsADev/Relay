const { spawnSync } = require('node:child_process');
const { readdirSync, existsSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
for (const directory of ['src', 'scripts']) {
  for (const name of readdirSync(path.join(root, directory))) {
    if (!/\.[cm]?js$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, name)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
for (const asset of ['logo.png', 'relay.ico', 'river.jpg', 'Inter.woff2', 'icons/play.svg']) {
  if (!existsSync(path.join(root, 'assets', asset))) {
    throw new Error('Required asset missing: ' + asset);
  }
}
console.log('Relay source and assets checked.');
