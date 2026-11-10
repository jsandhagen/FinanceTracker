// Synthetic Capital One exports for the demo mode. They go through the same
// parser as real files, so the demo exercises the real pipeline. Fixed seed:
// the same picture every time, ending today.

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const p2 = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const usOf = d => `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${String(d.getFullYear()).slice(2)}`;
const csv = rows => rows.map(r => r.map(c => (/[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');

export function demoFiles(today = new Date(), months = 14) {
  const r = rng(20240611);
  const between = (a, b) => Math.round((a + r() * (b - a)) * 100) / 100;
  const pick = a => a[Math.floor(r() * a.length)];
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end.getFullYear(), end.getMonth() - months, 1);

  let chk = 3800, sav = 12400, ccOwed = 0;
  const checking = [], savings = [], credit = [];
  const chkRow = (d, desc, amt, isCredit) => {
    chk += isCredit ? amt : -amt;
    checking.push(['00001234', desc, usOf(d), isCredit ? 'Credit' : 'Debit', amt.toFixed(2), chk.toFixed(2)]);
  };
  const savRow = (d, desc, amt) => {
    sav += amt;
    savings.push(['00005678', desc, usOf(d), 'Credit', amt.toFixed(2), sav.toFixed(2)]);
  };
  const ccRow = (d, desc, cat, amt) => {
    ccOwed += amt;
    credit.push([isoOf(d), isoOf(d), '4321', desc, cat, amt.toFixed(2), '']);
  };

  let i = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1), i++) {
    const dom = d.getDate(), dow = d.getDay();
    const monthIdx = (d.getFullYear() - start.getFullYear()) * 12 + d.getMonth() - start.getMonth();

    if (i % 14 === 3) {
      chkRow(d, 'ACME CORP PAYROLL', monthIdx >= 9 ? 3010 : 2840, true);
      chkRow(d, 'Withdrawal to 360 Performance Savings XXXXXXX5678', 450, false);
      savRow(d, 'Deposit from 360 Checking XXXXXXX1234', 450);
    }
    if (dom === 1) { chkRow(d, 'RENT PAYMENT PORTAL', 1725, false); savRow(d, 'Monthly Interest Paid', Math.round(sav * 0.0031 * 100) / 100); }
    if (dom === 5) chkRow(d, 'GEICO INS PREM', 128.4, false);
    if (dom === 12) chkRow(d, 'DOMINION ENERGY BILLPAY', between(68, [11, 0, 1, 6, 7].includes(d.getMonth()) ? 165 : 105), false);
    if (dom === 17) chkRow(d, 'Planet Fitness', 24.99, false);
    if (dom === 18) chkRow(d, 'VERIZON WIRELESS', 85, false);
    if (dom === 25 && ccOwed > 0) {
      const pay = Math.round(ccOwed * 100) / 100;
      chkRow(d, 'CAPITAL ONE MOBILE PMT', pay, false);
      credit.push([isoOf(d), isoOf(d), '4321', 'CAPITAL ONE MOBILE PYMT', 'Payment/Credit', '', pay.toFixed(2)]);
      ccOwed = 0;
    }
    if (r() < 0.05) chkRow(d, 'Zelle money sent to Alex', between(20, 90), false);
    if (r() < 0.03) chkRow(d, 'ATM Withdrawal 7-ELEVEN', pick([40, 60, 80, 100]), false);

    if (dow === 6 || (dow === 3 && r() < 0.7)) ccRow(d, pick(['WHOLEFDS MKT 10234', 'TRADER JOE S 552']), 'Groceries', between(38, 135));
    if (r() < 0.45) ccRow(d, pick(['CHIPOTLE 1234', 'LOCAL DINER', 'STARBUCKS STORE 0921', 'DOORDASH SWEETGREEN', 'THAI ORCHID']), 'Dining/Restaurant', between(6, 48));
    if (r() < 0.14) ccRow(d, 'AMAZON.COM', 'Merchandise', between(12, 120));
    if (r() < 0.12) ccRow(d, 'UBER TRIP', 'Other Travel', between(9, 34));
    if (i % 12 === 7) ccRow(d, 'SHELL OIL 5741', 'Gas/Automotive', between(34, 58));
    if (r() < 0.04) ccRow(d, 'CVS PHARMACY 0443', 'Health Care', between(8, 60));
    if (r() < 0.05) ccRow(d, pick(['AMC THEATRES', 'STEAM GAMES', 'TICKETMASTER']), 'Entertainment', between(14, 85));
    if (dom === 8) ccRow(d, 'SPOTIFY USA', 'Other Services', monthIdx >= months - 1 ? 12.99 : 10.99);
    if (dom === 14) ccRow(d, 'NETFLIX.COM', 'Other Services', 15.49);
    if (dom === 21) ccRow(d, 'NYTIMES DIGITAL', 'Other Services', 17);
    if ((monthIdx === 5 || monthIdx === 11) && dom === 9) { ccRow(d, 'COTFLT DELTA AIR LINES', 'Airfare', between(340, 480)); ccRow(d, 'COTHTL MARRIOTT DOWNTOWN', 'Lodging', between(480, 690)); }
    if (monthIdx === months - 2 && dom === 19) ccRow(d, 'BEST BUY 00412', 'Merchandise', 1249.99);
    if (monthIdx === months - 1 && dom === 3) ccRow(d, 'AMAZON.COM', 'Merchandise', 389.5);
    if (monthIdx === 7 && dom === 27) ccRow(d, 'LATE PAYMENT FEE', 'Fee/Interest Charge', 29);
  }

  const bankHead = ['Account Number', 'Transaction Description', 'Transaction Date', 'Transaction Type', 'Transaction Amount', 'Balance'];
  return [
    csv([bankHead, ...checking.reverse()]),
    csv([bankHead, ...savings.reverse()]),
    csv([['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'], ...credit.reverse()]),
  ];
}
