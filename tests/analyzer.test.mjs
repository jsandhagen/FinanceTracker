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
assert.equal(kw('Debit Card Purchase - CURRENT WIDGETS'), 'Other', "'rent' is not in CURRENT");
assert.equal(kw('RENT THE RUNWAY'), 'Shopping', 'a shop with rent in its name');
assert.equal(kw('EQUIPMENT RENTAL CO'), 'Other', "'rent' is a whole word");
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

// ── Grocery stores are Groceries ──
// By name, on a card whatever its category, and on a bank account; the pump and
// the pharmacy at a grocery store are not groceries.
{
  const g = A.parseFile(CARD + [
    '2026-05-01,2026-05-02,4321,TRADER JOE S #552,Merchandise,48.20,',
    '2026-05-02,2026-05-03,4321,WHOLEFDS MKT 10234,Merchandise,61.10,',
    '2026-05-03,2026-05-04,4321,ALDI 72031,Other Services,33.00,',
    '2026-05-04,2026-05-05,4321,GIANT FOOD #0312,Merchandise,90.00,',
    '2026-05-05,2026-05-06,4321,GIANT GAS #0312,Gas/Automotive,40.00,',
    '2026-05-06,2026-05-07,4321,SAFEWAY PHARMACY,Health Care,12.00,',
    '2026-05-07,2026-05-08,4321,INSTACART,Other Services,80.00,',
    '2026-05-08,2026-05-09,4321,TARGET 00123,Merchandise,55.00,',
    '2026-05-09,2026-05-10,4321,JINGLES BAR,Dining/Restaurant,20.00,',
    '2026-05-10,2026-05-11,4321,TRADER JOE S #552,Merchandise,,10.00',
  ].join('\n')).transactions;
  const rows = cat(g);
  const of = d => rows.find(x => x.description === d && x.amount < 0)?.category;
  for (const d of ['TRADER JOE S #552', 'WHOLEFDS MKT 10234', 'ALDI 72031', 'GIANT FOOD #0312', 'INSTACART']) assert.equal(of(d), 'Groceries', d);
  assert.equal(of('GIANT GAS #0312'), 'Transportation', 'the pump is not groceries');
  assert.equal(of('SAFEWAY PHARMACY'), 'Health', 'nor the pharmacy');
  assert.equal(of('TARGET 00123'), 'Shopping', 'a store that sells everything stays Shopping');
  assert.equal(of('JINGLES BAR'), 'Dining');
  const back = rows.find(x => x.description === 'TRADER JOE S #552' && x.amount > 0);
  assert.ok(back.refund && back.category === 'Groceries', 'a return comes off Groceries');

  const gb = A.parseFile(BANK + [
    '1234,Debit Card Purchase - TRADER JOE S #552,05/12/26,Debit,40.00,960.00',
    '1234,Debit Card Purchase - AMAZON FRESH,05/11/26,Debit,70.00,1000.00',
    '1234,Debit Card Purchase - AMAZON.COM,05/10/26,Debit,25.00,1070.00',
  ].join('\n')).transactions;
  const bo = Object.fromEntries(cat(gb).map(x => [x.description, x.category]));
  assert.equal(bo['Debit Card Purchase - TRADER JOE S #552'], 'Groceries');
  assert.equal(bo['Debit Card Purchase - AMAZON FRESH'], 'Groceries', 'Amazon Fresh is groceries');
  assert.equal(bo['Debit Card Purchase - AMAZON.COM'], 'Shopping', 'the rest of Amazon is not');
}

