// Bank connections through Plaid.
//
// There are two ways to reach Plaid, chosen when the connection is set up:
//
//   direct  The app calls Plaid's API itself, with your Plaid client id and
//           secret kept on this device. Nothing else to run. It works only if
//           Plaid's API accepts requests from a web page, which is Plaid's
//           decision, not this app's: a browser will not hand a page the
//           answer from another site unless that site allows it.
//   relay   The app calls a small program you host (server/plaid-worker.js),
//           which holds the keys and calls Plaid. For when direct is refused.
//
// Either way the same four requests are made (see `call`), and everything
// above the "Talking to Plaid" line is pure and runs under Node.

const round2 = n => Math.round(n * 100) / 100;
const cents = n => Math.round(n * 100);
const dayNum = iso => { const [y, m, d] = iso.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };

export const isPlaid = t => t.source === 'plaid';
export const emptyState = () => ({ items: [], anchors: {}, cards: {}, alias: {}, removed: [] });

// A Plaid account -> the account name and kind the rest of the app uses, the
// same names a Capital One CSV produces, so both sources land in one account.
// Loans and investments are left out (null).
export function accountLabel(a) {
  const tail = a.mask || String(a.account_id || '').slice(-4);
  if (a.type === 'credit') return { kind: 'credit_card', account: `Credit Card ...${tail}` };
  if (a.type !== 'depository') return null;
  return /sav|money market|cd|hsa/i.test(a.subtype || '')
    ? { kind: 'savings', account: `Savings ...${tail}` }
    : { kind: 'checking', account: `Checking ...${tail}` };
}

// A Plaid transaction -> a stored row. Plaid counts money leaving as positive;
// the app counts it as negative. A card purchase is dated the day it was made,
// which is the date a card export carries.
export function toStored(tx, label) {
  const pfc = tx.personal_finance_category || {};
  return {
    id: `plaid:${tx.transaction_id}`,
    source: 'plaid',
    date: (label.kind === 'credit_card' && tx.authorized_date) || tx.date,
    description: String(tx.original_description || tx.name || tx.merchant_name || '').replace(/\s+/g, ' ').trim(),
    kind: label.kind,
    account: label.account,
    amount: round2(-Number(tx.amount)),
    balance: null,
    raw_category: [pfc.primary, pfc.detailed].filter(Boolean).join('|'),
    ord: 0,
  };
}

// Folds one bank's /sync answer into the stored transactions and the saved
// Plaid state (`ps`, changed in place). Pending transactions are skipped: they
// change or vanish when they post. Returns the new transaction list.
export function applySync(transactions, ps, item, res, now = Date.now()) {
  const labels = new Map();
  for (const a of res.accounts || []) {
    const l = accountLabel(a);
    if (!l) continue;
    const account = ps.alias[l.account] || l.account;
    labels.set(a.account_id, { kind: l.kind, account });
    const bal = a.balances?.current;
    if (typeof bal !== 'number') continue;
    // A bank account's balance is money held; a card's is money owed.
    if (l.kind === 'credit_card') (ps.cards || (ps.cards = {}))[account] = { balance: bal, at: now };
    else ps.anchors[account] = { balance: bal, at: now };
  }
  const byId = new Map(transactions.map(t => [t.id, t]));
  const gone = new Set((res.removed || []).map(id => `plaid:${id}`));
  for (const tx of [...(res.added || []), ...(res.modified || [])]) {
    const label = labels.get(tx.account_id);
    if (!label || !tx.date) continue;
    if (tx.pending) { gone.add(`plaid:${tx.transaction_id}`); continue; }
    const row = toStored(tx, label);
    gone.delete(row.id);
    byId.set(row.id, row);
  }
  for (const id of gone) byId.delete(id);
  // Remembered so a copy on another device does not bring them back in a merge.
  ps.removed = [...new Set([...ps.removed, ...(res.removed || []).map(id => `plaid:${id}`)])].slice(-2000);
  item.cursor = res.cursor;
  item.accounts = [...new Map([...labels.values()].map(l => [l.account, l])).values()];
  item.lastSync = now;
  item.error = null;
  return [...byId.values()];
}

