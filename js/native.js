// The Android app is these same files inside a native wrapper (Capacitor; see
// android/). The wrapper adds what a web page cannot do, and this module is
// the only place that talks to it:
//
//   postJson   an HTTP request made by Android rather than by the page, so the
//              browser's cross-site rule does not apply. This is what lets the
//              app call Plaid directly with nothing hosted in between.
//   secure     small secrets encrypted with a key held in the Android Keystore.
//   openLink   Plaid Link through Plaid's Android SDK.
//   saveFile   Android's "save to" screen, for backups and exports.
//   update     the app updating itself from its GitHub release.
//
// In a browser none of it exists: isNative() is false and nothing here is used.

const cap = () => globalThis.Capacitor;
export const isNative = () => !!cap()?.isNativePlatform?.();

async function native(plugin, method, options = {}) {
  try { return await cap().nativePromise(plugin, method, options); }
  catch (e) {
    if (e instanceof Error) throw e;
    const err = new Error(e?.message || e?.errorMessage || String(e));
    err.code = e?.code || null;
    throw err;
  }
}

// POSTs JSON and resolves { status, data }, whatever the status. Rejects only
// when the request could not be made at all.
export async function postJson(url, body) {
  const r = await native('CapacitorHttp', 'request', {
    method: 'POST', url, headers: { 'Content-Type': 'application/json' }, data: body, responseType: 'json',
  });
  let data = r.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = {}; } }
  return { status: r.status, data: data || {} };
}

export const secure = {
  async get(key) {
    const raw = (await native('SecureStore', 'get', { key })).value;
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },
  set: (key, value) => native('SecureStore', 'set', { key, value: JSON.stringify(value) }),
  remove: key => native('SecureStore', 'remove', { key }),
};

// The app's Android package name, which a Plaid link token has to carry so a
// bank's own sign-in page knows which app to come back to.
export const packageName = async () => (await native('PlaidLink', 'packageName')).packageName;

// Resolves { public_token, institution }, or null if Link was closed.
export async function openLink(token) {
  const r = await native('PlaidLink', 'open', { token });
  if (r.publicToken) return { public_token: r.publicToken, institution: r.institution || 'Bank' };
  if (r.errorMessage || r.errorCode) {
    const e = new Error(r.errorMessage || `Plaid closed with ${r.errorCode}.`);
    e.code = r.errorCode || null;
    throw e;
  }
  return null;
}

// GETs JSON through Android, as postJson. Resolves the parsed body or rejects.
export async function getJson(url) {
  const r = await native('CapacitorHttp', 'request', { method: 'GET', url, headers: { 'Cache-Control': 'no-cache' }, responseType: 'json' });
  if (r.status < 200 || r.status >= 300) throw new Error(`The server answered ${r.status}.`);
  let data = r.data;
  if (typeof data === 'string') data = JSON.parse(data);
  return data;
}

// ── Updating the app ──
// Every build from main is published as the android-latest release with a
// version.json beside the APK. The app compares its own version code with it.
export const RELEASE = 'https://github.com/jsandhagen/FinanceTracker/releases/download/android-latest/';

// The newer build described by `remote` (version.json), or null when `current`
// (the installed app's info) is as new or newer, or the answer is not usable.
export function newerBuild(remote, current) {
  const code = Number(remote?.versionCode), have = Number(current?.versionCode);
  if (!Number.isFinite(code) || !Number.isFinite(have) || code <= have) return null;
  const apk = String(remote.apk || 'FinanceTracker.apk');
  if (!/^[\w.-]+\.apk$/.test(apk)) return null;
  return { versionCode: code, versionName: String(remote.versionName || code), url: RELEASE + apk };
}

export const update = {
  info: () => native('AppUpdate', 'info'),
  async check() {
    const [remote, current] = await Promise.all([getJson(RELEASE + 'version.json'), update.info()]);
    return { current, newer: newerBuild(remote, current) };
  },
  allowInstalls: () => native('AppUpdate', 'allowInstalls'),
  install: url => native('AppUpdate', 'install', { url }),
};

// Resolves true when the file was written, false if the screen was closed.
export const saveFile = async (name, mime, text) => (await native('SaveFile', 'save', { name, mime, text })).saved === true;
