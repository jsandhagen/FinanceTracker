// Encryption round-trip and the device-merge rules (no network).
import { encrypt, decrypt, merge } from '../js/sync.js';
import assert from 'node:assert/strict';

const snap = { transactions: [{ id: 'a' }, { id: 'b' }], rules: { merchant: { X: 'Dining' } }, training: [], settings: { cc_start: 5 }, meta: { updatedAt: 2, rulesUpdatedAt: 2 } };
const blob = await encrypt(snap, 'correct horse battery');
assert.ok(!blob.includes('Dining'), 'ciphertext must not contain plaintext');
assert.deepEqual(await decrypt(blob, 'correct horse battery'), snap);
await assert.rejects(decrypt(blob, 'wrong passphrase'), /Wrong passphrase/);

const local = { transactions: [{ id: 'b' }, { id: 'c' }], rules: { merchant: { Y: 'Travel' } }, training: [], settings: { cc_start: 0 }, meta: { updatedAt: 1, rulesUpdatedAt: 1 } };
const m = merge(local, snap);
assert.deepEqual(m.transactions.map(t => t.id).sort(), ['a', 'b', 'c']);
assert.deepEqual(m.rules, snap.rules, 'newer rule set wins whole');
assert.equal(m.settings.cc_start, 5);
const m2 = merge({ ...local, meta: { updatedAt: 9, rulesUpdatedAt: 9 } }, snap);
assert.deepEqual(m2.rules, local.rules);
console.log('sync tests passed');
