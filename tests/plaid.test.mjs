// Plaid: turning its transactions into stored rows, keeping one copy of what a
// CSV also holds, rebuilding balances, and the relay Worker against a stand-in
// for Plaid's API. Nothing here touches the network.
import * as P from '../js/plaid.js';
import * as A from '../js/analyzer.js';
import worker from '../server/plaid-worker.js';
import assert from 'node:assert/strict';

// ── Accounts and rows ──
assert.deepEqual(P.accountLabel({ type: 'depository', subtype: 'checking', mask: '1234' }), { kind: 'checking', account: 'Checking ...1234' });
assert.deepEqual(P.accountLabel({ type: 'depository', subtype: 'money market', mask: '5678' }), { kind: 'savings', account: 'Savings ...5678' });
assert.deepEqual(P.accountLabel({ type: 'credit', subtype: 'credit card', mask: '4321' }), { kind: 'credit_card', account: 'Credit Card ...4321' });
assert.equal(P.accountLabel({ type: 'loan', subtype: 'student', mask: '1' }), null);

const tx = (id, account_id, date, amount, name, pfc, extra = {}) => ({
  transaction_id: id, account_id, date, amount, name, pending: false,
  personal_finance_category: pfc ? { primary: pfc.split('|')[0], detailed: pfc.split('|')[1] } : null, ...extra,
});
const row = P.toStored(tx('t1', 'a', '2026-03-04', 42.5, 'Trader Joes', 'FOOD_AND_DRINK|FOOD_AND_DRINK_GROCERIES', { authorized_date: '2026-03-02', original_description: 'TRADER JOE S  552' }),
  { kind: 'credit_card', account: 'Credit Card ...4321' });
assert.equal(row.id, 'plaid:t1');
assert.equal(row.amount, -42.5, 'money out is negative here');
assert.equal(row.date, '2026-03-02', 'a card purchase is dated the day it was made');
assert.equal(row.description, 'TRADER JOE S 552');
assert.equal(row.raw_category, 'FOOD_AND_DRINK|FOOD_AND_DRINK_GROCERIES');

// ── Categories ──
assert.equal(A.plaidCategory('FOOD_AND_DRINK|FOOD_AND_DRINK_GROCERIES'), 'Groceries');
assert.equal(A.plaidCategory('FOOD_AND_DRINK|FOOD_AND_DRINK_COFFEE'), 'Dining');
assert.equal(A.plaidCategory('LOAN_PAYMENTS|LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'), 'Credit Card Payment');
assert.equal(A.plaidCategory(''), null);

const accounts = [
  { account_id: 'chk', type: 'depository', subtype: 'checking', mask: '1234', balances: { current: 1000 } },
  { account_id: 'cc', type: 'credit', subtype: 'credit card', mask: '9999', balances: { current: 250 } },
  { account_id: 'ira', type: 'investment', subtype: 'ira', mask: '0001', balances: { current: 5 } },
];
const res = {
  accounts, cursor: 'c1', removed: [],
  added: [
    tx('p1', 'chk', '2026-03-06', -3010, 'ACME CORP PAYROLL', 'INCOME|INCOME_WAGES'),
    tx('p2', 'chk', '2026-03-07', 450, 'Withdrawal to 360 Performance Savings', 'TRANSFER_OUT|TRANSFER_OUT_SAVINGS'),
    tx('p3', 'chk', '2026-03-08', 61.2, 'Some Unknown Shop', 'GENERAL_MERCHANDISE|GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE'),
    tx('p4', 'cc', '2026-03-05', 18.4, 'Chipotle', 'FOOD_AND_DRINK|FOOD_AND_DRINK_FAST_FOOD'),
    tx('p5', 'cc', '2026-03-09', -80, 'Amazon refund', 'GENERAL_MERCHANDISE|GENERAL_MERCHANDISE_ONLINE_MARKETPLACES'),
    tx('p6', 'cc', '2026-03-10', -500, 'CAPITAL ONE MOBILE PYMT', 'LOAN_PAYMENTS|LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'),
    tx('p7', 'chk', '2026-03-10', 9.99, 'Pending thing', null, { pending: true }),
    tx('p8', 'ira', '2026-03-10', 100, 'Fund purchase', null),
  ],
  modified: [],
};
let ps = P.emptyState();
const item = { id: 'item1', sealed: 'x', name: 'Capital One', cursor: null };
let stored = P.applySync([], ps, item, res, 1700000000000);
assert.equal(stored.length, 6, 'pending rows and investment accounts are left out');
assert.equal(item.cursor, 'c1');
assert.deepEqual(item.accounts.map(a => a.account).sort(), ['Checking ...1234', 'Credit Card ...9999']);
assert.equal(ps.anchors['Checking ...1234'].balance, 1000);
assert.ok(!ps.anchors['Credit Card ...9999'], 'a card balance is not a bank balance');

