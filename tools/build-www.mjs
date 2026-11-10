// Copies the web app into www/, which is what the Android wrapper bundles.
// The web app has no build step; this only gathers the files a device needs
// (the same list the service worker caches) and stamps the build, the way the
// Pages deploy does. Usage: node tools/build-www.mjs [build-label]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 12);
let build = process.argv[2];
if (!build) {
  try { build = `${execSync('git rev-parse --short=7 HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()}-${stamp()}`; }
  catch { build = `local-${stamp()}`; }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const p of ['index.html', 'manifest.webmanifest', 'css', 'js', 'vendor', 'icons']) {
  cpSync(join(root, p), join(out, p), { recursive: true });
}
const version = join(out, 'js', 'version.js');
writeFileSync(version, readFileSync(version, 'utf8').replace('__BUILD__', build));
console.log(`www/ ready, build ${build}`);
