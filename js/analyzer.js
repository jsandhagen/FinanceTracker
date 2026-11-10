// Port of the Flask app's analyzer.py. Pure functions, no DOM, so it runs under
// Node for tests as well as in the browser.
//
// Stored transactions keep only what the bank file said (date, description,
// amount, balance, the card's own category). Merchant and category are derived
// on every load, so a rule added today recategorizes last year's uploads too.

import { parseCsv } from './csv.js';
import { Categorizer } from './categorizer.js';

// ── Category mapping ───────────────────────────────────────────────────────────

export const CC_CATEGORY_MAP = {
  'merchandise':         'Shopping',
  'other services':      'Subscriptions',
  'phone/cable':         'Utilities & Bills',
  'internet':            'Subscriptions',
  'dining/restaurant':   'Dining',
  'automotive':          'Transportation',
  'other travel':        'Transportation',
  'car rental':          'Transportation',
  'groceries':           'Groceries',
  'gas/automotive':      'Transportation',
  'health care':         'Health',
  'entertainment':       'Entertainment',
  'education':           'Education',
  'travel':              'Travel',
  'payment/credit':      'Payment',
  'fees/interest':       'Fees',
  'lodging':             'Travel',
  'airfare':             'Travel',
  'utilities':           'Utilities & Bills',
  'fee/interest charge': 'Fees',
};

// [keywords, category, is_transfer]
export const CHECKING_KEYWORD_RULES = [
  [['payroll', 'salary', 'direct dep', 'federal home loa', 'biweekly'], 'Income', false],
  [['venmo cashout', 'zelle deposit', 'cashapp deposit'], 'Income', false],

  [['360 performance savings', '360 savings', '360 money market', '360 checking',
    'transfer to savings', 'transfer from savings'], 'Savings Transfer', true],
  [['capital one mobile pmt', 'capital one crcardpmt', 'bk of amer', 'bank of amer',
    'chase pmt', 'credit card pmt', 'citi card', 'discover pmt'], 'Credit Card Payment', true],
  [['student loan', 'loan pmt', 'sallie mae', 'navient',
    'first community credit', 'community credit union',
    'preauthorized withdrawal to first'], 'Loan Payment', true],
  [['venmo payment', 'zelle payment', 'zelle money sent', 'cashapp pay', 'paypal'], 'P2P Transfer', true],

  [['amazon', 'ebay', 'etsy', 'walmart', 'target', 'best buy', 'costco', 'oregon kicks'], 'Shopping', false],
  [['netflix', 'spotify', 'hulu', 'disney', 'hbo', 'peacock', 'apple',
    'youtube premium', 'steam', 'playstation', 'nintendo', 'xbox',
    'nba league pass', 'porkbun'], 'Subscriptions', false],
  [['uber eats', 'ubereats', 'uber *eats'], 'Dining', false],
  [['uber', 'lyft', 'metro', 'transit', 'parking', 'shell', 'exxon', 'bp ',
    'chevron', 'sunoco', 'wawa gas', 'marathon', 'sixt'], 'Transportation', false],
  [['safeway', 'kroger', 'whole foods', 'trader joe', 'aldi', 'publix', 'giant',
    'harris teeter', 'wegmans', 'food lion', 'grocery'], 'Groceries', false],
  [['doordash', 'grubhub', 'ubereats', 'seamless', 'chipotle', 'mcdonald',
    'starbucks', 'coffee', 'restaurant', 'pizza', 'sushi', 'burger', 'taco',
    'subway', 'chick-fil-a', 'panera'], 'Dining', false],
  [['dominion', 'dominion energy', 'electric', 'comcast', 'verizon',
    'at&t', 'tmobile', 'spectrum', 'water bill', 'gas bill', 'billpay',
    'fairfax va coun', 'pp-echeck', 'washington gas'], 'Utilities & Bills', false],
  [['rent', 'mortgage', 'hoa', 'property'], 'Housing', false],
  [['usaa', 'geico', 'allstate', 'state farm', 'progressive', 'prog universal',
    'insurance', 'ins prem'], 'Insurance', false],
  [['doctor', 'hospital', 'pharmacy', 'cvs', 'walgreens', 'medical', 'dental',
    'health', 'gym', 'fitness', 'planet fitness'], 'Health', false],
];

