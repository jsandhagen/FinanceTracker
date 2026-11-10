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
//
// In a browser none of it exists: isNative() is false and nothing here is used.

const cap = () => globalThis.Capacitor;
export const isNative = () => !!cap()?.isNativePlatform?.();

async function native(plugin, method, options = {}) {
  try { return await cap().nativePromise(plugin, method, options); }
  catch (e) { throw e instanceof Error ? e : new Error(e?.message || e?.errorMessage || String(e)); }
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

// Resolves true when the file was written, false if the screen was closed.
export const saveFile = async (name, mime, text) => (await native('SaveFile', 'save', { name, mime, text })).saved === true;
