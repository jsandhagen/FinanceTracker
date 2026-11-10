// A folder the app is allowed to read (Chrome and Edge on a computer). New
// Capital One exports saved there are picked up without choosing them by hand.
// The handle is kept in IndexedDB on this device and is never synced.

import * as store from './storage.js';

export const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
const MAX_BYTES = 25 * 1024 * 1024;
const SNIFF = /Transaction Description|Card No\./;

let cfg = null; // { handle, name, seen: { "name|size|modified": 1 }, lastScan }

export async function load() { cfg = (await store.get('watch')) || null; return cfg; }
export const current = () => cfg;

export async function use(handle) {
  cfg = { handle, name: handle.name, seen: {}, lastScan: 0 };
  await store.set('watch', cfg);
  return cfg;
}
export async function pick() {
  return use(await window.showDirectoryPicker({ id: 'financetracker', mode: 'read', startIn: 'downloads' }));
}
export async function stop() { cfg = null; await store.del('watch'); }

// 'granted', 'prompt' (needs a click to ask again), 'denied' or 'none'.
export async function permission(ask = false) {
  if (!cfg) return 'none';
  if (!cfg.handle.queryPermission) return 'granted';
  let p = await cfg.handle.queryPermission({ mode: 'read' });
  if (p !== 'granted' && ask) p = await cfg.handle.requestPermission({ mode: 'read' });
  return p;
}

// CSVs in the folder that have not been read before and look like bank
// exports, as [{ name, text }]. Every CSV is looked at once: its first bytes
// decide whether the rest is read.
export async function scan() {
  if (!cfg) return [];
  const seen = {}, fresh = [];
  for await (const [name, h] of cfg.handle.entries()) {
    if (h.kind !== 'file' || !/\.csv$/i.test(name)) continue;
    let file;
    try { file = await h.getFile(); } catch { continue; }
    const key = `${name}|${file.size}|${file.lastModified}`;
    seen[key] = 1;
    if (cfg.seen[key] || file.size > MAX_BYTES) continue;
    if (!SNIFF.test(await file.slice(0, 2048).text())) continue;
    fresh.push({ name, text: await file.text() });
  }
  cfg.seen = seen;
  cfg.lastScan = Date.now();
  await store.set('watch', cfg);
  return fresh;
}
