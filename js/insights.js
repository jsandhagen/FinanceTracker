// Derived views over categorized transactions: period summaries, pace, budgets,
// recurring schedules and the "signals" feed. Pure functions, no DOM, so they
// run under Node for tests. Analyzer.js stays the port of the Python original;
// everything the dashboard adds on top lives here.

export const DAY = 86400000;

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const median = a => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round2 = n => Math.round(n * 100) / 100;

// Transfers move money between your own accounts, so they are in neither total.
export function summarize(txns) {
  const ops = txns.filter(t => !t.is_transfer);
  const income = sum(ops.filter(t => t.amount > 0), t => t.amount);
  const expense = sum(ops.filter(t => t.amount < 0), t => -t.amount);
  return {
    income, expense, net: income - expense,
    xfrOut: sum(txns.filter(t => t.is_transfer && t.amount < 0), t => -t.amount),
    count: txns.length,
    savingsRate: income > 0 ? (income - expense) / income : null,
  };
}

export function monthly(ops) {
  const map = new Map();
  for (const t of ops) {
    const k = t.date_iso.slice(0, 7);
    if (!map.has(k)) map.set(k, { ym: k, inc: 0, exp: 0 });
    const m = map.get(k);
    if (t.amount > 0) m.inc += t.amount; else m.exp -= t.amount;
  }
  return [...map.values()].sort((a, b) => (a.ym < b.ym ? -1 : 1))
    .map(m => ({ ...m, net: m.inc - m.exp, rate: m.inc > 0 ? (m.inc - m.exp) / m.inc : null }));
}

// Spending (or income, with dir = 1) grouped by a key, largest first.
export function totalsBy(ops, key, dir = -1) {
  const map = new Map();
  for (const t of ops) {
    if (dir < 0 ? t.amount >= 0 : t.amount <= 0) continue;
    const k = t[key];
    if (!map.has(k)) map.set(k, { name: k, total: 0, count: 0 });
    const r = map.get(k);
    r.total += Math.abs(t.amount);
    r.count++;
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

// n equal slices of [s, e] for the sparklines.
export function buckets(ops, s, e, n = 24) {
  const inc = new Array(n).fill(0), exp = new Array(n).fill(0);
  const span = Math.max(1, e - s);
  for (const t of ops) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((t.ts - s) / span * n)));
    if (t.amount > 0) inc[i] += t.amount; else exp[i] -= t.amount;
  }
  return { inc, exp, net: inc.map((v, i) => v - exp[i]) };
}

export function dailySpend(ops) {
  const map = new Map();
  for (const t of ops) if (t.amount < 0) map.set(t.date_iso, (map.get(t.date_iso) || 0) - t.amount);
  return map;
}

const daysIn = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
export const prevMonth = ym => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

