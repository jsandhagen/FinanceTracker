// The tax model and the salary tracker (no DOM).
import * as T from '../js/tax.js';
import * as N from '../js/income.js';
import * as A from '../js/analyzer.js';
import * as I from '../js/insights.js';
import { demoFiles } from '../js/demo.js';
import assert from 'node:assert/strict';

const close = (a, b, msg, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// ── Bands ──
// $100,000 single, nothing taken out before tax, worked by hand:
//   federal taxable 83,900 -> 1,240 + 4,560 + 7,370 = 13,170
//   Virginia taxable 100,000 - 8,750 - 930 = 90,320 -> 60 + 60 + 600 + 4,215.90 = 4,935.90
const y = T.yearOf({ gross: 100000, filing: 'single' });
close(y.federal, 13170, 'federal tax');
close(y.virginia, 4935.9, 'Virginia tax');
close(y.ss, 6200, 'Social Security');
close(y.medicare, 1450, 'Medicare');
close(y.net, 100000 - 13170 - 4935.9 - 6200 - 1450, 'take-home');
assert.equal(y.fedMarginal, 0.22);
assert.equal(y.vaMarginal, 0.0575);

// Married: double deduction and two exemptions in Virginia, same schedule.
const m = T.yearOf({ gross: 100000, filing: 'married' });
close(m.vaTaxable, 100000 - 17500 - 1860, 'Virginia taxable, married');
close(m.federal, 2480 + (67800 - 24800) * 0.12, 'federal tax, married');

// Social Security stops at the wage base; the extra Medicare starts at 200k.
const hi = T.yearOf({ gross: 300000, filing: 'single' });
close(hi.ss, 184500 * 0.062, 'Social Security cap');
close(hi.medicare, 300000 * 0.0145 + 100000 * 0.009, 'additional Medicare');

// Nothing is owed below the deductions, and nothing goes negative.
const low = T.yearOf({ gross: 8000, filing: 'single' });
assert.equal(low.federal, 0); assert.equal(low.virginia, 0);
assert.equal(T.yearOf({ gross: 0 }).net, 0);

// Money taken out before tax lowers both income taxes but not FICA.
const k = T.yearOf({ gross: 100000, filing: 'single', pretaxRate: 0.06 });
close(k.pretax, 6000, 'pre-tax amount');
close(k.federal, 13170 - 6000 * 0.22, 'federal after pre-tax');
close(k.virginia, 4935.9 - 6000 * 0.0575, 'Virginia after pre-tax');
close(k.ss, 6200, 'Social Security unchanged');

// The Virginia schedule accounts for all of the taxable income and the tax.
const bands = T.virginiaBands(y.vaTaxable);
close(bands.reduce((s, b) => s + b.amount, 0), y.vaTaxable, 'band amounts');
close(bands.reduce((s, b) => s + b.tax, 0), y.virginia, 'band tax');

// ── Backing the rates out of a take-home figure ──
// Lower take-home than the plain estimate: the gap is pre-tax money.
let cal = T.calibrate({ gross: 100000, net: k.net, filing: 'single' });
assert.ok(cal.fit);
close(cal.pretaxRate, 0.06, 'solved pre-tax rate', 1e-6);
assert.equal(cal.taxScale, 1);
close(T.yearOf({ gross: 100000, filing: 'single', ...cal }).net, k.net, 'model lands on the take-home');

// Higher take-home: income taxes are scaled down, nothing is assumed deducted.
cal = T.calibrate({ gross: 100000, net: y.net + 1810.59, filing: 'single' });
assert.ok(cal.fit && cal.pretaxRate === 0 && cal.taxScale < 1);
close(T.yearOf({ gross: 100000, filing: 'single', ...cal }).net, y.net + 1810.59, 'scaled model lands on the take-home');

// More than gross less FICA cannot be explained.
assert.equal(T.calibrate({ gross: 100000, net: 99000, filing: 'single' }).fit, false);
assert.equal(T.calibrate({ gross: 0, net: 100, filing: 'single' }).fit, false);

// ── Pay dates ──
const bi = N.payDates('biweekly', 2026, '2026-06-12');
assert.equal(bi.length, 26);
assert.ok(bi.includes('2026-06-12') && bi[0] === '2026-01-09' && bi[25] === '2026-12-25');
for (let i = 1; i < bi.length; i++) assert.equal((Date.parse(bi[i]) - Date.parse(bi[i - 1])) / 864e5, 14);
// An anchor from another year keeps the same rhythm.
assert.deepEqual(N.payDates('biweekly', 2026, '2025-12-26'), bi);
// 2027 starts on a Friday that is a payday for this rhythm: 27 paydays? No: 2027-01-08 is the first.
assert.equal(N.payDates('biweekly', 2027, '2026-06-12')[0], '2027-01-08');
assert.equal(N.payDates('weekly', 2026).length, 52);
assert.equal(new Date(N.payDates('weekly', 2026)[0] + 'T12:00:00Z').getUTCDay(), 5);
const semi = N.payDates('semimonthly', 2026);
assert.equal(semi.length, 24);
assert.ok(semi.includes('2026-02-15') && semi.includes('2026-02-28'));
assert.deepEqual(N.payDates('monthly', 2026, '2025-11-30').slice(0, 3), ['2026-01-30', '2026-02-28', '2026-03-30']);

// ── A year at a salary, and a raise ──
const cfg = { ...N.DEFAULTS, salary: 112000, freq: 'biweekly', bonus: 5, bonusUnit: 'pct', bonusMonth: 3, filing: 'single', netPay: 3010 };
const rates = N.ratesFor(cfg);
assert.ok(rates.calibrated && rates.fit && rates.pretaxRate > 0);
const now = N.project(cfg, rates);
close(now.per.gross, 112000 / 26, 'gross per paycheck');
close(now.per.net, 3010, 'take-home per paycheck matches what was entered', 0.005);
close(now.per.pretax + now.per.federal + now.per.virginia + now.per.ss + now.per.medicare + now.per.net, 112000 / 26, 'paycheck adds up');
close(now.bonusGross, 5600, 'bonus as a share of salary');
close(now.full.net, now.base.net + now.bonus.net, 'bonus is the difference between the two years');
// The bonus sits on top of the salary, so it keeps less per dollar.
assert.ok(now.bonus.net / now.bonusGross < now.base.net / now.base.gross);

assert.equal(N.raisedSalary(104000, { mode: 'pct', value: 5 }), 109200);
assert.equal(N.raisedSalary(104000, { mode: 'usd', value: 6000 }), 110000);
assert.equal(N.raisedSalary(104000, { mode: 'salary', value: 120000 }), 120000);
assert.equal(N.raisedSalary(104000, null), 104000);

const then = N.project(cfg, rates, 117600);
const d = T.difference(now.full, then.full);
close(d.gross, 5600 * 1.05, 'raise lifts the bonus with it');
close(d.pretax + d.federal + d.virginia + d.ss + d.medicare + d.net, d.gross, 'every dollar of the raise is accounted for', 0.02);
// All of it lands in the 22% federal band and Virginia's top band.
close(d.virginia, (d.gross - d.pretax) * 0.0575, 'Virginia takes 5.75% of the taxable raise', 0.02);
close(d.federal, (d.gross - d.pretax) * 0.22, 'federal takes 22% of the taxable raise', 0.02);
assert.ok(d.net > 0 && d.net < d.gross);

// Without a take-home figure the plain estimate is used.
const plain = N.ratesFor({ ...cfg, netPay: null });
assert.ok(!plain.calibrated && plain.pretaxRate === 0 && plain.taxScale === 1);

// Savings rates.
const s = N.savings(now.full, 60000);
close(s.ofTakeHome, (now.full.net - 60000) / now.full.net, 'savings rate of take-home', 1e-9);
close(s.withPretax, (now.full.net - 60000 + now.full.pretax) / now.full.gross, 'savings rate counting pre-tax', 1e-9);

// ── Against the demo data ──
const today = new Date(2026, 5, 20);
const stored = demoFiles(today).flatMap(text => A.parseFile(text).transactions);
const txns = A.categorize(stored, { merchant: {}, amount_rules: [] }, []);
const ops = txns.filter(t => !t.is_transfer);
const asOf = txns[0].ts;
const sched = A.findRecurringStreams(txns).map(st => ({ s: st, ...I.schedule(st, asOf) }));
const pay = N.detectPaycheck(sched);
assert.ok(pay, 'finds the paycheck');
assert.equal(pay.merchant, 'ACME CORP PAYROLL');
assert.equal(pay.freq, 'biweekly');
assert.equal(pay.amount, 3010);

const through = txns[0].date_iso;
const dates = N.payDates('biweekly', 2026, pay.lastIso);
// ── Income sources ──
// The demo has a paycheck, a bonus run from the same employer, a coaching gig
// paid through payroll, Venmo paybacks and savings interest.
const sources = N.bySource(ops, {}, pay.merchant);
const kindOf = Object.fromEntries(sources.map(x => [x.merchant, x.kind]));
assert.equal(kindOf['ACME CORP PAYROLL'], 'salary');
assert.equal(kindOf['ACME CORP BONUS PAYROLL'], 'salary', 'same employer: salary');
assert.equal(kindOf['RIVERSIDE SWIM CLUB PAYROLL'], 'side', 'another employer: a second job');
assert.equal(kindOf['VENMO CASHOUT'], 'reimburse');
assert.equal(kindOf['Monthly Interest Paid'], 'interest');
close(sources.reduce((n, x) => n + x.total, 0), I.summarize(ops).income, 'sources add up to income');
const kinds = N.byKind(sources);
close(Object.values(kinds.totals).reduce((a, b) => a + b, 0), I.summarize(ops).income, 'kinds add up to income');
close(kinds.months.reduce((n, m) => n + Object.entries(m).filter(([k]) => k !== 'ym').reduce((a, [, v]) => a + v, 0), 0), I.summarize(ops).income, 'months add up to income');
// Your own choices win over the guess, and a name replaces the bank's text.
const mine = N.bySource(ops, { 'VENMO CASHOUT': { kind: 'side', name: 'Venmo' }, 'RIVERSIDE SWIM CLUB PAYROLL': { name: 'Coaching' } }, pay.merchant);
const venmo = mine.find(x => x.merchant === 'VENMO CASHOUT'), coach = mine.find(x => x.merchant === 'RIVERSIDE SWIM CLUB PAYROLL');
assert.ok(venmo.kind === 'side' && venmo.set && venmo.name === 'Venmo');
assert.ok(coach.kind === 'side' && !coach.set && coach.name === 'Coaching');
assert.equal(N.sourceInfo('X', 'Income', { X: { kind: 'bogus' } }).kind, 'other', 'an unknown kind falls back to the guess');
// Without a known paycheck, payroll is salary.
assert.equal(N.guessKind('RIVERSIDE SWIM CLUB PAYROLL', 'Income', null), 'salary');
assert.equal(N.guessKind('FEDERAL HOME LOAN MORTGAGE CORP', 'Income', 'FEDERAL HOME LOAN MORTGAGE'), 'salary');
assert.equal(N.guessKind('Zelle deposit from Sam', 'Income', 'ACME'), 'reimburse');

// ── Paid back ──
// Venmo and the like are not income: they come off spending, in their own line.
{
  const before = I.summarize(ops);
  const marked = N.markPaidBack(ops.map(t => ({ ...t })), {});
  const back = marked.filter(t => t.paid_back);
  assert.ok(back.length > 0 && back.every(t => t.merchant === 'VENMO CASHOUT' && t.refund && t.category === N.PAID_BACK));
  const repaid = back.reduce((s, t) => s + t.amount, 0);
  const after = I.summarize(marked);
  close(after.income, before.income - repaid, 'paid back is not income');
  close(after.expense, before.expense - repaid, 'it comes off spending');
  close(after.net, before.net, 'what was kept is unchanged');
  assert.ok(!I.totalsBy(marked, 'category').some(x => x.name === N.PAID_BACK), 'no category of its own in the spending list');
  // Still listed as a source, so its type can be changed back.
  const listed = N.bySource(marked, {}, pay.merchant);
  assert.equal(listed.find(x => x.merchant === 'VENMO CASHOUT').kind, 'reimburse');
  close(listed.find(x => x.merchant === 'VENMO CASHOUT').total, repaid, 'listed at what came in');
  close(listed.filter(x => x.kind !== 'reimburse').reduce((s, x) => s + x.total, 0), after.income, 'the other sources add up to income');
  // Typed as something else, it is income again.
  const asSide = N.markPaidBack(ops.map(t => ({ ...t })), { 'VENMO CASHOUT': { kind: 'side' } });
  assert.ok(!asSide.some(t => t.paid_back));
  close(I.summarize(asSide).income, before.income, 'typed Side income, it counts');
  // Any source typed Reimbursements, not only the guessed ones.
  const swim = N.markPaidBack(ops.map(t => ({ ...t })), { 'RIVERSIDE SWIM CLUB PAYROLL': { kind: 'reimburse' } });
  assert.ok(swim.some(t => t.paid_back && t.merchant === 'RIVERSIDE SWIM CLUB PAYROLL'));
  // A deposit already filed under a category (a refund) keeps that category.
  const filed = { id: 'x', amount: 40, merchant: 'VENMO CASHOUT', category: 'Dining', refund: true, is_transfer: false };
  N.markPaidBack([filed], {});
  assert.ok(filed.category === 'Dining' && !filed.paid_back);
  // Transfers and money out are left alone.
  const out = { amount: -40, merchant: 'VENMO PAYMENT', category: 'P2P Transfer', is_transfer: true };
  N.markPaidBack([out], {});
  assert.ok(!out.paid_back && !out.refund);
}

// The salary tracker counts salary sources only.
const salaryOf = new Set(sources.filter(x => x.kind === 'salary').map(x => x.merchant));
const tr = N.tracker({ year: 2026, dates, netPay: 3010, bonusNet: now.bonus.net, bonusMonth: 3, txns: ops, through, isSalary: t => salaryOf.has(t.merchant) });
const all = N.tracker({ year: 2026, dates, netPay: 3010, bonusNet: now.bonus.net, bonusMonth: 3, txns: ops, through });
assert.ok(all.actual > tr.actual + 1000, 'coaching and Venmo would otherwise count as pay');
assert.equal(tr.months.length, 12);
assert.equal(tr.months.reduce((n, mo) => n + mo.paychecks, 0), dates.length);
close(tr.expected, dates.length * 3010 + now.bonus.net, 'expected for the year');
assert.ok(tr.expectedToDate < tr.expected && tr.expectedToDate > 0);
assert.ok(tr.next > through);
// The demo pays 3,010 every other week in 2026 and a bonus in March.
const mar = tr.months[2];
close(mar.actual, mar.paychecks * 3010 + 5200, 'March deposits: paychecks and the bonus');
close(tr.actual, tr.months.reduce((n, mo) => n + mo.actual, 0), 'actual total');
const jan = tr.months[0];
close(jan.actual, jan.paychecks * 3010, 'January deposits match the paydays');

const spend = N.monthlySpending(ops, through);
assert.ok(spend.months === 12 && spend.monthly > 1000);

console.log('income tests passed');
