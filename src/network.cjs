const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform, Readable } = require('node:stream');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const userAgent = 'NoobIsADev/Relay (https://github.com/NoobIsADev/Relay)';
const metadata = new Map();

async function getJson(url, { cache = 0, headers } = {}) {
  const saved = metadata.get(url);
  if (cache && saved?.until > Date.now()) return saved.value;
  const res = await fetch(url, {
    headers: { 'User-Agent': userAgent, ...headers },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) {
    const error = new Error(new URL(url).hostname + ' returned HTTP ' + res.status + '.');
    error.status = res.status;
    throw error;
  }
  const value = await res.json();
  if (cache) {
    if (metadata.size >= 180) metadata.delete(metadata.keys().next().value);
    metadata.set(url, { value, until: Date.now() + cache });
  }
  return value;
}

function downloadUrl(raw, hosts) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !hosts.includes(url.hostname)) throw new Error('Download host is unavailable for this file.');
  return url;
}

async function download(raw, target, { hosts, size, hashes = {}, max = 1024 ** 3 }) {
  let url = downloadUrl(raw, hosts);
  const signal = AbortSignal.timeout(180000);
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetch(url, { headers: { 'User-Agent': userAgent }, redirect: 'manual', signal });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error('Too many download redirects.');
    url = downloadUrl(new URL(location, url), hosts);
  }
  if (!response.ok || !response.body) throw new Error('Download failed (HTTP ' + response.status + ').');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = target + '.' + randomUUID() + '.part';
  const checks = Object.entries(hashes).filter(([algorithm, value]) =>
    (algorithm === 'sha1' || algorithm === 'sha512') && typeof value === 'string'
  ).map(([algorithm, value]) => [createHash(algorithm), value]);
  let count = 0;
  try {
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        count += chunk.length;
        if (count > max || (size !== undefined && count > size)) return callback(new Error('Download exceeds its declared size.'));
        for (const [hash] of checks) hash.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(temp, { flags: 'wx' }));
    if ((size !== undefined && count !== size) || checks.some(([hash, value]) => hash.digest('hex') !== value.toLowerCase())) {
      throw new Error('Download integrity check failed.');
    }
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

module.exports = { download, getJson };
