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

console.log('native tests passed');
