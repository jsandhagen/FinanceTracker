// The Android app updating itself: deciding whether the release is newer, and
// asking a stand-in for Android. Nothing here touches the network.
import * as N from '../js/native.js';
import assert from 'node:assert/strict';

const have = { versionCode: 14, versionName: '427c01f-202611110054' };
const url = N.RELEASE + 'FinanceTracker.apk';

// Only a higher version code is an update.
assert.deepEqual(N.newerBuild({ versionCode: 15, versionName: 'abc1234-202611120000', apk: 'FinanceTracker.apk' }, have),
  { versionCode: 15, versionName: 'abc1234-202611120000', url });
assert.equal(N.newerBuild({ versionCode: 14, apk: 'FinanceTracker.apk' }, have), null, 'the same build');
assert.equal(N.newerBuild({ versionCode: 9, apk: 'FinanceTracker.apk' }, have), null, 'an older build');
assert.equal(N.newerBuild({ versionCode: '16' }, have).url, url, 'a code written as text, and the default file name');
assert.equal(N.newerBuild(null, have), null);
assert.equal(N.newerBuild({ versionCode: 'x' }, have), null);
assert.equal(N.newerBuild({ versionCode: 20 }, {}), null, 'unknown installed version: offer nothing');
// The download stays on this repository's release: no other file, no other place.
assert.equal(N.newerBuild({ versionCode: 20, apk: '../../evil/x.apk' }, have), null);
assert.equal(N.newerBuild({ versionCode: 20, apk: 'https://evil.example/x.apk' }, have), null);
assert.ok(N.RELEASE.startsWith('https://github.com/jsandhagen/FinanceTracker/releases/download/'));

// The check, against a stand-in for Android.
const calls = [];
let remote = { versionCode: 15, versionName: 'abc1234-202611120000', apk: 'FinanceTracker.apk' };
globalThis.Capacitor = {
  isNativePlatform: () => true,
  async nativePromise(plugin, method, o) {
    calls.push([plugin, method, o]);
    if (plugin === 'CapacitorHttp') return { status: 200, data: JSON.stringify(remote) }; // as text, as GitHub may send it
    if (plugin === 'AppUpdate' && method === 'info') return { ...have, canInstall: true };
    if (plugin === 'AppUpdate' && method === 'install') return undefined;
    throw { message: `no ${plugin}.${method}` };
  },
};
const r = await N.update.check();
assert.equal(r.newer.versionCode, 15);
assert.equal(calls[0][2].url, N.RELEASE + 'version.json');
assert.equal(calls[0][2].method, 'GET');
await N.update.install(r.newer.url);
assert.deepEqual(calls.at(-1), ['AppUpdate', 'install', { url }]);
remote = { versionCode: 14 };
assert.equal((await N.update.check()).newer, null, 'up to date');
// A failed request is an error, not "up to date".
globalThis.Capacitor.nativePromise = async plugin => (plugin === 'CapacitorHttp' ? { status: 404, data: 'Not Found' } : { ...have });
await assert.rejects(N.update.check(), /404/);
delete globalThis.Capacitor;

// ── What keeps the data through every update ──
// The app's data lives under its origin (https://localhost) and its package
// id. Changing either makes an updated app start empty, so they are pinned and
// checked here. An update is also kept from wiping or skipping data on Android.
{
  const { readFileSync } = await import('node:fs');
  const cfg = JSON.parse(readFileSync(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.equal(cfg.appId, 'io.github.jsandhagen.financetracker', 'the package id is the app: changing it is a different app with no data');
  assert.equal(cfg.server?.androidScheme, 'https', 'pinned: a different scheme is a different, empty origin');
  assert.equal(cfg.server?.hostname, 'localhost', 'pinned: a different hostname is a different, empty origin');
  assert.ok(!cfg.server?.url, 'the app loads its own files, not a website (a different origin, and the keys would be readable by it)');
  const gradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
  assert.match(gradle, /applicationId "io\.github\.jsandhagen\.financetracker"/);
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /android:hasFragileUserData="true"/, 'Android offers to keep the data on uninstall');
  assert.match(manifest, /android:allowBackup="false"/, 'no Google backup restoring data whose Keystore key did not come with it');
  const wf = readFileSync(new URL('../.github/workflows/android.yml', import.meta.url), 'utf8');
  assert.match(wf, /EXPECTED_CERT: c54dffdebc0d806fd3f6ccf98ccf9faffb7377f5d769bd54d2f3291a08d4aa7d/, 'only builds signed like the installed app are published');
  assert.match(wf, /is not above the published/, 'and only builds numbered above the last');
}

console.log('native tests passed');
