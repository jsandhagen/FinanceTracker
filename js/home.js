// What if: buying a home, alone or with a co-borrower. Three limits on the
// price, and what a given price does to the month:
//   the lender's   housing and debt against gross income, everyone on the loan
//   yours          your share of the cost against the savings rate you keep
//   the cash       down payment and closing costs against what goes in
// Pure functions, no DOM, so they run under Node for tests.

// The usual conventional limits: housing up to 28% of gross monthly income, and
// housing plus other debt payments up to 36%.
export const FRONT = 0.28, BACK = 0.36;
export const MIN_DOWN = 0.03;   // the least a conventional loan takes
export const PMI_UNDER = 0.20;  // mortgage insurance is charged under this much down

export const CO_DEFAULTS = { on: false, income: 0, debts: 0, cash: 0, split: 'income', share: 50 };
export const DEFAULTS = {
  price: null,      // null: the most the three limits allow
  rate: 6.5,        // % a year
  years: 30,
  taxRate: 1,       // property tax, % of the price a year
  insurance: 1800,  // homeowner's insurance, a year
  hoa: 0,           // a month
  pmiRate: 0.5,     // % of the loan a year, while under 20% down
  closing: 3,       // closing costs, % of the price
  upkeep: 1,        // repairs and maintenance, % of the price a year
  cash: 0,          // what you put in, for the down payment and closing costs
  debts: null,      // your monthly debt payments; null: read from the data
  rent: null,       // what housing costs you now, a month; null: read from the data
  floor: 10,        // the savings rate to keep, %
  raise: false,     // count the raise set under What if / A raise
  co: CO_DEFAULTS,
};

// Saved settings over the defaults, with every figure made a sane number.
export function settings(saved = {}) {
  const num = (v, d, lo = 0, hi = Infinity) => (v == null || v === '' || !isFinite(Number(v)) ? d : Math.max(lo, Math.min(hi, Number(v))));
  const s = { ...DEFAULTS, ...saved }, co = { ...CO_DEFAULTS, ...(saved.co || {}) };
  return {
    price: num(s.price, null) || null,
    rate: num(s.rate, DEFAULTS.rate, 0, 30),
    years: [10, 15, 20, 30].includes(Number(s.years)) ? Number(s.years) : 30,
    taxRate: num(s.taxRate, DEFAULTS.taxRate, 0, 10),
    insurance: num(s.insurance, DEFAULTS.insurance),
    hoa: num(s.hoa, 0),
    pmiRate: num(s.pmiRate, DEFAULTS.pmiRate, 0, 5),
    closing: num(s.closing, DEFAULTS.closing, 0, 15),
    upkeep: num(s.upkeep, DEFAULTS.upkeep, 0, 10),
    cash: num(s.cash, 0),
    debts: num(s.debts, null),
    rent: num(s.rent, null),
    floor: num(s.floor, DEFAULTS.floor, 0, 90),
    raise: !!s.raise,
    co: {
      on: !!co.on, income: num(co.income, 0), debts: num(co.debts, 0), cash: num(co.cash, 0),
      split: ['income', 'even', 'custom'].includes(co.split) ? co.split : 'income',
      share: num(co.share, 50, 0, 100),
    },
  };
}

// Principal and interest a month on a loan.
export function payment(loan, ratePct, years) {
  const n = years * 12, r = ratePct / 1200;
  if (!(loan > 0)) return 0;
  return r > 0 ? loan * r / (1 - Math.pow(1 + r, -n)) : loan / n;
}