// A transaction that came from both a CSV export and Plaid is kept once, as the
// CSV row (it carries the bank's own balance). A Plaid row is a duplicate when
// a CSV row of the same account has the same amount on the same day, or within
// a couple of days (posting dates drift). Each CSV row can stand in for one
// Plaid row only, and remembers which (`twin`), so running this again never
// pairs it with a second, genuinely separate purchase of the same amount.
//
// A card's number on a CSV and its number at Plaid can differ. When two or more
// purchases on a Plaid card match one CSV card, they are the same card: the
// Plaid rows take the CSV card's name, and the pairing is returned in `alias`
// so later syncs use it from the start.
//
// That only makes sense for cards from the bank the CSVs come from. A card from
// another bank (`ownCards` lists the ones that may be paired) is a different
// card however alike two purchases look, and is matched by its own name only.
//
// Returns { transactions, alias } and the same array when nothing changed.
export function reconcile(transactions, { removed = [], alias = {}, ownCards = null } = {}) {
  if (!transactions.some(isPlaid)) return { transactions, alias };
  const dead = new Set(removed);
  for (const t of transactions) if (t.twin) dead.add(t.twin);
  let changed = false;
  let rows = transactions.filter(t => !(isPlaid(t) && dead.has(t.id)));
  if (rows.length !== transactions.length) changed = true;
  rows = rows.map(t => {
    if (!isPlaid(t) || !alias[t.account]) return t;
    changed = true;
    return { ...t, account: alias[t.account] };
  });

  const pool = new Map(); // kind|cents -> CSV rows not yet matched
  for (const t of rows) {
    if (isPlaid(t)) continue;
    const k = `${t.kind}|${cents(t.amount)}`;
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push({ t, day: dayNum(t.date), used: !!t.twin });
  }
  const plaidRows = rows.filter(isPlaid).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const drop = new Set(), pairs = new Map(), twins = new Map();
  const match = (p, reach) => {
    const day = dayNum(p.date), card = p.kind === 'credit_card' && (!ownCards || ownCards.has(p.account));
    let best = null, bestScore = Infinity;
    for (const c of pool.get(`${p.kind}|${cents(p.amount)}`) || []) {
      if (c.used) continue;
      const gap = Math.abs(c.day - day), same = c.t.account === p.account;
      if (gap > reach || (!same && !card)) continue;
      const score = gap + (same ? 0 : 0.5);
      if (score < bestScore) { best = c; bestScore = score; }
    }
    if (!best) return;
    best.used = true;
    drop.add(p.id);
    twins.set(best.t.id, p.id);
    if (best.t.account !== p.account) {
      const k = `${p.account}\n${best.t.account}`;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  };
  for (const p of plaidRows) match(p, 0);                      // same day first
  for (const p of plaidRows) if (!drop.has(p.id)) match(p, p.kind === 'credit_card' ? 5 : 2);

  const learned = { ...alias };
  for (const [k, n] of pairs) {
    const [from, to] = k.split('\n');
    if (n >= 2 && !learned[from]) learned[from] = to;
  }
  if (!drop.size && !changed) return { transactions, alias };
  const out = rows.filter(t => !drop.has(t.id)).map(t => (
    twins.has(t.id) ? { ...t, twin: twins.get(t.id) }
      : isPlaid(t) && learned[t.account] ? { ...t, account: learned[t.account] } : t));
  return { transactions: out, alias: learned };
}

// Plaid lists transactions without the balance after each one, which the net
// worth chart is drawn from. It is rebuilt here, per bank account:
//   - after the last row that has a real balance (a CSV row), Plaid rows are
//     walked back from the account's current balance, when one is known, and
//     forward from that last real balance otherwise;
//   - between and before real balances, they are chained onto them.
// Recomputed from scratch each time, so a late-arriving transaction cannot
// leave a stale figure behind. Returns the same array when nothing changed.
export function fillBalances(transactions, anchors = {}) {
  if (!transactions.some(t => isPlaid(t) && t.kind !== 'credit_card')) return transactions;
  const byAcct = new Map();
  transactions.forEach((t, i) => {
    if (t.kind === 'credit_card') return;
    if (!byAcct.has(t.account)) byAcct.set(t.account, []);
    byAcct.get(t.account).push({ t, i });
  });
  const next = new Map(); // index -> { balance, ord }
  for (const [account, list] of byAcct) {
    if (!list.some(x => isPlaid(x.t))) continue;
    list.sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : (a.t.ord || 0) - (b.t.ord || 0) || a.i - b.i));
    const fixed = x => !isPlaid(x.t) && x.t.balance != null;
    const bal = list.map(x => (fixed(x) ? x.t.balance : null));
    const n = list.length;
    let lastFixed = -1;
    for (let i = 0; i < n; i++) if (fixed(list[i])) lastFixed = i;
    const anchor = anchors[account]?.balance;
    if (lastFixed < n - 1 && typeof anchor === 'number') {
      bal[n - 1] = anchor;
      for (let i = n - 2; i > lastFixed; i--) bal[i] = bal[i + 1] - list[i + 1].t.amount;
    }
    for (let i = 1; i < n; i++) if (bal[i] == null && bal[i - 1] != null) bal[i] = bal[i - 1] + list[i].t.amount;
    for (let i = n - 2; i >= 0; i--) if (bal[i] == null && bal[i + 1] != null) bal[i] = bal[i + 1] - list[i + 1].t.amount;
    // Rows of one day keep the order the balances were worked out in.
    let day = null, k = 0;
    list.forEach((x, i) => {
      k = x.t.date === day ? k + 1 : 1; day = x.t.date;
      if (!isPlaid(x.t)) return;
      const balance = bal[i] == null ? null : round2(bal[i]);
      if (x.t.balance !== balance || x.t.ord !== k) next.set(x.i, { balance, ord: k });
    });
  }
  if (!next.size) return transactions;
  return transactions.map((t, i) => (next.has(i) ? { ...t, ...next.get(i) } : t));
}