// The same answer again adds nothing.
assert.equal(P.applySync(stored, ps, item, res).length, 6);

// Through the categorizer: Plaid's categories, the bank's own transfer wording, refunds.
const cat = Object.fromEntries(A.categorize(P.tidy(stored, ps), { merchant: {}, amount_rules: [] }, []).map(t => [t.id, t]));
assert.equal(cat['plaid:p1'].category, 'Income');
assert.ok(cat['plaid:p2'].is_transfer && cat['plaid:p2'].category === 'Savings Transfer');
assert.equal(cat['plaid:p3'].category, 'Shopping');
assert.equal(cat['plaid:p4'].category, 'Dining');
assert.ok(cat['plaid:p5'].refund, 'money back on a card is a refund, not income');
assert.ok(cat['plaid:p6'].is_transfer, 'a card payment is a transfer');

// ── Balances rebuilt from the current balance ──
let filled = P.fillBalances(stored, ps.anchors);
const chk = filled.filter(t => t.account === 'Checking ...1234').sort((a, b) => (a.date < b.date ? -1 : 1));
assert.deepEqual(chk.map(t => t.balance), [1511.2, 1061.2, 1000], 'walked back from the current balance');
assert.ok(filled.filter(t => t.kind === 'credit_card').every(t => t.balance == null));
assert.equal(P.fillBalances(filled, ps.anchors), filled, 'nothing to do the second time');
// And the net worth series can be drawn from them.
const series = A.buildAssetSeries(A.categorize(filled, { merchant: {}, amount_rules: [] }, []));
assert.equal(series[series.length - 1].total_bank, 1000);

// Modified and removed transactions.
stored = P.applySync(filled, ps, item, { accounts, cursor: 'c2', added: [], removed: ['p3'],
  modified: [tx('p4', 'cc', '2026-03-05', 21.4, 'Chipotle', 'FOOD_AND_DRINK|FOOD_AND_DRINK_FAST_FOOD')] });
assert.equal(stored.length, 5);
assert.equal(stored.find(t => t.id === 'plaid:p4').amount, -21.4);
assert.ok(ps.removed.includes('plaid:p3'));
// A copy merged back in from another device does not resurrect it.
const back = P.reconcile([...stored, filled.find(t => t.id === 'plaid:p3')], { removed: ps.removed });
assert.ok(!back.transactions.some(t => t.id === 'plaid:p3'));

// ── One copy of what a CSV also holds ──
const bankCsv = ['Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance',
  '00001234,Some Unknown Shop,03/08/26,Debit,61.20,1000.00',
  '00001234,Withdrawal to 360 Performance Savings XXXXXXX5678,03/07/26,Debit,450.00,1061.20',
  '00001234,ACME CORP PAYROLL,03/06/26,Credit,3010.00,1511.20',
  '00001234,COFFEE,03/01/26,Debit,5.00,-1498.80',
  '00001234,COFFEE,03/01/26,Debit,5.00,-1493.80'].join('\n');
const csvRows = A.parseFile(bankCsv, { name: 'checking.csv' }).transactions;
const both = [...csvRows, ...P.applySync([], P.emptyState(), { id: 'i' }, { ...res, added: [...res.added,
  tx('p9', 'chk', '2026-03-01', 5, 'COFFEE', null), tx('p10', 'chk', '2026-03-02', 5, 'COFFEE', null),
  tx('p11', 'chk', '2026-03-03', 5, 'COFFEE', null), tx('p12', 'chk', '2026-03-11', 20, 'After the export', null)] })];