// What a home at `price` costs, with `cash` going in from everyone. Closing
// costs come out of the cash first and the rest is the down payment.
//   housing   what a lender counts: principal, interest, tax, insurance,
//             mortgage insurance and HOA
//   owning    housing plus upkeep, which no lender counts and every owner pays
//   short     how far the cash falls short of closing costs and the least down
export function cost(price, cash, t) {
  const closing = price * t.closing / 100;
  const down = Math.max(0, Math.min(price, cash - closing));
  const loan = price - down;
  const pi = payment(loan, t.rate, t.years);
  const interest1 = loan * t.rate / 1200;
  const downShare = price > 0 ? down / price : 0;
  const pmi = price > 0 && downShare < PMI_UNDER - 1e-9 ? loan * t.pmiRate / 1200 : 0;
  const tax = price * t.taxRate / 1200, insurance = price > 0 ? t.insurance / 12 : 0, hoa = price > 0 ? t.hoa : 0;
  const upkeep = price * t.upkeep / 1200;
  const housing = pi + tax + insurance + pmi + hoa;
  return {
    price, closing, down, downShare, loan, pi, tax, insurance, pmi, hoa, upkeep, housing, owning: housing + upkeep,
    principal1: Math.max(0, pi - interest1),
    interest: Math.max(0, pi * t.years * 12 - loan),
    needed: closing + MIN_DOWN * price,
    short: Math.max(0, closing + MIN_DOWN * price - cash),
    spare: Math.max(0, cash - closing - price),
  };
}

// The highest price whose monthly cost (`which`: 'housing' or 'owning') fits a
// budget. The cost only rises with the price, so it is found by halving.
export function maxPrice(budget, cash, t, which = 'housing') {
  if (!(budget > 0) || cost(1, cash, t)[which] > budget) return 0;
  let lo = 0, hi = 1e6;
  while (cost(hi, cash, t)[which] <= budget && hi < 1e9) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cost(mid, cash, t)[which] <= budget) lo = mid; else hi = mid;
  }
  return lo;
}

// The highest price the cash closes on: closing costs plus the least down.
export const cashPrice = (cash, t) => (cash > 0 ? cash / (t.closing / 100 + MIN_DOWN) : 0);

// Your share of the monthly cost. Alone it is all of it; with a co-borrower it
// is even, in proportion to gross income, or a share you set.
export function shareOf(gross, co) {
  if (!co?.on) return 1;
  if (co.split === 'even') return 0.5;
  if (co.split === 'custom') return Math.max(0, Math.min(100, Number(co.share) || 0)) / 100;
  const all = gross + (co.income || 0);
  return all > 0 ? gross / all : 0.5;
}

// The people on the loan, as the three limits need them.
//   gross      your gross income a year      takeHome   yours, a month
//   debts      your debt payments a month    other      your spending a month, without housing
//   cash       what you put in               floor      savings rate to keep, 0-1
//   co         { on, income, debts, cash, split, share } or null
function party(p) {
  const co = p.co?.on ? p.co : null;
  return {
    income: (p.gross + (co ? co.income : 0)) / 12,
    debts: p.debts + (co ? co.debts : 0),
    cash: p.cash + (co ? co.cash : 0),
    share: shareOf(p.gross, co),
  };
}

// The three limits on the price, and the lowest of them.
export function limits(p, t) {
  const b = party(p);
  const front = FRONT * b.income, back = BACK * b.income - b.debts;
  const lenderBudget = Math.max(0, Math.min(front, back));
  // Yours: what your take-home leaves after the savings you keep and everything
  // that is not housing has to cover your share of owning.
  const mine = p.takeHome * (1 - p.floor) - p.other;
  const yourBudget = b.share > 0 ? Math.max(0, mine) / b.share : Infinity;
  const out = {
    share: b.share, cash: b.cash, income: b.income, debts: b.debts,
    lender: { budget: lenderBudget, by: back < front ? 'back' : 'front', price: maxPrice(lenderBudget, b.cash, t, 'housing') },
    yours: { budget: yourBudget, mine: Math.max(0, mine), price: isFinite(yourBudget) ? maxPrice(yourBudget, b.cash, t, 'owning') : Infinity },
    // With no cash entered yet there is nothing to measure it against.
    funds: { price: b.cash > 0 ? cashPrice(b.cash, t) : null },
  };
  const order = [['funds', out.funds.price], ['lender', out.lender.price], ['yours', out.yours.price]].filter(x => x[1] != null).sort((x, y) => x[1] - y[1]);
  out.by = order[0][0];
  out.price = order[0][1];
  return out;
}