// Everything a list of transactions needs after Plaid rows were added or a
// copy from another device was merged in. `ps` is the saved Plaid state; its
// alias map is updated in place.
export function tidy(transactions, ps) {
  if (!ps) return transactions;
  const r = reconcile(transactions, { removed: ps.removed, alias: ps.alias, ownCards: csvBankCards(ps) });
  ps.alias = r.alias;
  return fillBalances(r.transactions, ps.anchors);
}

// CSV exports are Capital One's, so only a Capital One card at Plaid can be the
// same card as one in a CSV.
export function csvBankCards(ps) {
  const own = new Set();
  for (const it of ps.items || []) {
    if (!/capital\s*one/i.test(it.name || '')) continue;
    for (const a of it.accounts || []) if (a.kind === 'credit_card') own.add(a.account);
  }
  return own;
}

// What was owed across all cards before the first stored transaction, which is
// what the net worth chart starts its card line from. A linked card reports
// what is owed today, so its starting figure is that less everything charged
// and paid since. Cards without a connection share the figure typed in
// Settings (`typed`); when every card is linked, that figure is not needed.
export function cardStart(transactions, cards = {}, typed = 0) {
  const moved = new Map(); // card -> net charged over its stored rows
  for (const t of transactions) if (t.kind === 'credit_card') moved.set(t.account, (moved.get(t.account) || 0) - t.amount);
  let start = 0, unlinked = false;
  for (const [account, net] of moved) {
    const known = cards[account]?.balance;
    if (typeof known === 'number') start += known - net; else unlinked = true;
  }
  return round2(start + (unlinked ? Number(typed) || 0 : 0));
}

// The relay's address as typed -> a clean https address, or null. Plain http
// is allowed only for a relay running on this computer.
export function cleanRelay(raw) {
  try {
    const u = new URL(String(raw).trim());
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

// ── Talking to Plaid ─────────────────────────────────────────────────────────

const HOSTS = { production: 'https://production.plaid.com', sandbox: 'https://sandbox.plaid.com' };
const HISTORY_DAYS = 730; // the most Plaid offers

async function plaidPost(conn, path, body) {
  let res;
  try {
    res = await fetch((HOSTS[conn.env] || HOSTS.production) + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: conn.clientId, secret: conn.secret, ...body }),
    });
  } catch {
    // The browser gives a page no detail here: a refused cross-site request
    // and a dropped connection look the same.
    const offline = globalThis.navigator?.onLine === false;
    const e = new Error(offline ? 'You are offline.' : 'The browser was not allowed to reach Plaid from this page. Plaid\'s API does not accept requests from web pages, so a direct connection is not possible; use a relay instead.');
    e.code = offline ? 'OFFLINE' : 'BLOCKED';
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error_message || `Plaid answered ${res.status}.`);
    e.code = data.error_code || null;
    throw e;
  }
  return data;
}