let rec = P.reconcile(both);
const keptPlaid = rec.transactions.filter(P.isPlaid).map(t => t.id).sort();
// p1-p3 and two of the three coffees are in the CSV; the third coffee and the later row are not.
assert.deepEqual(keptPlaid, ['plaid:p11', 'plaid:p12', 'plaid:p4', 'plaid:p5', 'plaid:p6']);
assert.equal(rec.transactions.filter(t => !P.isPlaid(t)).length, csvRows.length, 'CSV rows are never dropped');
// Each CSV row remembers its twin, so a copy of it arriving again (a merge from
// another device) is dropped and cannot be paired with anything else.
assert.equal(rec.transactions.filter(t => t.twin).length, 5);
assert.deepEqual(P.reconcile([...rec.transactions, both.find(t => t.id === 'plaid:p9')]).transactions.filter(P.isPlaid).map(t => t.id).sort(), keptPlaid);
assert.equal(P.reconcile(rec.transactions).transactions, rec.transactions, 'settled lists come back untouched');
assert.equal(P.reconcile(csvRows).transactions, csvRows);

// With real balances before them, Plaid rows chain onto the CSV's last balance
// when no current balance is known, and walk back from it when one is.
const after = P.fillBalances(rec.transactions, {}).filter(t => t.account === 'Checking ...1234' && P.isPlaid(t));
assert.equal(after.find(t => t.id === 'plaid:p12').balance, 980);
assert.equal(P.fillBalances(rec.transactions, { 'Checking ...1234': { balance: 700 } }).find(t => t.id === 'plaid:p12').balance, 700);

// A card whose number differs between the CSV and Plaid: two matches make them one card.
const cardCsv = ['Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit',
  '2026-03-04,2026-03-05,4321,CHIPOTLE 1234,Dining/Restaurant,18.40,',
  '2026-03-08,2026-03-09,4321,AMAZON.COM,Merchandise,,80.00'].join('\n');
const cardRows = A.parseFile(cardCsv).transactions;
rec = P.reconcile([...cardRows, ...P.applySync([], P.emptyState(), { id: 'i' }, res)]);
assert.deepEqual(rec.alias, { 'Credit Card ...9999': 'Credit Card ...4321' });
assert.ok(!rec.transactions.some(t => t.account === 'Credit Card ...9999'), 'the card is one account');
assert.deepEqual(rec.transactions.filter(t => P.isPlaid(t) && t.kind === 'credit_card').map(t => t.id), ['plaid:p6']);
// The pairing is used from the start on the next sync.
ps = { ...P.emptyState(), alias: rec.alias };
assert.ok(P.applySync([], ps, { id: 'i' }, res).filter(t => t.kind === 'credit_card').every(t => t.account === 'Credit Card ...4321'));
// One match alone is not enough to merge two cards.
assert.deepEqual(P.reconcile([cardRows[0], ...P.applySync([], P.emptyState(), { id: 'i' }, res)]).alias, {});

