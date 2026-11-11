// The salary tracker: pay dates, what a salary and bonus come to after tax, a
// "what if" for a raise, and how the year's deposits compare with the plan.
// Pure functions, no DOM, so they run under Node for tests.

import { yearOf, calibrate, difference } from './tax.js';
import { spent, earned, parseFmtDate, DAY } from './insights.js';

export const FREQ = {
  weekly:      { label: 'Weekly',        n: 52, days: 7 },
  biweekly:    { label: 'Bi-weekly',     n: 26, days: 14 },
  semimonthly: { label: 'Twice a month', n: 24 },
  monthly:     { label: 'Monthly',       n: 12 },
};

export const DEFAULTS = { salary: 0, freq: 'biweekly', bonus: 0, bonusUnit: 'usd', bonusMonth: 3, filing: 'single', netPay: null, raise: null, saveShare: 100 };

const p2 = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;
const utc = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const isoOfUtc = ms => { const d = new Date(ms); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); };
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const median = a => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Every payday in a year. `anchor` is any known payday (ISO date): weekly and
// bi-weekly pay keeps its rhythm from it, monthly pay keeps its day of the
// month. Without one, weekly pay lands on Fridays and monthly pay on the last
// day. Twice a month is the 15th and the last day.
export function payDates(freq, year, anchor = null) {
  const out = [];
  if (freq === 'semimonthly') {
    for (let m = 1; m <= 12; m++) out.push(iso(year, m, 15), iso(year, m, lastDay(year, m)));
    return out;
  }
  if (freq === 'monthly') {
    const day = anchor ? Number(anchor.slice(8, 10)) : 31;
    for (let m = 1; m <= 12; m++) out.push(iso(year, m, Math.min(day, lastDay(year, m))));
    return out;
  }
  const step = (FREQ[freq] || FREQ.biweekly).days * DAY;
  let start = anchor ? utc(anchor) : null;
  if (start == null) {
    const jan1 = new Date(Date.UTC(year, 0, 1));
    start = jan1.getTime() + ((5 - jan1.getUTCDay() + 7) % 7) * DAY; // first Friday
  }
  const from = Date.UTC(year, 0, 1), to = Date.UTC(year, 11, 31);
  let t = start + Math.ceil((from - start) / step) * step;
  for (; t <= to; t += step) out.push(isoOfUtc(t));
  return out;
}

// The paycheck among the recurring streams: the regular income that brings in
// the most per month. `sched` is the app's list of { s: stream, active,
// interval, monthly, amount }. Returns null when there is none.
export function detectPaycheck(sched) {
  const pay = sched
    .filter(x => x.s.direction === 'income' && x.s.category === 'Income' && x.interval <= 35)
    .sort((a, b) => b.active - a.active || b.monthly - a.monthly)[0];
  if (!pay) return null;
  const txns = pay.s.transactions;
  const last = pay.last ?? parseFmtDate(txns[txns.length - 1].date);
  const d = new Date(last);
  const i = pay.interval;
  return {
    merchant: pay.s.merchant,
    amount: pay.amount ?? Math.round(median(txns.slice(-3).map(t => Math.abs(t.amount))) * 100) / 100,
    freq: i <= 9 ? 'weekly' : i <= 14 ? 'biweekly' : i <= 18 ? 'semimonthly' : 'monthly',
    lastIso: iso(d.getFullYear(), d.getMonth() + 1, d.getDate()),
    active: pay.active,
  };
}

const bonusOf = (cfg, salary) => (cfg.bonusUnit === 'pct' ? salary * (Number(cfg.bonus) || 0) / 100 : Number(cfg.bonus) || 0);

// A year at one salary, with the rates in `cal` (see tax.calibrate). Ordinary
// paychecks are taxed as the salary alone; the bonus is whatever the year's
// tax grows by when it is added, which is why it keeps less per dollar.
export function project(cfg, cal, salary = Number(cfg.salary) || 0) {
  const periods = (FREQ[cfg.freq] || FREQ.biweekly).n;
  const rates = { filing: cfg.filing, pretaxRate: cal.pretaxRate, taxScale: cal.taxScale };
  const bonusGross = bonusOf(cfg, salary);
  const base = yearOf({ gross: salary, ...rates });
  const full = yearOf({ gross: salary + bonusGross, ...rates });
  const per = {};
  for (const k of ['gross', 'pretax', 'federal', 'virginia', 'ss', 'medicare', 'net']) per[k] = base[k] / periods;
  return { salary, periods, bonusGross, base, full, per, bonus: difference(base, full) };
}

