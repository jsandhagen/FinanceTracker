// The parser and the rules that decide what counts as income and spending.
import * as A from '../js/analyzer.js';
import * as I from '../js/insights.js';
import assert from 'node:assert/strict';

const BANK = 'Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance\n';
const CARD = 'Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n';
const none = { merchant: {}, amount_rules: [] };
const noML = { predict: () => null };
const cat = (stored, rules = none) => A.categorize(stored, rules, [], noML);

// ── Refunds are not income ──
const card = A.parseFile(CARD + [
  '2026-03-10,2026-03-11,4321,AMAZON.COM,Merchandise,,40.00',     // a return
  '2026-03-05,2026-03-06,4321,AMAZON.COM,Merchandise,100.00,',
  '2026-03-04,2026-03-05,4321,CAPITAL ONE MOBILE PYMT,Payment/Credit,,250.00',
  '2026-03-02,2026-03-03,4321,LOCAL DINER,Dining/Restaurant,25.50,',
].join('\n')).transactions;
let t = cat(card), sum = I.summarize(t);
assert.equal(sum.income, 0, 'a card refund is not income');
assert.equal(A.round2(sum.expense), 85.5, 'the refund comes off spending');
assert.equal(I.totalsBy(t.filter(x => !x.is_transfer), 'category').find(c => c.name === 'Shopping').total, 60);
assert.equal(A.round2(I.monthly(t.filter(x => !x.is_transfer))[0].exp), 85.5);

// A bank deposit is income unless it says it is a refund or a rule files it under spending.
const bank = A.parseFile(BANK + [
  '1234,Deposit from TARGET REFUND 00123,03/09/26,Credit,30.00,1130.00',
  '1234,Deposit from HEALTH SYSTEM DIR DEP,03/06/26,Credit,1000.00,1100.00',
  '1234,Debit Card Purchase - TARGET 00123,03/05/26,Debit,50.00,100.00',
].join('\n')).transactions;
t = cat(bank); sum = I.summarize(t);
assert.equal(sum.income, 1000, 'a paycheck that matched a spending keyword still counts as income');
assert.equal(sum.expense, 20, 'the Target refund nets against the Target purchase');

// ── Savings stays savings, even when the export has nothing but interest ──
const sav1 = A.parseFile(BANK + '5678,Deposit from 360 Checking XXXXXXX1234,02/14/26,Credit,450.00,10450.00\n');
assert.equal(sav1.format, 'savings');
const sav2 = A.parseFile(BANK + '5678,Monthly Interest Paid,03/01/26,Credit,31.20,10481.20\n', { known: A.knownAccounts(sav1.transactions) });
assert.equal(sav2.transactions[0].account, 'Savings ...5678');
assert.equal(A.parseFile(BANK + '5678,Monthly Interest Paid,03/01/26,Credit,31.20,10481.20\n').transactions[0].account, 'Checking ...5678', 'unknown account defaults to checking');
assert.equal(A.parseFile(BANK + '9999,Monthly Interest Paid,03/01/26,Credit,1.00,5.00\n', { name: '2026-03-01_360PerformanceSavings.csv' }).format, 'savings', 'file name hint');
// Data saved before that fix: the phantom checking account folds back into savings.
const phantom = A.parseFile(BANK + '5678,Monthly Interest Paid,03/01/26,Credit,31.20,10481.20\n').transactions;
const healed = A.repairStored([...sav1.transactions, ...phantom, ...sav2.transactions]);
assert.equal(healed.length, 2);
assert.deepEqual([...new Set(healed.map(x => x.account))], ['Savings ...5678']);
assert.equal(A.repairStored(healed), healed, 'nothing to fix returns the same array');

// ── Card numbers are read per row, so ids do not depend on which row is first ──
const two = ['2026-03-05,2026-03-06,1111,SHOP A,Merchandise,10.00,', '2026-03-04,2026-03-05,2222,SHOP B,Merchandise,20.00,'];
const fwd = A.parseFile(CARD + two.join('\n')).transactions, rev = A.parseFile(CARD + [...two].reverse().join('\n')).transactions;
assert.deepEqual(fwd.map(x => x.id).sort(), rev.map(x => x.id).sort());
assert.equal(A.mergeTransactions(fwd, rev).added, 0);

// ── Same-day order comes from the balances, not from which file a row was in ──
const big = A.parseFile(BANK + ['1234,COFFEE SHOP,03/05/26,Debit,5.00,995.00', ...Array.from({ length: 30 }, (_, i) =>
  `1234,OLD ${i},02/${String(28 - i % 28).padStart(2, '0')}/26,Debit,1.00,${(1000 + i).toFixed(2)}`)].join('\n')).transactions;
const small = A.parseFile(BANK + ['1234,LATE DINNER,03/05/26,Debit,45.00,950.00', '1234,COFFEE SHOP,03/05/26,Debit,5.00,995.00'].join('\n')).transactions;
t = cat(A.mergeTransactions(big, small).merged);
assert.equal(t[0].description, 'LATE DINNER', 'the later row of the day sorts last');
assert.equal(t[0].balance, 950);
assert.equal(A.buildAssetSeries(t).at(-1).total_bank, 950, 'closing balance of the day');