// ── A card from another bank, paid from the CSV bank's checking account ──
// Capital One checking and card arrive as CSVs; a Bank of America card arrives
// through Plaid and is paid from that checking account.
{
  const I = await import('../js/insights.js');
  const chkCsv = ['Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance',
    '00001234,ODD WORDING EPAY 8841,04/20/26,Debit,75.00,4375.00',
    '00001234,Withdrawal to BK OF AMER VISA ONLINE PMT,03/20/26,Debit,300.00,4450.00',
    '00001234,ACME CORP PAYROLL,03/06/26,Credit,3010.00,4750.00'].join('\n');
  const capCardCsv = ['Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit',
    '2026-03-10,2026-03-11,4321,SPOTIFY USA,Other Services,10.99,',
    '2026-03-12,2026-03-13,4321,NETFLIX.COM,Other Services,15.49,'].join('\n');
  const boa = [{ account_id: 'boa', type: 'credit', subtype: 'credit card', mask: '7777', balances: { current: 140.99 } }];
  const boaRes = { accounts: boa, cursor: 'b1', removed: [], modified: [], added: [
    tx('b1', 'boa', '2026-03-03', 200, 'WHOLE FOODS', 'FOOD_AND_DRINK|FOOD_AND_DRINK_GROCERIES'),
    tx('b2', 'boa', '2026-03-09', 100, 'DELTA AIR', 'TRAVEL|TRAVEL_FLIGHTS'),
    // The same amounts, the same week, as the Capital One card: still separate purchases.
    tx('b3', 'boa', '2026-03-10', 10.99, 'SPOTIFY USA', 'ENTERTAINMENT|ENTERTAINMENT_MUSIC_AND_AUDIO'),
    tx('b4', 'boa', '2026-03-12', 15.49, 'NETFLIX.COM', 'ENTERTAINMENT|ENTERTAINMENT_TV_AND_MOVIES'),
    // The bill being paid, worded as a payment but not categorized as one by Plaid.
    tx('b5', 'boa', '2026-03-21', -300, 'PAYMENT - THANK YOU', null),
    tx('b6', 'boa', '2026-04-02', 120, 'TARGET', 'GENERAL_MERCHANDISE|GENERAL_MERCHANDISE_SUPERSTORES'),
    // A payment neither side words clearly, except that Plaid calls the card half one.
    tx('b7', 'boa', '2026-04-21', -75, 'ONLINE BANKING TRANSFER', 'LOAN_PAYMENTS|LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'),
    // Money back from a shop: a refund, not a payment.
    tx('b8', 'boa', '2026-04-05', -30.5, 'TARGET', 'GENERAL_MERCHANDISE|GENERAL_MERCHANDISE_SUPERSTORES'),
  ] };
  const bps = P.emptyState();
  const boaItem = { id: 'boa-item', name: 'Bank of America' };
  const csv = [...A.parseFile(chkCsv, { name: 'checking.csv' }).transactions, ...A.parseFile(capCardCsv).transactions];
  bps.items.push(boaItem);
  const all = P.tidy(P.applySync(csv, bps, boaItem, boaRes), bps);
  assert.equal(all.filter(P.isPlaid).length, 8, 'no Bank of America purchase is mistaken for a Capital One one');
  assert.deepEqual(bps.alias, {}, 'the two cards stay two cards');
  assert.equal(bps.cards['Credit Card ...7777'].balance, 140.99);
  assert.equal(P.csvBankCards(bps).size, 0);
  assert.equal(P.csvBankCards({ items: [{ name: 'Capital One', accounts: [{ kind: 'credit_card', account: 'Credit Card ...4321' }] }] }).size, 1);

  const cats = A.categorize(all, { merchant: {}, amount_rules: [] }, []);
  const by = Object.fromEntries(cats.map(t => [t.id.startsWith('plaid:') ? t.id.slice(6) : t.description, t]));
  // Both halves of each payment are transfers.
  for (const k of ['Withdrawal to BK OF AMER VISA ONLINE PMT', 'b5', 'ODD WORDING EPAY 8841', 'b7']) {
    assert.ok(by[k].is_transfer && by[k].category === 'Credit Card Payment' && !by[k].refund, `${k} is a card payment`);
  }
  assert.ok(by.b8.refund && !by.b8.is_transfer && by.b8.category === 'Shopping', 'a refund stays a refund');
  // Spending is what was bought, once: both cards' purchases less the refund. Paying the bill adds nothing.
  const sum = I.summarize(cats);
  assert.ok(Math.abs(sum.expense - (200 + 100 + 10.99 + 15.49 + 120 - 30.5 + 10.99 + 15.49)) < 0.005, `spending ${sum.expense}`);
  assert.equal(sum.income, 3010, 'a payment landing on the card is not income');

  // A category you set by rule is not overridden by the pairing.
  const ruled = A.categorize(all, { merchant: { 'ODD WORDING EPAY 8841': 'Housing' }, amount_rules: [] }, []);
  assert.equal(ruled.find(t => t.description === 'ODD WORDING EPAY 8841').category, 'Housing');

  // Net worth: the Bank of America card starts from what it owes today less
  // what moved since; the Capital One card, with no connection, uses the typed figure.
  const boaNet = 200 + 100 + 10.99 + 15.49 - 300 + 120 - 75 - 30.5;
  assert.equal(P.cardStart(all, bps.cards, 500), Math.round((140.99 - boaNet + 500) * 100) / 100);
  assert.equal(P.cardStart(all.filter(t => t.account !== 'Credit Card ...4321'), bps.cards, 500), Math.round((140.99 - boaNet) * 100) / 100, 'the typed figure is unused when every card is linked');
  const series = A.buildAssetSeries(cats, P.cardStart(all, bps.cards, 0));
  assert.ok(Math.abs(series[series.length - 1].cc_outstanding - (140.99 + 10.99 + 15.49)) < 0.005, 'today the cards owe their real balances');
}

// ── Relay address ──
assert.equal(P.cleanRelay(' https://ft.example.workers.dev/ '), 'https://ft.example.workers.dev');
assert.equal(P.cleanRelay('http://ft.example.workers.dev'), null);
assert.equal(P.cleanRelay('http://localhost:8787'), 'http://localhost:8787');
assert.equal(P.cleanRelay('nonsense'), null);