// One price, in full: the payment, the lender's two ratios, each person's part
// of the month and of the cash, and your savings rate before and after.
// `rent` is what housing costs you a month now.
export function at(price, p, t, rent = 0) {
  const b = party(p), c = cost(price, b.cash, t);
  const mine = c.owning * b.share;
  const rate = spend => (p.takeHome > 0 ? (p.takeHome - spend) / p.takeHome : null);
  // The cash is used in proportion to what each put in; any that is not needed stays with them.
  const used = Math.min(b.cash, c.closing + c.down), part = b.cash > 0 ? p.cash / b.cash : 1;
  return {
    ...c, share: b.share,
    front: b.income > 0 ? c.housing / b.income : null,
    back: b.income > 0 ? (c.housing + b.debts) / b.income : null,
    mine, theirs: c.owning - mine,
    cashUsed: used, cashMine: used * part, cashTheirs: used * (1 - part),
    rateNow: rate(p.other + rent), rateThen: rate(p.other + mine),
    change: mine - rent,
  };
}

// An average month of `value(t)` over the last complete months the data has (up
// to `n`). The month the data ends in is left out unless it is all there is.
export function monthlyAvg(txns, lastIso, value, n = 12) {
  const by = new Map(), seen = new Set();
  for (const t of txns) {
    const ym = t.date_iso.slice(0, 7), v = value(t);
    seen.add(ym);
    if (v) by.set(ym, (by.get(ym) || 0) + v);
  }
  const all = [...seen].sort(), done = all.filter(m => m < lastIso.slice(0, 7));
  const used = (done.length ? done : all).slice(-n);
  if (!used.length) return { monthly: 0, months: 0 };
  return { monthly: used.reduce((s, m) => s + (by.get(m) || 0), 0) / used.length, months: used.length };
}

// ── Exploring ────────────────────────────────────────────────────────────────

// Whether a price passes each of the three limits, and how many it breaks.
// With no cash entered the cash test is not counted.
export function verdict(price, p, t, rent = 0) {
  const a = at(price, p, t, rent);
  const ok = {
    lender: a.front <= FRONT + 1e-4 && a.back <= BACK + 1e-4,
    yours: a.rateThen >= p.floor - 1e-4,
    funds: a.short < 1,
  };
  const cash = p.cash + (p.co?.on ? p.co.cash : 0);
  const broken = [ok.lender, ok.yours, ok.funds || !(cash > 0)].filter(x => !x).length;
  return { a, ok, broken };
}

// The same people with `total` cash between them, split as it is now (evenly
// when neither has put any in yet).
export function withCash(p, total) {
  if (!p.co?.on) return { ...p, cash: total };
  const now = p.cash + p.co.cash, f = now > 0 ? p.cash / now : 0.5;
  return { ...p, cash: total * f, co: { ...p.co, cash: total * (1 - f) } };
}

// The co-borrower income at which a lender would carry `price`: everyone's
// gross a month has to cover housing at 28%, and housing plus debts at 36%.
export function incomeFor(price, p, t) {
  const co = p.co?.on ? p.co : { ...CO_DEFAULTS, on: true };
  const b = party({ ...p, co }), c = cost(price, b.cash, t);
  return Math.max(0, Math.max(c.housing / FRONT, (c.housing + b.debts) / BACK) * 12 - p.gross);
}

// The cash that puts `share` of the price down, closing costs paid.
export const cashFor = (price, t, share = PMI_UNDER) => price * (t.closing / 100 + share);

// A round step near `x`, for the payment map's rows and columns.
export function niceStep(x) {
  for (const s of [1000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 200000, 250000, 500000]) if (s >= x) return s;
  return Math.ceil(x / 500000) * 500000;
}

// `n` values a `step` apart with `v` among them, none below zero: as centred on
// `v` as zero allows.
export function around(v, step, n) {
  const first = Math.max(0, v - Math.floor(n / 2) * step);
  const start = v - Math.round((v - first) / step) * step;
  return Array.from({ length: n }, (_, i) => start + i * step);
}

// Monthly cost over a grid of prices and cash: each cell is your part of
// owning a month and how many limits it breaks.
export function grid(prices, cashes, p, t, rent = 0) {
  return cashes.map(cash => {
    const q = withCash(p, cash);
    return prices.map(price => {
      const v = verdict(price, q, t, rent);
      return { price, cash, mine: v.a.mine, owning: v.a.owning, broken: v.broken, ok: v.ok, downShare: v.a.downShare };
    });
  });
}