// The rates behind the current salary. With a take-home figure they are backed
// out of it; without one they are the plain estimate.
export function ratesFor(cfg) {
  const periods = (FREQ[cfg.freq] || FREQ.biweekly).n;
  const salary = Number(cfg.salary) || 0, netPay = Number(cfg.netPay) || 0;
  if (!(salary > 0) || !(netPay > 0)) return { pretaxRate: 0, taxScale: 1, fit: false, calibrated: false };
  return { ...calibrate({ gross: salary, net: netPay * periods, filing: cfg.filing }), calibrated: true };
}

// The salary a raise leads to. raise is { mode: 'pct' | 'usd' | 'salary', value }.
export function raisedSalary(salary, raise) {
  const v = Number(raise?.value);
  if (!raise || !isFinite(v)) return salary;
  if (raise.mode === 'pct') return salary * (1 + v / 100);
  if (raise.mode === 'usd') return salary + v;
  return v > 0 ? v : salary;
}

// Average monthly spending over the last complete months (up to `n`), from the
// non-transfer transactions. The month the data ends in is left out unless it
// is all there is.
export function monthlySpending(ops, lastIso, n = 12) {
  const byMonth = new Map();
  for (const t of ops) {
    const v = spent(t);
    if (v) byMonth.set(t.date_iso.slice(0, 7), (byMonth.get(t.date_iso.slice(0, 7)) || 0) + v);
  }
  const all = [...byMonth.keys()].sort();
  const done = all.filter(m => m < lastIso.slice(0, 7));
  const used = (done.length ? done : all).slice(-n);
  if (!used.length) return { monthly: 0, months: 0 };
  return { monthly: used.reduce((s, m) => s + byMonth.get(m), 0) / used.length, months: used.length };
}

// Savings rates for a year of take-home against a year of spending. `ofTakeHome`
// is what is left of the money that reaches the bank; `withPretax` also counts
// what was taken out before tax as saved, against gross pay.
export function savings(year, annualSpending) {
  const left = year.net - annualSpending;
  return {
    left,
    ofTakeHome: year.net > 0 ? left / year.net : null,
    withPretax: year.gross > 0 ? (left + year.pretax) / year.gross : null,
  };
}

// One year, month by month: what the plan says should arrive and what did.
//   dates      paydays in the year (payDates)
//   txns       categorized, non-transfer transactions
//   through    last day there is data for (ISO); months after it have no actual
//   isSalary   which deposits count as pay (by default anything filed as Income);
//              side income and people paying you back are not your salary
export function tracker({ year, dates, netPay, bonusNet, bonusMonth, txns, through, isSalary = t => t.category === 'Income' }) {
  const months = Array.from({ length: 12 }, (_, i) => ({ ym: `${year}-${p2(i + 1)}`, paychecks: 0, expected: 0, bonus: 0, actual: 0, due: 0 }));
  for (const d of dates) {
    const m = months[Number(d.slice(5, 7)) - 1];
    m.paychecks++; m.expected += netPay;
    if (d <= through) m.due += netPay;
  }
  if (bonusNet > 0 && months[bonusMonth - 1]) {
    const m = months[bonusMonth - 1];
    m.bonus = bonusNet; m.expected += bonusNet;
    if (m.ym <= through.slice(0, 7)) m.due += bonusNet;
  }
  for (const t of txns) {
    if (t.date_iso.slice(0, 4) !== String(year) || !earned(t) || !isSalary(t)) continue;
    months[Number(t.date_iso.slice(5, 7)) - 1].actual += earned(t);
  }
  const sum = k => months.reduce((s, m) => s + m[k], 0);
  return {
    months,
    expected: sum('expected'), expectedToDate: sum('due'), actual: sum('actual'),
    next: dates.find(d => d > through) || null,
  };
}