// ── The Worker, with Plaid stood in for ──
const env = { PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec', PLAID_ENV: 'sandbox', APP_KEY: 'k'.repeat(40), ALLOWED_ORIGIN: 'https://me.github.io, http://localhost:8000' };
const calls = [];
let syncPages;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body), path = new URL(url).pathname;
  calls.push({ url, path, body });
  const ok = data => new Response(JSON.stringify(data), { status: 200 });
  if (path === '/link/token/create') return ok({ link_token: 'link-sandbox-1' });
  if (path === '/item/public_token/exchange') return ok({ access_token: 'access-sandbox-SECRET', item_id: 'item-1' });
  if (path === '/transactions/sync') {
    if (body.access_token !== 'access-sandbox-SECRET') return new Response(JSON.stringify({ error_code: 'INVALID_ACCESS_TOKEN', error_message: 'bad token' }), { status: 400 });
    return ok(syncPages.shift());
  }
  if (path === '/accounts/get') return ok({ accounts });
  if (path === '/item/remove') return ok({});
  return new Response('{}', { status: 404 });
};
const ask = (path, body, { key = env.APP_KEY, origin = 'https://me.github.io', method = 'POST' } = {}) =>
  worker.fetch(new Request(`https://relay.example/${path}`, {
    method, headers: { ...(origin ? { Origin: origin } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), env);

let r = await ask('link-token', {}, { method: 'OPTIONS' });
assert.equal(r.status, 204);
assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://me.github.io');
assert.equal((await ask('link-token', {}, { origin: 'https://evil.example' })).status, 403, 'other sites are refused');
assert.equal((await ask('link-token', {}, { key: 'wrong' })).status, 401);
assert.equal((await ask('link-token', {}, { key: '' })).status, 401);
assert.equal((await ask('nope', {})).status, 404);
assert.equal(calls.length, 0, 'nothing reaches Plaid without the key');

r = await ask('link-token', { redirect_uri: 'https://me.github.io/FinanceTracker/' });
assert.deepEqual(await r.json(), { link_token: 'link-sandbox-1' });
let sent = calls.pop();
assert.equal(sent.url, 'https://sandbox.plaid.com/link/token/create');
assert.equal(sent.body.client_id, 'cid'); assert.equal(sent.body.secret, 'sec');
assert.deepEqual(sent.body.products, ['transactions']);
assert.equal(sent.body.transactions.days_requested, 730);
assert.equal(sent.body.redirect_uri, 'https://me.github.io/FinanceTracker/');
assert.equal((await ask('link-token', { redirect_uri: 'https://evil.example/' })).status, 400, 'the return address must be the app');

r = await (await ask('exchange', { public_token: 'public-1' })).json();
calls.length = 0;
assert.equal(r.item_id, 'item-1');
assert.ok(r.item && !r.item.includes('access-sandbox'), 'the access token leaves sealed');
const sealed = r.item;

syncPages = [
  { added: [res.added[0]], modified: [], removed: [], next_cursor: 'n1', has_more: true },
  { added: [res.added[1]], modified: [], removed: [{ transaction_id: 'old' }], next_cursor: 'n2', has_more: false, accounts },
];
r = await (await ask('sync', { item: sealed, cursor: null })).json();
assert.equal(r.added.length, 2);
assert.deepEqual(r.removed, ['old']);
assert.equal(r.cursor, 'n2');
assert.equal(r.accounts.length, 3);
assert.equal(calls[0].body.access_token, 'access-sandbox-SECRET', 'unsealed for Plaid');
assert.ok(!('cursor' in calls[0].body) && calls[1].body.cursor === 'n1');
assert.equal(calls[0].body.options.include_original_description, true);
// What the Worker returns is what the app's side understands.
assert.equal(P.applySync([], P.emptyState(), { id: 'i' }, r).length, 2);

// Update mode: the sealed token goes back to Plaid instead of a product list.
calls.length = 0;
await ask('link-token', { item: sealed });
sent = calls.pop();
assert.equal(sent.body.access_token, 'access-sandbox-SECRET');
assert.ok(!sent.body.products);

// A sealed token from another relay, or a tampered one, is refused before Plaid is asked.
calls.length = 0;
r = await ask('sync', { item: sealed.slice(0, -4) + 'AAAA' });
assert.equal(r.status, 400);
assert.equal((await r.json()).code, 'BAD_ITEM');
r = await worker.fetch(new Request('https://relay.example/sync', { method: 'POST', headers: { Origin: 'https://me.github.io', Authorization: `Bearer ${'j'.repeat(40)}` }, body: JSON.stringify({ item: sealed }) }), { ...env, APP_KEY: 'j'.repeat(40) });
assert.equal(r.status, 400, 'a different access key cannot open it');
assert.equal(calls.length, 0);

// Plaid's own errors come through with their code.
syncPages = [];
globalThis.fetch = async () => new Response(JSON.stringify({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' }), { status: 400 });
r = await ask('sync', { item: sealed });
assert.equal(r.status, 502);
assert.equal((await r.json()).code, 'ITEM_LOGIN_REQUIRED');

// And the app's side of the call turns them into errors with that code.
globalThis.fetch = (url, init) => (new URL(url).hostname === 'relay.example'
  ? worker.fetch(new Request(url, { ...init, headers: { ...init.headers, Origin: 'https://me.github.io' } }), env)
  : Promise.resolve(new Response(JSON.stringify({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'sign in again' }), { status: 400 })));
await assert.rejects(P.call({ url: 'https://relay.example', key: env.APP_KEY }, 'sync', { item: sealed }), e => e.code === 'ITEM_LOGIN_REQUIRED');
await assert.rejects(P.call({ url: 'https://relay.example', key: 'wrong' }, 'sync', { item: sealed }), /rejected the access key/);

// ── Direct mode: the app calling Plaid itself ──
{
  const direct = { mode: 'direct', clientId: 'cid', secret: 'sec', env: 'sandbox' };
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body), path = new URL(url).pathname;
    seen.push({ url, body });
    const ok = d => new Response(JSON.stringify(d), { status: 200 });
    if (path === '/link/token/create') return ok({ link_token: 'link-direct' });
    if (path === '/item/public_token/exchange') return ok({ access_token: 'access-direct', item_id: 'item-d' });
    if (path === '/transactions/sync') return body.cursor
      ? ok({ added: [res.added[1]], modified: [], removed: [{ transaction_id: 'gone' }], next_cursor: 'd2', has_more: false, accounts })
      : ok({ added: [res.added[0]], modified: [], removed: [], next_cursor: 'd1', has_more: true });
    if (path === '/item/remove') return new Response(JSON.stringify({ error_code: 'ITEM_NOT_FOUND', error_message: 'gone' }), { status: 400 });
    return new Response(JSON.stringify({ error_code: 'INVALID_API_KEYS', error_message: 'invalid client_id or secret provided' }), { status: 400 });
  };
  assert.deepEqual(await P.call(direct, 'link-token', { redirect_uri: 'https://me.github.io/FinanceTracker/' }), { link_token: 'link-direct' });
  assert.equal(seen[0].url, 'https://sandbox.plaid.com/link/token/create');
  assert.equal(seen[0].body.client_id, 'cid'); assert.equal(seen[0].body.secret, 'sec');
  assert.equal(seen[0].body.transactions.days_requested, 730);
  assert.equal((await P.call({ ...direct, env: 'production' }, 'link-token', {})) && seen[1].url, 'https://production.plaid.com/link/token/create');
  const ex = await P.call(direct, 'exchange', { public_token: 'p' });
  assert.deepEqual(ex, { item: 'access-direct', item_id: 'item-d' });
  seen.length = 0;
  const sy = await P.call(direct, 'sync', { item: ex.item, cursor: null });
  assert.equal(sy.added.length, 2); assert.deepEqual(sy.removed, ['gone']); assert.equal(sy.cursor, 'd2');
  assert.equal(seen[0].body.access_token, 'access-direct');
  assert.equal(P.applySync([], P.emptyState(), { id: 'i' }, sy).length, 2, 'the answer is in the shape the app folds in');
  // Update mode sends the bank's token rather than a product list.
  seen.length = 0;
  await P.call(direct, 'link-token', { item: ex.item });
  assert.ok(seen[0].body.access_token === 'access-direct' && !seen[0].body.products);
  assert.deepEqual(await P.call(direct, 'remove', { item: ex.item }), { removed: true }, 'already gone at Plaid counts as removed');
  await assert.rejects(P.call(direct, 'sync', { item: 'x' }).then(() => { throw new Error('no'); }, e => { throw e; }), () => true);
  // A browser that refuses the cross-site request gives fetch a bare failure.
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(P.call(direct, 'link-token', {}), e => e.code === 'BLOCKED' && /relay/.test(e.message));
}
globalThis.fetch = realFetch;

console.log('plaid tests passed');