export const SAVINGS_KEYWORD_RULES = [
  [['monthly interest', 'interest paid', 'apy interest'], 'Interest Income', false],
  [['360 checking', '360 performance savings', '360 savings', '360 money market'], 'Savings Transfer', true],
  [['dept education', 'student ln', 'dept of education', 'student loan',
    'sallie mae', 'navient'], 'Loan Payment', true],
];

export const TRANSFER_CATEGORIES = new Set([
  'Savings Transfer', 'Credit Card Payment', 'Loan Payment', 'P2P Transfer', 'Payment',
]);

// A deposit filed under one of these is money coming back, not money earned.
const NOT_SPENDING = new Set(['Income', 'Interest Income', 'Other']);
const REFUND_RE = /refund|reversal|return|rebate|credit adj/i;

// Short keywords must start a word: 'rent' is not in "CURRENT", 'hoa' not in "WHOA".
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchers = new Map();
function hasKeyword(text, kw) {
  if (kw.trim().length > 4) return text.includes(kw);
  let re = matchers.get(kw);
  if (!re) matchers.set(kw, re = new RegExp('(^|[^a-z0-9])' + escRe(kw)));
  return re.test(text);
}

export const ALL_CATS = [
  'Income', 'Shopping', 'Subscriptions', 'Transportation', 'Groceries',
  'Dining', 'Utilities & Bills', 'Housing', 'Insurance', 'Health',
  'Travel', 'Entertainment', 'Education', 'Fees', 'Interest Income', 'Other',
];

export function seedExamples() {
  const ex = [];
  for (const [kws, cat] of CHECKING_KEYWORD_RULES) for (const k of kws) ex.push([k, cat]);
  for (const [kws, cat] of SAVINGS_KEYWORD_RULES) for (const k of kws) ex.push([k, cat]);
  for (const [raw, cat] of Object.entries(CC_CATEGORY_MAP)) ex.push([raw, cat]);
  return ex;
}

// ── Merchant normalisation ─────────────────────────────────────────────────────

