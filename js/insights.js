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

// What a transaction adds to income and to spending. A refund is neither money
// earned nor nothing: it takes that much back off spending.
export const earned = t => (t.amount > 0 && !t.refund ? t.amount : 0);
export const spent = t => (t.amount < 0 || t.refund ? -t.amount : 0);

// Transfers move money between your own accounts, so they are in neither total.
export function summarize(txns) {
  const ops = txns.filter(t => !t.is_transfer);
  const income = sum(ops, earned);
  const expense = sum(ops, spent);
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
    m.inc += earned(t); m.exp += spent(t);
  }
  return [...map.values()].sort((a, b) => (a.ym < b.ym ? -1 : 1))
    .map(m => ({ ...m, net: m.inc - m.exp, rate: m.inc > 0 ? (m.inc - m.exp) / m.inc : null }));
}

// Spending (or income, with dir = 1) grouped by a key, largest first. Refunds
// come off their group; a group refunded to nothing or below is left out.
export function totalsBy(ops, key, dir = -1) {
  const map = new Map();
  for (const t of ops) {
    const v = dir < 0 ? spent(t) : earned(t);
    if (!v) continue;
    const k = t[key];
    if (!map.has(k)) map.set(k, { name: k, total: 0, count: 0 });
    const r = map.get(k);
    r.total += v;
    if (v > 0) r.count++;
  }
  return [...map.values()].filter(r => r.total > 0.004).sort((a, b) => b.total - a.total);
}

// n equal slices of [s, e] for the sparklines.
export function buckets(ops, s, e, n = 24) {
  const inc = new Array(n).fill(0), exp = new Array(n).fill(0);
  const span = Math.max(1, e - s);
  for (const t of ops) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((t.ts - s) / span * n)));
    inc[i] += earned(t); exp[i] += spent(t);
  }
  return { inc, exp, net: inc.map((v, i) => v - exp[i]) };
}

export function dailySpend(ops) {
  const map = new Map();
  for (const t of ops) { const v = spent(t); if (v) map.set(t.date_iso, (map.get(t.date_iso) || 0) + v); }
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
    const v = spent(t);
    if (!v) continue;
    const k = t.date_iso.slice(0, 7), d = Number(t.date_iso.slice(8, 10)) - 1;
    if (k === ym) cur[d] += v; else if (k === pm) prev[d] += v;
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

// A salaried paycheck's deposits without the bonus: in the bonus month (1–12),
// any deposit well above the usual paycheck is the bonus, or a paycheck with
// the bonus folded in.
export function withoutBonus(txns, bonusMonth) {
  const month = t => new Date(parseFmtDate(t.date)).getMonth() + 1;
  const usual = median(txns.filter(t => month(t) !== bonusMonth).slice(-5).map(t => Math.abs(t.amount)));
  return txns.filter(t => !(month(t) === bonusMonth && usual > 0 && Math.abs(t.amount) > usual * 1.25));
}

// When a recurring stream is next expected, and whether it still looks alive.
// asOf is the last day of data, not today: exports are often a few weeks old.
// `pay` marks the stream as the salaried paycheck ({ bonusMonth }, or null
// when there is no bonus): it pays the same each time, so the next one is
// expected at the last regular deposit, and the bonus is left out.
export function schedule(stream, asOf, pay = null) {
  const txns = pay ? withoutBonus(stream.transactions, pay.bonusMonth) : stream.transactions;
  const ts = txns.map(t => parseFmtDate(t.date)).filter(x => !isNaN(x));
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push(Math.round((ts[i] - ts[i - 1]) / DAY));
  const interval = Math.max(1, median(gaps));
  let last = ts[ts.length - 1];
  // A check with the bonus and the base pay together was still a payday, so the
  // cadence steps over it (a bonus on a day of its own is not stepped over).
  if (pay) {
    const all = stream.transactions.map(t => parseFmtDate(t.date));
    for (;;) {
      const step = all.find(x => x > last && Math.abs(x - (last + interval * DAY)) <= 3 * DAY);
      if (step == null) break;
      last = step;
    }
  }
  const active = (asOf - last) / DAY <= interval * 1.6 + 3;
  let next = last + interval * DAY;
  if (active && next < asOf) next = asOf;
  const amounts = txns.map(t => Math.abs(t.amount));
  const lastAmt = amounts[amounts.length - 1];
  const typical = median(amounts.slice(0, -1));
  // What the next one should be: the middle of the last five, so a one-off from
  // the same payer does not lift it and a new price shows by its third payment.
  // stream.avg_amount is the all-time mean, kept for Python parity.
  const amount = round2(pay ? lastAmt : median(amounts.slice(-5)));
  return {
    interval, last, next, active, amount,
    monthly: round2(amount * 30.44 / interval),
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
    if (!spent(t) || !used.includes(t.date_iso.slice(0, 7))) continue;
    out[t.category] = (out[t.category] || 0) + spent(t);
  }
  for (const k of Object.keys(out)) { out[k] = out[k] / used.length; if (out[k] <= 0) delete out[k]; }
  return out;
}

const spentOf = spent;
export function budgetRows(ops, ym, budgets) {
  const spent = {};
  for (const t of ops) {
    if (t.date_iso.slice(0, 7) !== ym) continue;
    const v = spentOf(t);
    if (v) spent[t.category] = (spent[t.category] || 0) + v;
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

  const fees = sum(ops.filter(t => t.category === 'Fees'), spent);
  if (fees > 0.004) out.push({ tone: 'warn', title: `${money(fees)} in fees and interest`, detail: 'Charges the bank or card kept for itself.', cat: 'Fees' });

  const back = sum(ops.filter(t => t.refund && !t.paid_back), t => t.amount);
  if (back > 0.004) out.push({ tone: 'info', title: `${money(back)} came back as refunds`, detail: 'Taken off spending in its category, not counted as income.' });
  const repaid = sum(ops.filter(t => t.paid_back), t => t.amount);
  if (repaid > 0.004) out.push({ tone: 'info', title: `${money(repaid)} paid back to you`, detail: 'Venmo, Zelle and the like. Taken off spending, not counted as income.', cat: 'Paid back' });

  const other = ops.filter(t => t.category === 'Other');
  if (other.length >= 3) out.push({ tone: 'info', title: `${other.length} uncategorized transactions`, detail: `${money(sum(other, t => Math.abs(t.amount)))} sits in Other. Tap a category tag to file it.`, cat: 'Other' });

  return out;
}
