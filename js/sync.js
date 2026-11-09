// Optional sync between devices through one secret GitHub Gist.
//
// The gist only ever holds ciphertext: the data is encrypted in the browser
// with AES-GCM under a key derived (PBKDF2, 310k rounds) from a passphrase that
// never leaves the device. A secret gist is unlisted, not private, so this is
// what keeps the transactions unreadable to anyone who finds the URL.

const API = 'https://api.github.com';
const FILE = 'financetracker.enc.json';
const DESCRIPTION = 'FinanceTracker encrypted sync (do not edit)';
const ROUNDS = 310000;

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ROUNDS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Chunked so a large payload does not overflow the argument list of fromCharCode.
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function encrypt(obj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: bytesToB64(new Uint8Array(ct)) });
}

export async function decrypt(text, passphrase) {
  const env = JSON.parse(text);
  const key = await deriveKey(passphrase, unb64(env.salt));
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new Error('Wrong passphrase: the synced copy could not be decrypted.');
  }
}

async function gh(token, path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) throw new Error('GitHub rejected the token. Check that it is valid and has the "gist" scope.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return res.status === 204 ? null : res.json();
}

// Finds this app's gist among the user's gists, so a second device only needs
// the token and the passphrase.
export async function findGist(token) {
  for (let page = 1; page <= 10; page++) {
    const list = await gh(token, `/gists?per_page=100&page=${page}`);
    const hit = list.find(g => g.files && g.files[FILE]);
    if (hit) return hit.id;
    if (list.length < 100) return null;
  }
  return null;
}

export async function pull(token, gistId, passphrase) {
  const gist = await gh(token, `/gists/${gistId}`);
  const file = gist.files[FILE];
  if (!file) return null;
  // The API truncates file contents past ~1MB; the raw URL has the rest.
  const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return decrypt(text, passphrase);
}

export async function push(token, gistId, passphrase, snapshot) {
  const content = await encrypt(snapshot, passphrase);
  const body = JSON.stringify({ description: DESCRIPTION, files: { [FILE]: { content } } });
  if (gistId) {
    await gh(token, `/gists/${gistId}`, { method: 'PATCH', body });
    return gistId;
  }
  const created = await gh(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({ description: DESCRIPTION, public: false, files: { [FILE]: { content } } }),
  });
  return created.id;
}

export async function deleteGist(token, gistId) {
  await gh(token, `/gists/${gistId}`, { method: 'DELETE' });
}

// Transactions are only ever added, so both sides' are unioned. Rules can be
// deleted, so the newer rule set wins whole rather than being merged.
export function merge(local, remote) {
  const ids = new Set(local.transactions.map(t => t.id));
  const transactions = local.transactions.concat(remote.transactions.filter(t => !ids.has(t.id)));
  const remoteRulesNewer = (remote.meta?.rulesUpdatedAt || 0) > (local.meta.rulesUpdatedAt || 0);
  const remoteNewer = (remote.meta?.updatedAt || 0) > (local.meta.updatedAt || 0);
  return {
    transactions,
    rules: remoteRulesNewer ? remote.rules : local.rules,
    training: remoteRulesNewer ? remote.training : local.training,
    settings: remoteNewer ? { ...local.settings, ...remote.settings } : local.settings,
    meta: {
      updatedAt: Math.max(local.meta.updatedAt || 0, remote.meta?.updatedAt || 0),
      rulesUpdatedAt: Math.max(local.meta.rulesUpdatedAt || 0, remote.meta?.rulesUpdatedAt || 0),
    },
  };
}