// The same four requests the relay answers, made straight to Plaid. In this
// mode a bank's access token is kept as it is: without the secret, which never
// leaves this device, it opens nothing.
const direct = {
  async 'link-token'(conn, body) {
    const req = { client_name: 'FinanceTracker', language: 'en', country_codes: ['US'], user: { client_user_id: 'financetracker-owner' } };
    if (body.item) req.access_token = body.item;
    else { req.products = ['transactions']; req.transactions = { days_requested: HISTORY_DAYS }; }
    if (body.redirect_uri) req.redirect_uri = body.redirect_uri;
    return { link_token: (await plaidPost(conn, '/link/token/create', req)).link_token };
  },
  async exchange(conn, body) {
    const r = await plaidPost(conn, '/item/public_token/exchange', { public_token: body.public_token });
    return { item: r.access_token, item_id: r.item_id };
  },
  async sync(conn, body) {
    for (let attempt = 0; ; attempt++) {
      const added = [], modified = [], removed = [];
      let cursor = body.cursor || null, more = true, accounts = null;
      try {
        for (let pages = 0; more; pages++) {
          if (pages >= 40) throw new Error('Too much history for one request. Sync again to continue.');
          const r = await plaidPost(conn, '/transactions/sync', {
            access_token: body.item, count: 500, ...(cursor ? { cursor } : {}),
            options: { include_original_description: true, days_requested: HISTORY_DAYS },
          });
          added.push(...r.added); modified.push(...r.modified);
          removed.push(...r.removed.map(x => x.transaction_id));
          if (r.accounts) accounts = r.accounts;
          cursor = r.next_cursor; more = r.has_more;
        }
      } catch (e) {
        if (e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt === 0) continue;
        throw e;
      }
      if (!accounts) accounts = (await plaidPost(conn, '/accounts/get', { access_token: body.item })).accounts;
      return { added, modified, removed, cursor, accounts };
    }
  },
  async remove(conn, body) {
    try { await plaidPost(conn, '/item/remove', { access_token: body.item }); }
    catch (e) { if (e.code !== 'ITEM_NOT_FOUND') throw e; }
    return { removed: true };
  },
};

// conn is { mode: 'direct', clientId, secret, env } or { url, key } for a relay.
// Errors carry Plaid's code (e.g. ITEM_LOGIN_REQUIRED).
export async function call(conn, path, body = {}) {
  if (conn.mode === 'direct') return direct[path](conn, body);
  let res;
  try {
    res = await fetch(`${conn.url}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.key}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the bank connection relay. Check its address and your connection.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error(res.status === 401 ? 'The relay rejected the access key.' : data?.error || `The relay answered ${res.status}.`);
    e.code = data?.code || null;
    throw e;
  }
  return data;
}

// Plaid Link, the window where you sign in to your bank. Plaid requires it to
// be loaded from their own address, so it is fetched only when it is needed.
let linkScript = null;
function loadLink() {
  if (window.Plaid) return Promise.resolve();
  if (!linkScript) {
    linkScript = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      s.onload = resolve;
      s.onerror = () => { linkScript = null; s.remove(); reject(new Error('Could not load Plaid. Check your connection.')); };
      document.head.appendChild(s);
    });
  }
  return linkScript;
}

// Opens Link. Resolves with { public_token, institution } once a bank is
// linked, or null if the window was closed. `receivedRedirectUri` continues a
// sign-in that left for the bank's own site and came back.
export async function openLink(token, receivedRedirectUri = null) {
  await loadLink();
  return new Promise(resolve => {
    const handler = window.Plaid.create({
      token,
      ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
      onSuccess: (public_token, metadata) => { resolve({ public_token, institution: metadata?.institution?.name || 'Bank' }); handler.destroy?.(); },
      onExit: () => { resolve(null); handler.destroy?.(); },
    });
    handler.open();
  });
}