// ── Commonly misfiled ──
{
  const bankCat = d => cat(A.parseFile(BANK + `1234,${d},03/05/26,Debit,25.00,100.00\n`).transactions)[0];
  const bankIn = d => cat(A.parseFile(BANK + `1234,${d},03/05/26,Credit,25.00,100.00\n`).transactions)[0];
  const cardCat = (d, c) => cat(A.parseFile(CARD + `2026-03-05,2026-03-06,4321,${d},${c},25.00,\n`).transactions)[0];

  // PayPal: a purchase through it is spending; only a transfer is a transfer.
  assert.equal(bankCat('PAYPAL *NETFLIX.COM').category, 'Subscriptions');
  assert.ok(!bankCat('PAYPAL *EBAY').is_transfer && bankCat('PAYPAL *EBAY').category === 'Shopping');
  assert.ok(bankCat('PAYPAL INST XFER').is_transfer, 'sending money is still a transfer');
  // Investments are kept, not spent, and not earned when they come back.
  for (const d of ['VANGUARD BUY INVESTMENT', 'FIDELITY INVESTMENTS', 'ROBINHOOD FUNDS', 'Coinbase Inc', 'SCHWAB BROKERAGE']) {
    const r = bankCat(d);
    assert.ok(r.category === 'Investment Transfer' && r.is_transfer, d);
  }
  assert.ok(bankIn('VANGUARD SELL').is_transfer, 'a withdrawal is not income');
  // Pay-later plans are what was bought.
  for (const d of ['AFFIRM INC', 'KLARNA* PAYMENT', 'AFTERPAY US']) assert.equal(bankCat(d).category, 'Shopping', d);
  // Apple: a subscription, a store, or money sent.
  assert.equal(bankCat('APPLE.COM/BILL 866-712-7753').category, 'Subscriptions');
  assert.equal(bankCat('APPLE STORE R123').category, 'Shopping');
  assert.ok(bankCat('APPLE CASH SENT MONEY').is_transfer);
  assert.ok(bankCat('APPLECARD GSBANK PAYMENT').category === 'Credit Card Payment');
  // Names that only looked like a category.
  assert.equal(bankCat('STEAMBOAT CARPET CLEANING').category, 'Other', 'not Steam the game store');
  assert.equal(bankCat('BILTMORE ESTATE').category, 'Other', 'not Bilt rent');
  assert.equal(bankCat('AMAZON PRIME*2K4').category, 'Subscriptions', 'Prime is a subscription, the rest of Amazon is not');
  assert.equal(bankCat('COSTCO GAS #123').category, 'Transportation', 'Costco fuel is fuel');
  assert.equal(bankCat('COSTCO WHSE #123').category, 'Shopping');
  // Money in that is not a paycheck.
  assert.equal(bankIn('Monthly Interest Paid').category, 'Interest Income', 'checking pays interest too');
  assert.equal(bankIn('IRS TREAS 310 TAX REF').category, 'Income');
  assert.equal(bankIn('Zelle money received from SAM').category, 'Income');
  assert.ok(bankCat('Zelle money sent to SAM').is_transfer);
  // Fees and cash.
  assert.equal(bankCat('OVERDRAFT FEE').category, 'Fees');
  assert.equal(bankCat('ATM WITHDRAWAL 123 MAIN ST').category, 'Other');
  // More card issuers paid from checking.
  for (const d of ['AMEX EPAYMENT ACH PMT', 'SYNCHRONY BANK PAYMENT', 'CHASE CREDIT CRD AUTOPAY']) assert.ok(bankCat(d).is_transfer, d);
  // A Virginia bill or two.
  for (const d of ['XFINITY MOBILE', 'PEPCO BILL PAY', 'FAIRFAX WATER']) assert.equal(bankCat(d).category, 'Utilities & Bills', d);

  // On a card, a brand beats the card's vague category; a specific one stands.
  assert.equal(cardCat('NETFLIX.COM', 'Entertainment').category, 'Subscriptions');
  assert.equal(cardCat('CVS/PHARMACY #1234', 'Merchandise').category, 'Health');
  assert.equal(cardCat('TST* LOCAL TAVERN', 'Other Services').category, 'Dining');
  assert.equal(cardCat('GEICO *AUTO', 'Other Services').category, 'Insurance');
  assert.equal(cardCat('XFINITY', 'Internet').category, 'Utilities & Bills');
  assert.equal(cardCat('WALMART.COM', 'Grocery').category, 'Groceries', 'the card knows a Walmart trip was food');
  assert.equal(cardCat('SOME SALON', 'Professional Services').category, 'Other', 'no odd category of its own');
  assert.equal(cardCat('NETFLIX.COM', 'Payment/Credit').is_transfer, true, 'a transfer is never relabelled');

  // Plaid rows get the same names.
  const viaPlaid = [{ id: 'q1', source: 'plaid', kind: 'credit_card', date: '2026-04-01', description: 'Netflix', account: 'Credit Card ...9', amount: -15.49, balance: null, raw_category: 'ENTERTAINMENT|ENTERTAINMENT_TV_AND_MOVIES' },
    { id: 'q2', source: 'plaid', kind: 'checking', date: '2026-04-02', description: 'Vanguard', account: 'Checking ...1', amount: -500, balance: null, raw_category: 'TRANSFER_OUT|TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' }];
  const pc = cat(viaPlaid);
  assert.equal(pc.find(x => x.id === 'q1').category, 'Subscriptions');
  assert.ok(pc.find(x => x.id === 'q2').is_transfer);
  assert.equal(A.plaidCategory('TRANSFER_OUT|TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS'), 'Investment Transfer');

  // None of these may be caught by a name rule meant for something else.
  const plain = ['CURRENT WIDGETS LLC', 'DELTA DENTAL', 'ALAMO DRAFTHOUSE', 'GRASSHOPPER CAFE', 'METROPOLITAN OPERA',
    'BILTMORE ESTATE', 'EQUIPMENT RENTAL CO', 'JINGLES BAR', 'SEASHELL SHOP'];
  const seen = plain.map(d => [d, bankCat(d).category]);
  assert.ok(!seen.some(([d, c]) => ['Housing', 'Travel', 'Groceries', 'Subscriptions'].includes(c)), JSON.stringify(seen));
}