// ── Income sources ────────────────────────────────────────────────────────────
// Every deposit that counts as income comes from a source: the merchant name
// the bank prints. Each source has a kind, guessed and then yours to change.

export const KINDS = {
  salary:    'Salary',
  side:      'Side income',
  reimburse: 'Reimbursements',
  interest:  'Interest',
  other:     'Other income',
};

const P2P = /venmo|zelle|cash ?app|paypal|apple cash|square cash/i;
const PAYROLL = /payroll|salary|direct dep|dir dep|federal home loa|biweekly/i;
const firstWord = m => String(m || '').trim().split(/\s+/)[0].toLowerCase();

// The kind of a source when you have not said. `paycheck` is the merchant of the
// main paycheck (detectPaycheck): it and other deposits from the same employer
// (a bonus run, say) are salary, while payroll from anyone else is a second job.
export function guessKind(merchant, category, paycheck = null) {
  if (category === 'Interest Income') return 'interest';
  if (P2P.test(merchant)) return 'reimburse';
  const employer = paycheck ? firstWord(paycheck) : null;
  if (employer && firstWord(merchant) === employer) return 'salary';
  if (PAYROLL.test(merchant)) return employer ? 'side' : 'salary';
  return 'other';
}

// What a source is, taking your settings over the guess. `saved` is
// settings.incomeSources: { merchant: { kind, name } }.
export function sourceInfo(merchant, category, saved = {}, paycheck = null) {
  const s = saved[merchant] || {};
  return {
    merchant,
    name: s.name || merchant,
    kind: KINDS[s.kind] ? s.kind : guessKind(merchant, category, paycheck),
    set: !!s.kind,
  };
}

// ── Paid back ────────────────────────────────────────────────────────────────
// Money people send you back (Venmo, Zelle and the like, or any source you type
// as Reimbursements) is not income: it is your own spending coming back. It is
// counted like a refund, off spending. Which purchase it was for is not known,
// so it sits in its own line, PAID_BACK, off the total. File one under a
// category (tap its category in the ledger) and it comes off that category
// instead, like any refund.
export const PAID_BACK = 'Paid back';

// Marks those deposits in a list from analyzer.categorize, in place. `saved` is
// settings.incomeSources. Returns the list.
export function markPaidBack(txns, saved = {}) {
  for (const t of txns) {
    if (t.amount <= 0 || t.is_transfer || t.refund) continue;
    if (sourceInfo(t.merchant, t.category, saved).kind !== 'reimburse') continue;
    t.refund = true;
    t.paid_back = true;
    t.category = PAID_BACK;
  }
  return txns;
}

// What a deposit brings in from its source: what it earned, or, for money paid
// back, the amount, so those sources stay listed with their type.
const fromSource = t => (t.paid_back ? t.amount : earned(t));

// Income in `ops` grouped by source, largest first, each with its kind, its
// total, how many deposits, the last one and its months. Money paid back is
// listed too, under kind 'reimburse', though it does not count as income.
export function bySource(ops, saved = {}, paycheck = null) {
  const map = new Map();
  for (const t of ops) {
    const v = fromSource(t);
    if (!v) continue;
    let r = map.get(t.merchant);
    if (!r) map.set(t.merchant, r = { ...sourceInfo(t.merchant, t.category, saved, paycheck), total: 0, count: 0, last: '', months: {} });
    r.total += v; r.count++;
    if (t.date_iso > r.last) r.last = t.date_iso;
    const ym = t.date_iso.slice(0, 7);
    r.months[ym] = (r.months[ym] || 0) + v;
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

// Totals per kind, and month by month per kind, for a list from bySource.
export function byKind(sources) {
  const totals = {}, months = new Map();
  for (const s of sources) {
    totals[s.kind] = (totals[s.kind] || 0) + s.total;
    for (const [ym, v] of Object.entries(s.months)) {
      if (!months.has(ym)) months.set(ym, {});
      const m = months.get(ym);
      m[s.kind] = (m[s.kind] || 0) + v;
    }
  }
  return { totals, months: [...months.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ym, k]) => ({ ym, ...k })) };
}
