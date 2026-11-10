// Everything the app keeps lives in one IndexedDB object store on this device.
//   transactions  stored rows (see analyzer.parseFile)
//   rules         { merchant: {name: category}, amount_rules: [...] }
//   training      [{ text, category }]
//   settings      { cc_start }
//   sync          { token, passphrase, gistId, lastSync }   (never synced itself)
//   plaid         { mode: 'direct', clientId, secret, env } or { url, key } for a relay (never synced).
//                 In the Android app this is not kept here at all but encrypted
//                 with a key in the Android Keystore (see getPlaid).
//   meta          { updatedAt, rulesUpdatedAt }

import * as native from './native.js';

const DB_NAME = 'financetracker';
const STORE = 'kv';

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const get = key => tx('readonly', s => s.get(key));
export const set = (key, value) => tx('readwrite', s => s.put(value, key));
export const del = key => tx('readwrite', s => s.delete(key));

// How Plaid is reached, which includes the Plaid secret. A browser has nowhere
// better than IndexedDB. The Android app keeps it encrypted under a Keystore
// key instead, and moves over anything an earlier build left in IndexedDB.
export async function getPlaid() {
  if (!native.isNative()) return (await get('plaid')) || null;
  const kept = await native.secure.get('plaid');
  if (kept) return kept;
  const old = await get('plaid');
  if (!old) return null;
  await native.secure.set('plaid', old);
  await del('plaid');
  return old;
}
export async function setPlaid(conn) {
  if (!native.isNative()) return set('plaid', conn);
  await native.secure.set('plaid', conn);
  await del('plaid');
}
export async function delPlaid() {
  if (native.isNative()) await native.secure.remove('plaid');
  await del('plaid');
}

export async function loadAll() {
  const [transactions, rules, training, settings, sync, meta, plaid] = await Promise.all(
    [...['transactions', 'rules', 'training', 'settings', 'sync', 'meta'].map(get), getPlaid()]);
  return {
    transactions: transactions || [],
    rules: { merchant: {}, amount_rules: [], ...(rules || {}) },
    training: training || [],
    settings: { cc_start: 0, ...(settings || {}) },
    sync: sync || null,
    plaid: plaid || null,
    meta: { updatedAt: 0, rulesUpdatedAt: 0, ...(meta || {}) },
  };
}

export async function saveData(state) {
  await Promise.all([
    set('transactions', state.transactions),
    set('rules', state.rules),
    set('training', state.training),
    set('settings', state.settings),
    set('meta', state.meta),
  ]);
}

export async function clearData() {
  await Promise.all(['transactions', 'rules', 'training', 'settings', 'meta'].map(del));
}

// Ask the browser not to evict this site's storage under pressure. Safari in
// particular clears storage for sites that are not installed to the home screen.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch { return false; }
}