const PREFIX_RE  = /^(withdrawal from|deposit from|withdrawal to|deposit to|transfer to|transfer from)\s+/i;
const CLEANUP_RE = /[X]+\d+|\d{6,}|[*#@]/gi;

export function normalizeMerchant(description) {
  let s = String(description).trim().replace(PREFIX_RE, '');
  s = s.replace(CLEANUP_RE, '').trim();
  return s.split(/\s+/).filter(Boolean).slice(0, 4).join(' ').trim();
}

// Python's str.title(): capitalise each run of letters, lowercase the rest.
function titleCase(s) {
  return s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

export function categorizeCC(raw) {
  const r = raw.trim();
  return CC_CATEGORY_MAP[r.toLowerCase()] || titleCase(r);
}

// ── Parsing ────────────────────────────────────────────────────────────────────

export function parseDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return iso(y, +m[1], +m[2]);
  }
  const d = new Date(s);
  return isNaN(d) ? null : iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function iso(y, mo, d) {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseAmount(v) {
  if (v == null) return NaN;
  const s = String(v).replace(/[$,\s]/g, '');
  if (s === '') return NaN;
  return Number(s);
}

export function detectFormat(headers) {
  const cols = new Set(headers.map(h => h.trim().toLowerCase()));
  if (cols.has('transaction type') && cols.has('transaction amount')) return 'bank';
  if (cols.has('debit') && cols.has('credit') && cols.has('card no.')) return 'credit_card';
  return 'unknown';
}

// Checking and savings exports have the same columns. In order of trust: what
// this account was last time (`known`, last four digits -> kind), the file name,
// then the text of the rows. The first matters most: a short savings export may
// hold nothing but an interest line, and filing it as a second checking account
// would count its balance twice.
function bankKind(rows, last4, { known = {}, name = '' } = {}, single = true) {
  if (known[last4]) return known[last4];
  if (single && /sav|money ?market/i.test(name)) return 'savings';
  if (single && /check/i.test(name)) return 'checking';
  const text = rows.map(r => (r['Transaction Description'] || '').toLowerCase()).join(' ');
  // Savings receives deposits FROM checking; checking only sends TO savings.
  if (text.includes('from 360 checking') || text.includes('to 360 checking')) return 'savings';
  return 'checking';
}

// The accounts already stored, as last four digits -> kind.
export function knownAccounts(stored) {
  const known = {};
  for (const t of stored) {
    if (t.kind !== 'checking' && t.kind !== 'savings') continue;
    const k = t.account.slice(-4);
    if (known[k] !== 'savings') known[k] = t.kind;
  }
  return known;
}

// One file -> stored transactions. `ord` orders rows within a day (bank exports
// list newest first). Accounts and cards are read per row: one card export can
// hold several card numbers, and which comes first changes between exports.
export function parseFile(text, hints = {}) {
  const { headers, rows } = parseCsv(text);
  let format = detectFormat(headers);
  const out = [];
  if (format === 'bank') {
    const byAcct = new Map();
    for (const r of rows) {
      const k = String(r['Account Number'] || '').trim().slice(-4);
      if (!byAcct.has(k)) byAcct.set(k, []);
      byAcct.get(k).push(r);
    }
    const kinds = new Map([...byAcct].map(([k, list]) => [k, bankKind(list, k, hints, byAcct.size === 1)]));
    format = kinds.values().next().value || 'checking';
    rows.forEach((r, i) => {
      const date = parseDate(r['Transaction Date']);
      const amount = parseAmount(r['Transaction Amount']);
      if (!date || isNaN(amount)) return;
      const bal = parseAmount(r['Balance']);
      const last4 = String(r['Account Number'] || '').trim().slice(-4);
      const kind = kinds.get(last4);
      const credit = String(r['Transaction Type']).trim().toLowerCase() === 'credit';
      out.push({
        date,
        description: String(r['Transaction Description'] || '').trim(),
        kind,
        account: `${kind === 'savings' ? 'Savings' : 'Checking'} ...${last4}`,
        amount: round2(credit ? amount : -amount),
        balance: isNaN(bal) ? null : bal,
        raw_category: '',
        ord: rows.length - i,
      });
    });
  } else if (format === 'credit_card') {
    rows.forEach((r, i) => {
      const date = parseDate(r['Transaction Date']) || parseDate(r['Posted Date']);
      if (!date) return;
      const debit = parseAmount(r['Debit']);
      const credit = parseAmount(r['Credit']);
      if (isNaN(debit) && isNaN(credit)) return;
      out.push({
        date,
        description: String(r['Description'] || '').trim(),
        kind: 'credit_card',
        account: `Credit Card ...${String(r['Card No.'] || '').trim().slice(-4)}`,
        amount: round2((isNaN(credit) ? 0 : credit) - (isNaN(debit) ? 0 : debit)),
        balance: null,
        raw_category: String(r['Category'] || '').trim(),
        ord: rows.length - i,
      });
    });
  }
  assignIds(out);
  return { format, transactions: out };
}

// Heals data saved before accounts were remembered: if the same four digits are
// stored as both a checking and a savings account, they are one savings account.
// Returns the same array when there is nothing to fix.
export function repairStored(stored) {
  const kinds = new Map();
  for (const t of stored) {
    if (t.kind !== 'checking' && t.kind !== 'savings') continue;
    const k = t.account.slice(-4);
    if (!kinds.has(k)) kinds.set(k, new Set());
    kinds.get(k).add(t.kind);
  }
  const both = new Set([...kinds].filter(([, v]) => v.size > 1).map(([k]) => k));
  if (!both.size) return stored;
  const seen = new Set(), out = [];
  for (let t of stored) {
    if (t.kind === 'checking' && both.has(t.account.slice(-4))) {
      const account = `Savings ...${t.account.slice(-4)}`;
      t = { ...t, kind: 'savings', account, id: account + t.id.slice(t.account.length) };
    }
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

// A transaction's id is its content plus which occurrence of that content it is
// within the file, so overlapping exports dedupe while two genuinely identical
// purchases on one day both survive.
function assignIds(txns) {
  const seen = new Map();
  for (const t of txns) {
    const base = [t.account, t.date, t.amount.toFixed(2), t.description, t.balance ?? ''].join('|');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    t.id = `${base}#${n}`;
  }
}

export function mergeTransactions(existing, incoming) {
  const ids = new Set(existing.map(t => t.id));
  const added = incoming.filter(t => !ids.has(t.id));
  return { merged: existing.concat(added), added: added.length, skipped: incoming.length - added.length };
}

// ── Categorisation ─────────────────────────────────────────────────────────────

export function buildCategorizer(rules, training) {
  const corpus = seedExamples();
  for (const [m, c] of Object.entries(rules.merchant || {})) corpus.push([m, c]);
  for (const ex of training || []) corpus.push([ex.text, ex.category]);
  return new Categorizer(corpus);
}

// -> [category, is_transfer, guessed]. `guessed` is true when nothing but the
// similarity matcher chose the category.
function baseCategory(t, ml) {
  if (t.kind === 'credit_card') {
    let cat = t.raw_category ? categorizeCC(t.raw_category) : 'Other';
    const up = t.description.toUpperCase();
    if (up.includes('COTFLT') || up.includes('COTHTL')) cat = 'Travel';
    return [cat, TRANSFER_CATEGORIES.has(cat), false];
  }
  const d = t.description.toLowerCase();
  const table = t.kind === 'savings' ? SAVINGS_KEYWORD_RULES : CHECKING_KEYWORD_RULES;
  for (const [kws, cat, isXfr] of table) {
    if (kws.some(k => hasKeyword(d, k))) {
      return [cat, t.kind === 'savings' ? isXfr : TRANSFER_CATEGORIES.has(cat), false];
    }
  }
  const cat = ml.predict(t.description) || 'Other';
  return [cat, t.kind === 'savings' ? false : TRANSFER_CATEGORIES.has(cat), true];
}

export function amountRuleMatches(rule, merchant, absAmount) {
  const allowed = rule.tolerance_pct > 0 ? rule.amount * rule.tolerance_pct / 100 : 0.01;
  return rule.merchant === merchant && Math.abs(absAmount - rule.amount) <= allowed;
}

// Stored transactions -> display transactions, newest first.
export function categorize(stored, rules, training, ml = buildCategorizer(rules, training)) {
  const merchantRules = rules.merchant || {};
  const amountRules = rules.amount_rules || [];
  const out = stored.map(t => {
    const merchant = normalizeMerchant(t.description);
    let [category, isTransfer, guessed] = baseCategory(t, ml);
    if (Object.prototype.hasOwnProperty.call(merchantRules, merchant)) {
      category = merchantRules[merchant];
      isTransfer = TRANSFER_CATEGORIES.has(category);
      guessed = false;
    }
    const absAmt = Math.abs(t.amount);
    for (const r of amountRules) {
      if (amountRuleMatches(r, merchant, absAmt)) {
        category = r.category;
        isTransfer = TRANSFER_CATEGORIES.has(category);
        guessed = false;
      }
    }
    // Money coming back is not income. Every credit on a card that is not a
    // payment is a refund. A bank deposit is one only when it is filed under a
    // spending category and either says so or was filed there by your own rule:
    // a paycheck the matcher mislabelled must not vanish from income.
    const refund = t.amount > 0 && !isTransfer && (
      t.kind === 'credit_card'
      || (!NOT_SPENDING.has(category) && (REFUND_RE.test(t.description) || (!guessed && fromRule(merchantRules, amountRules, merchant, absAmt)))));
    return {
      id: t.id,
      kind: t.kind,
      ts: localTs(t.date),
      date_iso: t.date,
      date_fmt: fmtDate(t.date),
      description: t.description,
      merchant,
      category,
      amount: t.amount,
      account: t.account,
      balance: t.balance,
      ord: t.ord || 0,
      is_transfer: isTransfer,
      refund,
    };
  });
  orderWithinDays(out);
  out.sort((a, b) => b.ts - a.ts || b.ord - a.ord);
  return out;
}

function fromRule(merchantRules, amountRules, merchant, absAmt) {
  return Object.prototype.hasOwnProperty.call(merchantRules, merchant)
    || amountRules.some(r => amountRuleMatches(r, merchant, absAmt));
}

// Rows of one bank account on one day, put in the order they happened. `ord`
// only orders rows within the file they came from, so a small refresh and an
// older, larger export disagree. The balances do not: each row opens on the
// balance the one before it closed on.
const cents = n => Math.round(n * 100);
function chain(rows) {
  const left = [...rows];
  const start = left.findIndex(r => !left.some(o => o !== r && cents(o.balance) === cents(r.balance - r.amount)));
  if (start < 0) return null;
  const out = left.splice(start, 1);
  while (left.length) {
    const prev = out[out.length - 1];
    const i = left.findIndex(r => cents(r.balance - r.amount) === cents(prev.balance));
    if (i < 0) return null;
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}
function orderWithinDays(txns) {
  const groups = new Map();
  for (const t of txns) {
    if (t.balance == null) continue;
    const k = t.account + '|' + t.date_iso;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  for (const g of groups.values()) {
    if (g.length < 2 || g.length > 200) continue;
    const ordered = chain(g);
    if (ordered) ordered.forEach((t, i) => { t.ord = i + 1; });
  }
}

// ── Recurring streams ──────────────────────────────────────────────────────────

export function findRecurringStreams(txns) {
  const groups = new Map();
  for (const t of txns) {
    if (t.is_transfer) continue;
    if (!groups.has(t.merchant)) groups.set(t.merchant, []);
    groups.get(t.merchant).push(t);
  }
  const streams = [];
  for (const [merchant, group] of groups) {
    if (group.length < 3) continue;
    group.sort((a, b) => a.ts - b.ts || a.ord - b.ord);
    const intervals = [];
    for (let i = 0; i < group.length - 1; i++) {
      intervals.push(daysBetween(group[i].date_iso, group[i + 1].date_iso));
    }
    const avgInt = mean(intervals);
    const stdInt = intervals.length > 1 ? Math.sqrt(mean(intervals.map(x => (x - avgInt) ** 2))) : 0;
    if (avgInt === 0 || stdInt / avgInt >= 0.5) continue;

    let freq;
    if (avgInt < 10) freq = 'Weekly';
    else if (avgInt < 20) freq = 'Bi-weekly';
    else if (avgInt < 45) freq = 'Monthly';
    else if (avgInt < 100) freq = 'Quarterly';
    else freq = 'Occasional';

    streams.push({
      merchant,
      frequency: freq,
      avg_amount: round2(mean(group.map(t => Math.abs(t.amount)))),
      occurrences: group.length,
      last_date: group[group.length - 1].date_fmt,
      direction: mean(group.map(t => t.amount)) > 0 ? 'income' : 'expense',
      category: mode(group.map(t => t.category)),
      transactions: group.map(t => ({ date: t.date_fmt, amount: t.amount })),
    });
  }
  streams.sort((a, b) => b.avg_amount - a.avg_amount);
  return streams.slice(0, 20);
}

// ── Combined assets over time ──────────────────────────────────────────────────

// Every bank account's latest balance, minus the credit card balance rebuilt
// from the starting balance forward, for each day anything happened.
// An account that has no rows yet on a given day is carried at the balance it
// had just before its first row, so the line does not jump when a second
// export starts later than the first. `legacy` reproduces the Python original
// (such accounts count as zero, and card-only days are skipped).
export function buildAssetSeries(txns, ccStart = 0, { legacy = false } = {}) {
  const chron = [...txns].sort((a, b) => a.ts - b.ts || a.ord - b.ord);
  const bank = chron.filter(t => t.balance != null && !t.account.startsWith('Credit Card'));
  if (!bank.length) return [];
  const cc = chron.filter(t => t.account.startsWith('Credit Card'));

  const latest = {};
  let days = bank.map(t => t.date_iso);
  if (!legacy) {
    for (const t of bank) if (!(t.account in latest)) latest[t.account] = t.balance - t.amount;
    days = days.concat(cc.map(t => t.date_iso).filter(d => d >= bank[0].date_iso));
  }
  const dates = [...new Set(days)].sort();
  let bi = 0, ci = 0, ccCum = ccStart;
  const out = [];
  for (const date of dates) {
    while (bi < bank.length && bank[bi].date_iso <= date) {
      latest[bank[bi].account] = bank[bi].balance;
      bi++;
    }
    while (ci < cc.length && cc[ci].date_iso <= date) {
      ccCum += -cc[ci].amount;
      ci++;
    }
    const totalBank = Object.values(latest).reduce((s, v) => s + v, 0);
    const ccOut = cc.length && (ci > 0 || !legacy) ? round2(Math.max(0, ccCum)) : 0;
    out.push({
      date,
      total_bank: round2(totalBank),
      cc_outstanding: ccOut,
      net: round2(totalBank - ccOut),
    });
  }
  return out;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function round2(n) { return Math.round(n * 100) / 100; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function mode(a) {
  const counts = new Map();
  for (const x of a) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null, bestN = -1;
  for (const [k, n] of [...counts].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}
function daysBetween(a, b) { return Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / 86400000); }
function ymd(s) { const [y, m, d] = s.split('-').map(Number); return [y, m - 1, d]; }
export function localTs(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(s) { const [y, m, d] = s.split('-').map(Number); return `${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`; }
