const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.join(__dirname, '..');
const repo = 'NoobIsADev/Relay';
const manifest = path.join(root, 'package.json');
const release = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const tracked = ['.github', '.gitignore', 'README.md', 'PUSH-AND-RELEASE.bat', 'package.json', 'package-lock.json', 'assets', 'scripts', 'src'];

function command(executable, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(executable, args, {
    cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true, maxBuffer: 8 * 1024 ** 2
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(executable + ' ' + args.slice(0, 2).join(' ') + ' failed. ' + (result.stderr || '').trim());
  }
  return capture ? result : result.status;
}
const git = (...args) => command('git', args);
const gitValue = (...args) => command('git', args, { capture: true }).stdout.trim();
const gh = (...args) => command('gh', args);
const ghValue = (...args) => command('gh', args, { capture: true }).stdout.trim();
const npm = (...args) => command(process.execPath, [process.env.npm_execpath, ...args]);

function releaseInfo(tag) {
  const result = command('gh', ['release', 'view', tag, '-R', repo, '--json', 'isDraft,tagName'], {
    capture: true, allowFailure: true
  });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/release not found|HTTP 404/i.test(result.stderr)) return null;
  throw new Error(result.stderr.trim() || 'Could not check GitHub Releases.');
}

function prepare(projectVersion, requested, hasRelease) {
  const [major, minor, patch] = projectVersion.split('.').map(Number);
  if (!requested) return hasRelease ? [major, minor, patch + 1].join('.') : projectVersion;
  if (requested === 'current') return projectVersion;
  if (requested === 'patch') return [major, minor, patch + 1].join('.');
  if (requested === 'minor') return [major, minor + 1, 0].join('.');
  if (requested === 'major') return [major + 1, 0, 0].join('.');
  return requested;
}
function compare(first, second) {
  const a = first.split('.').map(Number);
  const b = second.split('.').map(Number);
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}

function verifyUpdateFiles(directory, version, artifact, channel) {
  const update = fs.readFileSync(path.join(directory, channel), 'utf8');
  const hash = createHash('sha512').update(fs.readFileSync(path.join(directory, artifact))).digest('base64');
  if (!update.includes('version: ' + version) || !update.includes('url: ' + artifact) ||
      !update.includes('sha512: ' + hash)) {
    throw new Error(artifact + ' and ' + channel + ' do not match.');
  }
}