// Running spend through a month next to the month before it. `throughIso` is the
// last day there is data for: the current line stops there instead of going flat.
export function spendPace(ops, throughIso) {
  const ym = throughIso.slice(0, 7), pm = prevMonth(ym);
  const day = Number(throughIso.slice(8, 10));
  const cur = new Array(daysIn(ym)).fill(0), prev = new Array(daysIn(pm)).fill(0);
  for (const t of ops) {
    if (t.amount >= 0) continue;
    const k = t.date_iso.slice(0, 7), d = Number(t.date_iso.slice(8, 10)) - 1;
    if (k === ym) cur[d] -= t.amount; else if (k === pm) prev[d] -= t.amount;
  }
  const run = a => { let c = 0; return a.map(v => round2(c += v)); };
  const curRun = run(cur).slice(0, day), prevRun = run(prev);
  return {
    ym, pm, day,
    cur: curRun, prev: prevRun,
    curTotal: curRun[curRun.length - 1] || 0,
    prevAtDay: prevRun[Math.min(day, prevRun.length) - 1] || 0,
    prevTotal: prevRun[prevRun.length - 1] || 0,
    hasPrev: prev.some(v => v > 0),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Inverse of analyzer.fmtDate ("Jan 02, 2025"), which is all a stream keeps.
export function parseFmtDate(s) {
  const m = /^(\w{3}) (\d{2}), (\d{4})$/.exec(s);
  return m ? new Date(+m[3], MONTHS.indexOf(m[1]), +m[2]).getTime() : NaN;
}

// When a recurring stream is next expected, and whether it still looks alive.
// asOf is the last day of data, not today: exports are often a few weeks old.
export function schedule(stream, asOf) {
  const ts = stream.transactions.map(t => parseFmtDate(t.date)).filter(x => !isNaN(x));
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push(Math.round((ts[i] - ts[i - 1]) / DAY));
  const interval = Math.max(1, median(gaps));
  const last = ts[ts.length - 1];
  const active = (asOf - last) / DAY <= interval * 1.6 + 3;
  let next = last + interval * DAY;
  if (active && next < asOf) next = asOf;
  const amounts = stream.transactions.map(t => Math.abs(t.amount));
  const lastAmt = amounts[amounts.length - 1];
  const typical = median(amounts.slice(0, -1));
  return {
    interval, last, next, active,
    monthly: round2(stream.avg_amount * 30.44 / interval),
    lastAmt, typical,
    priceChange: typical > 0 && Math.abs(lastAmt - typical) / typical > 0.05 && amounts.length >= 4
      && stream.direction === 'expense' && interval >= 25 ? round2(lastAmt - typical) : 0,
  };
}

// Average monthly spend per category over the last `n` complete months before
// `ym` (falling back to whatever months exist).
export function avgMonthlyByCat(ops, ym, n = 3) {
  const months = [];
  let m = ym;
  for (let i = 0; i < n; i++) { m = prevMonth(m); months.push(m); }
  const have = new Set(ops.map(t => t.date_iso.slice(0, 7)));
  const used = months.filter(x => have.has(x));
  const out = {};
  if (!used.length) return out;
  for (const t of ops) {
    if (t.amount >= 0 || !used.includes(t.date_iso.slice(0, 7))) continue;
    out[t.category] = (out[t.category] || 0) - t.amount;
  }
  for (const k of Object.keys(out)) out[k] = out[k] / used.length;
  return out;
}

export function budgetRows(ops, ym, budgets) {
  const spent = {};
  for (const t of ops) {
    if (t.amount >= 0 || t.date_iso.slice(0, 7) !== ym) continue;
    spent[t.category] = (spent[t.category] || 0) - t.amount;
  }
  const avg = avgMonthlyByCat(ops, ym);
  const names = new Set([...Object.keys(spent), ...Object.keys(budgets || {}), ...Object.keys(avg)]);
  const rows = [...names].map(name => ({
    name, spent: spent[name] || 0, budget: Number(budgets?.[name]) || 0, avg: avg[name] || 0,
  }));
  rows.sort((a, b) => (b.budget > 0) - (a.budget > 0) || b.spent - a.spent || b.avg - a.avg);
  return rows;
}

// The feed on the overview. Each item is a plain statement about the selected
// period with, where it helps, a place to go look.
export function signals({ ops, priorOps, hasPrior, streams, asOf, money }) {
  const out = [];
  const cur = summarize(ops);

  if (cur.income > 0) {
    if (cur.net >= 0) out.push({ tone: 'good', title: `Kept ${(cur.savingsRate * 100).toFixed(0)}% of income`, detail: `${money(cur.net)} left after spending ${money(cur.expense)}.` });
    else out.push({ tone: 'warn', title: `Spent ${money(-cur.net)} more than came in`, detail: `Income ${money(cur.income)}, spending ${money(cur.expense)}.` });
  }

  if (hasPrior) {
    const now = totalsBy(ops, 'category'), before = new Map(totalsBy(priorOps, 'category').map(c => [c.name, c.total]));
    const moves = now.map(c => ({ name: c.name, total: c.total, was: before.get(c.name) || 0 }))
      .filter(c => c.was > 0).map(c => ({ ...c, diff: c.total - c.was, pct: (c.total - c.was) / c.was }));
    const ups = moves.filter(c => c.pct > 0.2 && c.diff > 50).sort((a, b) => b.diff - a.diff).slice(0, 2);
    for (const c of ups) out.push({ tone: 'warn', title: `${c.name} up ${(c.pct * 100).toFixed(0)}%`, detail: `${money(c.total)} against ${money(c.was)} in the period before.`, cat: c.name });
    const down = moves.filter(c => c.pct < -0.2 && c.diff < -50).sort((a, b) => a.diff - b.diff)[0];
    if (down) out.push({ tone: 'good', title: `${down.name} down ${(-down.pct * 100).toFixed(0)}%`, detail: `${money(down.total)} against ${money(down.was)} in the period before.`, cat: down.name });
  }

  for (const s of streams) {
    const sch = schedule(s, asOf);
    if (sch.active && sch.priceChange) {
      out.push({ tone: sch.priceChange > 0 ? 'warn' : 'good', title: `${s.merchant} ${sch.priceChange > 0 ? 'went up' : 'went down'}`,
        detail: `Last charge ${money(sch.lastAmt)}, usually ${money(sch.typical)}.`, search: s.merchant });
    }
  }

  // A charge well above what that merchant normally costs.
  const byMerchant = new Map();
  for (const t of ops) if (t.amount < 0) { if (!byMerchant.has(t.merchant)) byMerchant.set(t.merchant, []); byMerchant.get(t.merchant).push(t); }
  const odd = [];
  for (const [m, list] of byMerchant) {
    if (list.length < 4) continue;
    const med = median(list.map(t => -t.amount));
    for (const t of list) if (-t.amount > med * 3 && -t.amount - med > 40) odd.push({ t, med, m });
  }
  odd.sort((a, b) => a.t.amount - b.t.amount);
  for (const o of odd.slice(0, 2)) out.push({ tone: 'info', title: `Unusual charge at ${o.m}`, detail: `${money(-o.t.amount)} on ${o.t.date_fmt}, typically ${money(o.med)}.`, search: o.m });

  const spendTxns = ops.filter(t => t.amount < 0);
  if (spendTxns.length) {
    const big = spendTxns.reduce((a, b) => (b.amount < a.amount ? b : a));
    out.push({ tone: 'info', title: `Largest purchase: ${money(-big.amount)}`, detail: `${big.merchant} on ${big.date_fmt}.`, search: big.merchant });
  }

  const fees = sum(ops.filter(t => t.category === 'Fees' && t.amount < 0), t => -t.amount);
  if (fees > 0) out.push({ tone: 'warn', title: `${money(fees)} in fees and interest`, detail: 'Charges the bank or card kept for itself.', cat: 'Fees' });

  const other = ops.filter(t => t.category === 'Other');
  if (other.length >= 3) out.push({ tone: 'info', title: `${other.length} uncategorized transactions`, detail: `${money(sum(other, t => Math.abs(t.amount)))} sits in Other. Tap a category tag to file it.`, cat: 'Other' });

  return out;
}
