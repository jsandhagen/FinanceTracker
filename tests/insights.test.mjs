// The dashboard's derived numbers, run over the demo exports (no DOM).
import * as A from '../js/analyzer.js';
import * as I from '../js/insights.js';
import { demoFiles } from '../js/demo.js';
import assert from 'node:assert/strict';

const stored = demoFiles(new Date(2026, 5, 20)).flatMap(text => {
  const { format, transactions } = A.parseFile(text);
  assert.notEqual(format, 'unknown', 'demo files must parse as real exports');
  return transactions;
});
const txns = A.categorize(stored, { merchant: {}, amount_rules: [] }, []);
const ops = txns.filter(t => !t.is_transfer);
assert.equal(new Set(txns.map(t => t.account)).size, 3);

// Totals agree however they are sliced.
const sum = I.summarize(txns);
const months = I.monthly(ops);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} vs ${b}`);
close(months.reduce((s, m) => s + m.inc, 0), sum.income, 'monthly income');
close(months.reduce((s, m) => s + m.exp, 0), sum.expense, 'monthly spending');
close(I.totalsBy(ops, 'category').reduce((s, c) => s + c.total, 0), sum.expense, 'category spending');
close(I.totalsBy(ops, 'merchant', 1).reduce((s, c) => s + c.total, 0), sum.income, 'income by source');
const s = txns[txns.length - 1].ts, e = txns[0].ts;
const b = I.buckets(ops, s, e, 12);
close(b.exp.reduce((x, y) => x + y, 0), sum.expense, 'bucketed spending');
close([...I.dailySpend(ops).values()].reduce((x, y) => x + y, 0), sum.expense, 'daily spending');
assert.ok(sum.xfrOut > 0 && sum.savingsRate > 0 && sum.savingsRate < 1);

// Pace: the running total for the last month equals that month's spending.
const pace = I.spendPace(ops, '2026-06-20');
assert.equal(pace.cur.length, 20);
assert.equal(pace.prev.length, 31);
close(pace.curTotal, months.at(-1).exp, 'pace total');
close(pace.prevTotal, months.at(-2).exp, 'previous month total');
assert.equal(I.prevMonth('2026-01'), '2025-12');

// Recurring: rent is monthly, alive, and next due about a month after June 1.
const streams = A.findRecurringStreams(txns);
const asOf = A.localTs('2026-06-20');
const rent = streams.find(x => x.merchant.startsWith('RENT'));
const sch = I.schedule(rent, asOf);
assert.ok(sch.active && sch.interval >= 28 && sch.interval <= 31);
assert.ok(Math.abs(sch.next - A.localTs('2026-07-01')) <= 2 * I.DAY, 'next rent date');
close(sch.monthly, 1725 * 30.44 / sch.interval, 'rent per month');
assert.equal(I.schedule(rent, asOf + 200 * I.DAY).active, false, 'a stream that stopped is lapsed');
assert.equal(I.parseFmtDate(A.fmtDate('2026-03-09')), A.localTs('2026-03-09'));

// Budgets: budgeted categories first, spent matches the category total for the month.
const rows = I.budgetRows(ops, '2026-05', { Groceries: 600 });
assert.equal(rows[0].name, 'Groceries');
close(rows[0].spent, I.totalsBy(ops.filter(t => t.date_iso.startsWith('2026-05')), 'category').find(c => c.name === 'Groceries').total, 'budget spent');
assert.ok(rows[0].avg > 0);

// Signals: the price rise and the fee both surface.
const sig = I.signals({ ops, priorOps: [], hasPrior: false, streams, asOf, money: n => '$' + Math.round(n) });
assert.ok(sig.some(x => /SPOTIFY/.test(x.title) && /went up/.test(x.title)), 'price change');
assert.ok(sig.some(x => x.cat === 'Fees'), 'fees');
assert.ok(sig.some(x => /Kept \d+% of income/.test(x.title)), 'savings rate');
console.log('insights tests passed');