async function buildLinux(tag, head, version, dist) {
  const trigger = 'repos/' + repo + '/actions/workflows/build-linux.yml/dispatches';
  const run = JSON.parse(ghValue('api', '--method', 'POST', trigger, '-H', 'X-GitHub-Api-Version: 2026-03-10',
    '-f', 'ref=' + tag, '-F', 'return_run_details=true'));
  const id = String(run.workflow_run_id);
  if (!/^\d+$/.test(id)) throw new Error('GitHub did not return the Linux build ID.');
  console.log('Building Linux AppImage on GitHub Actions: ' + run.html_url);
  for (let attempt = 0; ; attempt++) {
    const check = command('gh', ['run', 'view', id, '-R', repo, '--json', 'headSha', '--jq', '.headSha'],
      { capture: true, allowFailure: true });
    if (check.status === 0) {
      if (check.stdout.trim() !== head) throw new Error('The AppImage was built from a different commit.');
      break;
    }
    if (attempt >= 5 || !/HTTP 404/i.test(check.stderr)) throw new Error(check.stderr.trim());
    await delay(3000);
  }
  gh('run', 'watch', id, '-R', repo, '--interval', '10', '--exit-status');

  const image = 'Relay-' + version + '-x86_64.AppImage';
  const channel = 'latest-linux.yml';
  const staging = fs.mkdtempSync(path.join(dist, '.linux-'));
  try {
    gh('run', 'download', id, '-R', repo, '--name', 'relay-linux-x64', '--dir', staging);
    verifyUpdateFiles(staging, version, image, channel);
    for (const asset of [image, channel]) fs.renameSync(path.join(staging, asset), path.join(dist, asset));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return [image, channel];
}

async function publish() {
  if (!process.env.npm_execpath) throw new Error('Run PUSH-AND-RELEASE.bat or npm run release.');
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const requested = args.find(value => value !== '--dry-run');
  if (args.filter(value => value !== '--dry-run').length > 1 ||
      (requested && !['current', 'patch', 'minor', 'major'].includes(requested) && !release.test(requested))) {
    throw new Error('Use PUSH-AND-RELEASE.bat [current|patch|minor|major|x.y.z] [--dry-run].');
  }
  const projectVersion = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  if (!release.test(projectVersion)) throw new Error('Use a stable x.y.z version in package.json.');
  const remote = gitValue('remote', 'get-url', 'origin');
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:)NoobIsADev\/Relay(?:\.git)?$/i.test(remote)) {
    throw new Error('Run this from a clone of github.com/' + repo + ' with the repository as origin.');
  }
  if (gitValue('branch', '--show-current') !== 'main') throw new Error('Check out the main branch to publish.');
  const before = releaseInfo('v' + projectVersion);
  const version = prepare(projectVersion, requested, before && !before.isDraft);
  if (!release.test(version) || compare(version, projectVersion) < 0) throw new Error('Choose the current version or a higher version.');
  const tag = 'v' + version;
  const existing = version === projectVersion ? before : releaseInfo(tag);
  if (existing && !existing.isDraft) throw new Error(tag + ' is already published. Choose a higher version.');
  const latest = ghValue('release', 'list', '-R', repo, '--limit', '100', '--json', 'tagName,isDraft,isPrerelease');
  const newer = JSON.parse(latest).find(item => !item.isDraft && !item.isPrerelease &&
    release.test(item.tagName.slice(1)) && compare(item.tagName.slice(1), version) >= 0);
  if (newer) throw new Error('Choose a version higher than ' + newer.tagName + ' for automatic updates.');
  if (dryRun) {
    console.log('Ready to build and publish Windows and Linux ' + tag + ' to ' + repo + '.');
    return;
  }

  const alreadyStaged = gitValue('diff', '--cached', '--name-only');
  if (alreadyStaged) throw new Error('Commit or unstage the existing staged changes before publishing.');
  git('fetch', 'origin', 'main');
  git('merge-base', '--is-ancestor', 'origin/main', 'HEAD');
  if (version !== projectVersion) npm('version', version, '--no-git-tag-version');
  npm('ci', '--no-fund');
  npm('run', 'check');
  npm('run', 'dist');

  const dist = path.join(root, 'dist');
  const setupName = 'Relay-Setup-' + version + '.exe';
  const windows = [setupName, setupName + '.blockmap', 'latest.yml'];
  verifyUpdateFiles(dist, version, setupName, 'latest.yml');
  if (!fs.statSync(path.join(dist, windows[1])).size) throw new Error('The Windows installer blockmap is empty.');

  git('add', '--', ...tracked);
  if (gitValue('diff', '--cached', '--name-only')) git('commit', '-m', 'Release Relay ' + version);
  const head = gitValue('rev-parse', 'HEAD');
  if (existing) {
    const ref = ghValue('api', 'repos/' + repo + '/git/ref/tags/' + tag, '--jq', '.object.sha');
    if (ref !== head) throw new Error('The existing draft tag points to a different commit.');
  }
  git('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', 'HEAD:main');
  if (!existing) {
    // Create the tag explicitly so interrupted draft uploads can be retried.
    const remoteTag = gitValue('ls-remote', 'origin', 'refs/tags/' + tag);
    if (remoteTag && remoteTag.split(/\s+/)[0] !== head) throw new Error('The remote tag points to a different commit.');
    if (!remoteTag) git('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      'push', 'origin', head + ':refs/tags/' + tag);
  }
  const linux = await buildLinux(tag, head, version, dist);
  const artifacts = [...windows, ...linux].map(name => path.join(dist, name));
  if (!existing) gh('release', 'create', tag, '-R', repo, '--verify-tag', '--draft', '--title', 'Relay ' + version, '--generate-notes');
  gh('release', 'upload', tag, ...artifacts, '-R', repo, '--clobber');
  gh('release', 'edit', tag, '-R', repo, '--draft=false', '--latest');
  console.log('Published https://github.com/' + repo + '/releases/tag/' + tag);
}

publish().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
