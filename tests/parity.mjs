// Compares the JS port against the original Python analyzer on the same CSVs.
// usage: node tests/parity.mjs <fixtures dir> <python output json> <rules json>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseFile, mergeTransactions, categorize, findRecurringStreams, buildAssetSeries, round2,
} from '../js/analyzer.js';

const [dir, pyOut, rulesPath] = process.argv.slice(2);
const py = JSON.parse(readFileSync(pyOut, 'utf8'));
const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));

let stored = [];
for (const f of ['checking.csv', 'savings.csv', 'credit.csv']) {
  const text = readFileSync(join(dir, f), 'utf8');
  stored = mergeTransactions(stored, parseFile(text).transactions).merged;
}
// Re-importing the same file must add nothing.
const again = mergeTransactions(stored, parseFile(readFileSync(join(dir, 'checking.csv'), 'utf8')).transactions);

const noML = { predict: () => null };
const txns = categorize(stored, rules, [], noML);
const ops = txns.filter(t => !t.is_transfer);
const sum = (a) => round2(a.reduce((s, x) => s + x, 0));

let failures = 0;
function check(name, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  js: ${JSON.stringify(a).slice(0, 400)}\n  py: ${JSON.stringify(b).slice(0, 400)}`); }
  else console.log(`ok   ${name}`);
}

check('dedupe on re-import', again.added, 0);
check('transaction count', txns.length, py.summary.num_transactions);
check('accounts', [...new Set(txns.map(t => t.account))].sort(), [...py.summary.accounts].sort());
check('total income', sum(ops.filter(t => t.amount > 0).map(t => t.amount)), py.summary.total_income);
check('total expenses', sum(ops.filter(t => t.amount < 0).map(t => -t.amount)), py.summary.total_expenses);
check('transfer out', sum(txns.filter(t => t.is_transfer && t.amount < 0).map(t => -t.amount)), py.summary.transfer_out);

const key = t => `${t.date_iso}|${t.description}|${t.amount.toFixed(2)}`;
const pyCats = py.all_transactions.map(t => `${key(t)}=${t.category}/${t.is_transfer}`).sort();
const jsCats = txns.map(t => `${key({ ...t, description: t.description.slice(0, 55) })}=${t.category}/${t.is_transfer}`).sort();
check('every transaction category + transfer flag', jsCats, pyCats);
check('merchants', [...new Set(txns.map(t => t.merchant))].sort(), [...new Set(py.all_transactions.map(t => t.merchant))].sort());

const strip = s => ({ ...s, transactions: s.transactions.length });
check('recurring streams', findRecurringStreams(txns).map(strip), py.streams.map(strip));
check('asset series', buildAssetSeries(txns, 1987.39, { legacy: true }), py.balance_series);

console.log(failures ? `\n${failures} failure(s)` : '\nall parity checks passed');
process.exit(failures ? 1 : 0);