// ── Seen on a real Capital One card export ──
{
  const card = (d, c, credit = false) => cat(A.parseFile(CARD + `2026-06-05,2026-06-06,1033,${d},${c},${credit ? ',20.00' : '20.00,'}\n`).transactions)[0].category;
  // Capital One Travel writes COT*FLT, COT*HTL, COT*LCH, filed as Other Travel.
  for (const d of ['COT*FLT', 'COT*HTL', 'COT*LCH']) assert.equal(card(d, 'Other Travel'), 'Travel', d);
  assert.equal(card('COTTAGE BAKERY', 'Dining'), 'Dining', 'not every COT is Capital One Travel');
  // Fuel glued to the store number is still fuel; the card's category stands.
  assert.equal(card('SAFEWAY FUEL2616', 'Gas/Automotive'), 'Transportation');
  // Supermarkets the card calls Merchandise.
  for (const d of ['H MART FAIRFAX LLC', 'FRED-MEYER #0650', 'NEW SEASONS #22 TAN', 'Migros MP Taesch', 'Coop-2222 Tasch', 'CARREFOUR MARKET'])
    assert.equal(card(d, 'Merchandise'), 'Groceries', d);
  assert.equal(card('SMITH MARTIN LLC', 'Merchandise'), 'Shopping', 'H Mart is two letters, not a surname');
  assert.equal(card('COOPER HARDWARE', 'Merchandise'), 'Shopping', 'Coop is not Cooper');
  // Streaming filed as Phone/Cable or Internet; a gym filed as Entertainment.
  assert.equal(card('TIDAL.COM', 'Phone/Cable'), 'Subscriptions');
  assert.equal(card('FOX ONE MONTHLY', 'Internet'), 'Subscriptions');
  assert.equal(card('STEAMGAMES.COM 4259522985', 'Internet'), 'Subscriptions');
  assert.equal(card('ASF*Exurb Fitness', 'Entertainment'), 'Health');
  assert.equal(card('STUBHUB INC', 'Entertainment'), 'Entertainment');
  // A café or bakery filed as Merchandise; a museum as Other Services.
  assert.equal(card('SQ *CANELA VEGAN BAKERY &', 'Merchandise'), 'Dining');
  assert.equal(card('Met Museum of Art', 'Other Services'), 'Entertainment');
  // Other Services is not a subscription unless the name says so.
  assert.equal(card('AMAZON PRIME*XB6L03O63', 'Other Services'), 'Subscriptions');
  assert.equal(card('SOME LOCAL SERVICE', 'Other Services'), 'Other');
  // The restaurant in a hotel is a meal; the hotel is a trip.
  assert.equal(card('TST*SCP REDMOND HOTEL', 'Dining'), 'Dining');
  assert.equal(card('COURTYARD BY MARRIOTT', 'Lodging'), 'Travel');
  // Park fees are trips; a liquor store is groceries; a barber is left alone.
  assert.equal(card('OR PARKS SMITH ROCK', 'Other Services'), 'Travel');
  assert.equal(card('SHOP.ALBERTAPARKS.CA', 'Other Services'), 'Travel');
  assert.equal(card('COLOR PARKSIDE SALON', 'Other Services'), 'Other', 'not Oregon parks');
  assert.equal(card('WASHINGTON PARK MOBILE', 'Gas/Automotive'), 'Transportation', 'parking in a park is parking');
  assert.equal(card('VA ABC STORE 219', 'Other Services'), 'Groceries');
  assert.equal(card('SQ *LEGEND BARBER', 'Other Services'), 'Other');
  // A parking charge at a museum the card calls Gas/Automotive stays parking.
  assert.equal(card('SI NAT AIR & SPACE MUSEU', 'Gas/Automotive'), 'Transportation');
}

console.log('analyzer tests passed');
