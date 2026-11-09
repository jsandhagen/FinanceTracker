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

  [['360 performance savings', 'transfer to savings', 'transfer from savings'], 'Savings Transfer', true],
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
  [['360 checking', 'from 360 checking', 'to 360 checking'], 'Savings Transfer', true],
  [['dept education', 'student ln', 'dept of education', 'student loan',
    'sallie mae', 'navient'], 'Loan Payment', true],
];

export const TRANSFER_CATEGORIES = new Set([
  'Savings Transfer', 'Credit Card Payment', 'Loan Payment', 'P2P Transfer', 'Payment',
]);

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

export function detectFormat(headers, rows) {
  const cols = new Set(headers.map(h => h.trim().toLowerCase()));
  if (cols.has('transaction type') && cols.has('transaction amount')) {
    if (headers.includes('Transaction Description')) {
      const sample = rows.map(r => (r['Transaction Description'] || '').toLowerCase()).join(' ');
      // Savings receives deposits FROM checking; checking only sends TO savings.
      if (sample.includes('deposit from 360 checking') || sample.includes('from 360 checking')) {
        return 'savings';
      }
    }
    return 'checking';
  }
  if (cols.has('debit') && cols.has('credit') && cols.has('card no.')) return 'credit_card';
  return 'unknown';
}

// One file -> stored transactions. `ord` orders rows within a day (bank exports
// list newest first), so the balance chart can take a day's closing balance.
export function parseFile(text) {
  const { headers, rows } = parseCsv(text);
  const format = detectFormat(headers, rows);
  const out = [];
  if (format === 'checking' || format === 'savings') {
    const acctNum = String(rows[0]?.['Account Number'] || '').trim();
    const label = `${format === 'savings' ? 'Savings' : 'Checking'} ...${acctNum.slice(-4)}`;
    rows.forEach((r, i) => {
      const date = parseDate(r['Transaction Date']);
      const amount = parseAmount(r['Transaction Amount']);
      if (!date || isNaN(amount)) return;
      const bal = parseAmount(r['Balance']);
      const credit = String(r['Transaction Type']).trim() === 'Credit';
      out.push({
        date,
        description: String(r['Transaction Description'] || '').trim(),
        kind: format,
        account: label,
        amount: round2(credit ? amount : -amount),
        balance: isNaN(bal) ? null : bal,
        raw_category: '',
        ord: rows.length - i,
      });
    });
  } else if (format === 'credit_card') {
    const card = String(rows[0]?.['Card No.'] || '').trim().slice(-4);
    const label = `Credit Card ...${card}`;
    rows.forEach((r, i) => {
      const date = parseDate(r['Transaction Date']);
      if (!date) return;
      const debit = parseAmount(r['Debit']);
      const credit = parseAmount(r['Credit']);
      out.push({
        date,
        description: String(r['Description'] || '').trim(),
        kind: 'credit_card',
        account: label,
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

function baseCategory(t, ml) {
  if (t.kind === 'credit_card') {
    let cat = t.raw_category ? categorizeCC(t.raw_category) : 'Other';
    const up = t.description.toUpperCase();
    if (up.includes('COTFLT') || up.includes('COTHTL')) cat = 'Travel';
    return [cat, TRANSFER_CATEGORIES.has(cat)];
  }
  const d = t.description.toLowerCase();
  const table = t.kind === 'savings' ? SAVINGS_KEYWORD_RULES : CHECKING_KEYWORD_RULES;
  for (const [kws, cat, isXfr] of table) {
    if (kws.some(k => d.includes(k))) {
      return [cat, t.kind === 'savings' ? isXfr : TRANSFER_CATEGORIES.has(cat)];
    }
  }
  const cat = ml.predict(t.description) || 'Other';
  return [cat, t.kind === 'savings' ? false : TRANSFER_CATEGORIES.has(cat)];
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
    let [category, isTransfer] = baseCategory(t, ml);
    if (Object.prototype.hasOwnProperty.call(merchantRules, merchant)) {
      category = merchantRules[merchant];
      isTransfer = TRANSFER_CATEGORIES.has(category);
    }
    const absAmt = Math.abs(t.amount);
    for (const r of amountRules) {
      if (amountRuleMatches(r, merchant, absAmt)) {
        category = r.category;
        isTransfer = TRANSFER_CATEGORIES.has(category);
      }
    }
    return {
      id: t.id,
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
    };
  });
  out.sort((a, b) => b.ts - a.ts || b.ord - a.ord);
  return out;
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

// For each day with a bank balance: every bank account's latest balance, minus
// the credit card balance reconstructed from the starting balance forward.
export function buildAssetSeries(txns, ccStart = 0) {
  const chron = [...txns].sort((a, b) => a.ts - b.ts || a.ord - b.ord);
  const bank = chron.filter(t => t.balance != null && !t.account.startsWith('Credit Card'));
  if (!bank.length) return [];
  const cc = chron.filter(t => t.account.startsWith('Credit Card'));

  const dates = [...new Set(bank.map(t => t.date_iso))].sort();
  const latest = {};
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
    const ccOut = cc.length && ci > 0 ? round2(Math.max(0, ccCum)) : 0;
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