// ── Net worth: an account is carried at its opening balance before its first row,
//    and card spending after the last bank row still counts ──
const mix = [
  ...A.parseFile(BANK + ['1234,PAYROLL,03/10/26,Credit,100.00,1100.00', '1234,PAYROLL,03/01/26,Credit,100.00,1000.00'].join('\n')).transactions,
  ...A.parseFile(BANK + '5678,Deposit from 360 Checking XXXXXXX1234,03/10/26,Credit,50.00,5050.00\n').transactions,
  ...A.parseFile(CARD + '2026-03-12,2026-03-13,4321,SHOP,Merchandise,70.00,\n').transactions,
];
const series = A.buildAssetSeries(cat(mix));
assert.deepEqual(series.map(d => [d.date, d.total_bank, d.net]), [['2026-03-01', 6000, 6000], ['2026-03-10', 6150, 6150], ['2026-03-12', 6150, 6080]]);

// ── Short keywords must start a word ──
const kw = d => cat(A.parseFile(BANK + `1234,${d},03/05/26,Debit,5.00,100.00\n`).transactions)[0].category;
assert.equal(kw('RENT PAYMENT PORTAL'), 'Housing');
assert.equal(kw('Debit Card Purchase - CURRENT BREWING'), 'Other');
assert.equal(kw('UBER EATS PENDING'), 'Dining');
assert.equal(kw('UBER TRIP'), 'Transportation');
assert.equal(kw('Withdrawal to 360 Savings XXXXXXX9'), 'Savings Transfer');
// ── Trips go under Travel ──
// Whatever the card or Plaid calls it, and wherever it was paid from.
{
  const travelCard = A.parseFile(CARD + [
    '2026-04-01,2026-04-02,4321,AIRBNB * HMABC123,Other Travel,612.40,',
    '2026-04-02,2026-04-03,4321,SIXT RENT A CAR,Car Rental,233.10,',
    '2026-04-03,2026-04-04,4321,ENTERPRISE RENT-A-CAR,Automotive,180.00,',
    '2026-04-04,2026-04-05,4321,CAPITAL ONE TRAVEL,Merchandise,412.00,',
    '2026-04-05,2026-04-06,4321,COTFLT UNITED AIRLINES,Airfare,288.00,',
    '2026-04-06,2026-04-07,4321,HERTZ CAR RENTAL,Car Rental,95.00,',
    '2026-04-07,2026-04-08,4321,EXPEDIA 7234,Other Services,140.00,',
    '2026-04-08,2026-04-09,4321,CAPITAL ONE TRAVEL CREDIT,Payment/Credit,,300.00',
    '2026-04-09,2026-04-10,4321,UBER TRIP,Other Travel,22.00,',
    '2026-04-10,2026-04-11,4321,DELTA DENTAL,Health Care,40.00,',
    '2026-04-11,2026-04-12,4321,CAPITAL ONE MOBILE PYMT,Payment/Credit,,500.00',
  ].join('\n')).transactions;
  const by = Object.fromEntries(cat(travelCard).map(x => [x.description, x]));
  for (const d of ['AIRBNB * HMABC123', 'SIXT RENT A CAR', 'ENTERPRISE RENT-A-CAR', 'CAPITAL ONE TRAVEL', 'COTFLT UNITED AIRLINES', 'HERTZ CAR RENTAL', 'EXPEDIA 7234'])
    assert.equal(by[d].category, 'Travel', d);
  assert.ok(by['CAPITAL ONE TRAVEL CREDIT'].category === 'Travel' && by['CAPITAL ONE TRAVEL CREDIT'].refund, 'a travel credit comes off Travel');
  assert.equal(by['UBER TRIP'].category, 'Transportation', 'a ride is still a ride');
  assert.equal(by['DELTA DENTAL'].category, 'Health', 'not every Delta is an airline');
  assert.ok(by['CAPITAL ONE MOBILE PYMT'].is_transfer, 'the card payment is untouched');

  const travelBank = A.parseFile(BANK + [
    '1234,Debit Card Purchase - ENTERPRISE RENT-A-CAR 0412,04/12/26,Debit,150.00,850.00',
    '1234,Debit Card Purchase - AIRBNB HMXYZ,04/11/26,Debit,300.00,1000.00',
    '1234,Debit Card Purchase - RENT PAYMENT PORTAL,04/01/26,Debit,1500.00,1300.00',
    '1234,Capital One Mobile Pmt,03/30/26,Debit,200.00,2800.00',
  ].join('\n')).transactions;
  const bb = Object.fromEntries(cat(travelBank).map(x => [x.description, x]));
  assert.equal(bb['Debit Card Purchase - ENTERPRISE RENT-A-CAR 0412'].category, 'Travel', 'rent-a-car is not rent');
  assert.equal(bb['Debit Card Purchase - AIRBNB HMXYZ'].category, 'Travel');
  assert.equal(bb['Debit Card Purchase - RENT PAYMENT PORTAL'].category, 'Housing');
  assert.ok(bb['Capital One Mobile Pmt'].is_transfer, 'the bank side of a card payment is untouched');

  // Plaid rows: the name beats Plaid's own heading.
  const viaPlaid = [{ id: 'p1', source: 'plaid', kind: 'credit_card', date: '2026-04-01', description: 'AIRBNB', account: 'Credit Card ...9', amount: -500, balance: null, raw_category: 'GENERAL_SERVICES|GENERAL_SERVICES_OTHER_GENERAL_SERVICES' },
    { id: 'p2', source: 'plaid', kind: 'checking', date: '2026-04-02', description: 'SIXT', account: 'Checking ...1', amount: -120, balance: null, raw_category: 'TRANSPORTATION|TRANSPORTATION_OTHER_TRANSPORTATION' }];
  assert.deepEqual(cat(viaPlaid).map(x => x.category), ['Travel', 'Travel']);
}

console.log('analyzer tests passed');
