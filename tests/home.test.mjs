// What if: buying a home (no DOM).
import * as H from '../js/home.js';
import assert from 'node:assert/strict';

const close = (a, b, msg, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const t = H.settings({});   // 6.5%, 30 years, 1% tax, $1,800 insurance, 0.5% PMI, 3% closing, 1% upkeep

// ── The payment ──
// $300,000 at 6% over 30 years is the textbook $1,798.65.
close(H.payment(300000, 6, 30), 1798.65, 'principal and interest');
close(H.payment(120000, 0, 10), 1000, 'no interest');
assert.equal(H.payment(0, 6, 30), 0);

// ── One price ──
// $400,000 with $92,000 in: $12,000 closes it, $80,000 (20%) goes down, no PMI.
let c = H.cost(400000, 92000, t);
close(c.closing, 12000, 'closing costs');
close(c.down, 80000, 'down payment');
close(c.loan, 320000, 'loan');
assert.equal(c.pmi, 0);
close(c.tax, 400000 * 0.01 / 12, 'property tax');
close(c.housing, H.payment(320000, 6.5, 30) + 4000 / 12 + 150, 'housing');
close(c.owning, c.housing + 4000 / 12, 'owning adds upkeep');
assert.equal(c.short, 0);
// A dollar less down and mortgage insurance is charged.
c = H.cost(400000, 91999, t);
close(c.pmi, 320001 * 0.005 / 12, 'PMI under 20% down');
// Too little cash: the shortfall is against closing costs plus 3% down.
c = H.cost(400000, 20000, t);
close(c.short, 12000 + 12000 - 20000, 'cash shortfall');
close(c.down, 8000, 'what is left goes down');

// ── The highest price a budget carries ──
for (const which of ['housing', 'owning']) {
  const p = H.maxPrice(3000, 60000, t, which);
  close(H.cost(p, 60000, t)[which], 3000, `${which} at the limit`, 0.5);
  assert.ok(H.cost(p + 500, 60000, t)[which] > 3000);
}
assert.equal(H.maxPrice(0, 60000, t), 0);
assert.equal(H.maxPrice(100, 60000, t), 0, 'insurance alone is more than the budget');
close(H.cashPrice(60000, t), 1e6, 'cash limit: 3% closing + 3% down');

// ── Who pays what ──
assert.equal(H.shareOf(100000, null), 1);
assert.equal(H.shareOf(100000, { on: false, income: 100000 }), 1, 'a co-borrower switched off is not counted');
close(H.shareOf(120000, { on: true, income: 80000, split: 'income' }), 0.6, 'by income');
assert.equal(H.shareOf(120000, { on: true, income: 80000, split: 'even' }), 0.5);
close(H.shareOf(120000, { on: true, income: 80000, split: 'custom', share: 70 }), 0.7, 'a set share');

// ── The three limits ──
const you = { gross: 120000, takeHome: 7000, debts: 400, other: 3000, cash: 40000, floor: 0.1 };
const alone = H.limits({ ...you, co: null }, t);
// 28% of $10,000 is $2,800; 36% less $400 of debt is $3,200: the front ratio binds.
close(alone.lender.budget, 2800, 'lender budget alone');
assert.equal(alone.lender.by, 'front');
// Yours: 7,000 x 0.9 - 3,000 = 3,300 for all of owning.
close(alone.yours.budget, 3300, 'your budget alone');
close(alone.funds.price, 40000 / 0.06, 'cash limit alone');
assert.equal(alone.price, Math.min(alone.lender.price, alone.yours.price, alone.funds.price));

// Until some cash is entered, the cash sets no limit.
const none = H.limits({ ...you, cash: 0, co: null }, t);
assert.equal(none.funds.price, null);
assert.equal(none.price, Math.min(none.lender.price, none.yours.price));

// A co-borrower adds their income, their debts and their cash to the loan.
const co = { on: true, income: 80000, debts: 900, cash: 30000, split: 'income', share: 50 };
const both = H.limits({ ...you, co }, t);
close(both.income, 200000 / 12, 'combined income');
// 28% is $4,666.67; 36% less $1,300 of debt is $4,700.
close(both.lender.budget, 200000 / 12 * 0.28, 'lender budget together');
assert.ok(both.lender.price > alone.lender.price);
close(both.funds.price, 70000 / 0.06, 'cash limit together');
// You carry 60% of it, so your $3,300 supports $5,500 of owning.
close(both.share, 0.6, 'share');
close(both.yours.budget, 5500, 'your budget together');
// Their debts count against the loan: enough of them and the back ratio binds.
const owing = H.limits({ ...you, co: { ...co, debts: 1500 } }, t);
assert.equal(owing.lender.by, 'back');
close(owing.lender.budget, 200000 / 12 * 0.36 - 1900, 'back-ratio budget');
// With nothing of yours to pay, no price is too high for you.
assert.equal(H.limits({ ...you, co: { ...co, split: 'custom', share: 0 } }, t).yours.price, Infinity);

// ── One price, for the people on the loan ──
const a = H.at(500000, { ...you, co }, t, 1800);
close(a.front, a.housing / (200000 / 12), 'front ratio', 1e-9);
close(a.back, (a.housing + 1300) / (200000 / 12), 'back ratio', 1e-9);
close(a.mine + a.theirs, a.owning, 'the two parts make the whole');
close(a.mine, a.owning * 0.6, 'your part');
close(a.rateNow, (7000 - 3000 - 1800) / 7000, 'savings rate now', 1e-9);
close(a.rateThen, (7000 - 3000 - a.mine) / 7000, 'savings rate after', 1e-9);
close(a.cashMine + a.cashTheirs, 70000, 'all the cash is used');
close(a.cashMine, 40000, 'your cash');
// At your own limit, the savings rate lands on the floor.
const edge = H.at(both.yours.price, { ...you, co }, t, 1800);
close(edge.rateThen, 0.1, 'the floor holds at your limit', 1e-4);
// More cash than the home costs: the rest stays with whoever brought it.
const rich = H.at(50000, { ...you, co }, t, 1800);
close(rich.cashUsed, 51500, 'only what is needed is used');
assert.equal(rich.loan, 0);

// ── Settings ──
const s = H.settings({ rate: '7.25', years: 15, price: '', cash: -5, co: { on: 1, income: '90000', split: 'nope' } });
assert.equal(s.rate, 7.25); assert.equal(s.years, 15); assert.equal(s.price, null); assert.equal(s.cash, 0);
assert.deepEqual(s.co, { on: true, income: 90000, debts: 0, cash: 0, split: 'income', share: 50 });
assert.equal(H.settings({ years: 7 }).years, 30);

// ── An average month ──
const tx = (d, amount) => ({ date_iso: d, amount });
const list = [tx('2026-01-05', -100), tx('2026-02-05', -300), tx('2026-03-05', 50), tx('2026-04-02', -900)];
// April is under way, so it is left out; March counts as a month with nothing spent.
assert.deepEqual(H.monthlyAvg(list, '2026-04-02', x => (x.amount < 0 ? -x.amount : 0)), { monthly: 400 / 3, months: 3 });
assert.deepEqual(H.monthlyAvg(list, '2026-04-02', x => (x.amount < 0 ? -x.amount : 0), 1), { monthly: 0, months: 1 });
assert.deepEqual(H.monthlyAvg([], '2026-04-02', () => 1), { monthly: 0, months: 0 });

console.log('home: ok');

// ── Exploring ──
{
  const t = H.settings({});
  const you = { gross: 120000, takeHome: 7000, debts: 400, other: 3000, cash: 40000, floor: 0.1 };
  const co = { on: true, income: 80000, debts: 900, cash: 30000, split: 'income', share: 50 };
  // Cash is split as it is now: 40 of every 70.
  const q = H.withCash({ ...you, co }, 140000);
  close(q.cash, 80000, 'your cash, doubled'); close(q.co.cash, 60000, 'their cash, doubled');
  assert.equal(H.withCash({ ...you, co: null }, 9).cash, 9);
  close(H.withCash({ ...you, cash: 0, co: { ...co, cash: 0 } }, 100).cash, 50, 'evenly from nothing');
  // At the income incomeFor gives, the lender's limit lands on the price.
  for (const price of [450000, 650000, 900000]) {
    const need = H.incomeFor(price, { ...you, co }, t);
    const L = H.limits({ ...you, co: { ...co, income: need } }, t);
    close(L.lender.price, price, `qualifying income for ${price}`, 2);
  }
  assert.equal(H.incomeFor(100000, { ...you, co }, t), 0, 'you carry it alone');
  // 20% down plus 3% closing.
  close(H.cashFor(500000, t), 115000, 'cash for 20% down');
  close(H.cost(500000, H.cashFor(500000, t), t).downShare, 0.2, 'which is 20% down', 1e-9);
  // Steps and ranges.
  assert.equal(H.niceStep(42000), 50000); assert.equal(H.niceStep(800), 1000);
  assert.deepEqual(H.around(500000, 50000, 5), [400000, 450000, 500000, 550000, 600000]);
  assert.deepEqual(H.around(10000, 10000, 5), [0, 10000, 20000, 30000, 40000], 'never below zero, still holding the value');
  // A grid cell is the verdict at that price and cash.
  const g = H.grid([400000, 700000], [20000, 120000], { ...you, co }, t, 1800);
  assert.equal(g.length, 2); assert.equal(g[0].length, 2);
  const cell = g[1][0], v = H.verdict(400000, H.withCash({ ...you, co }, 120000), t, 1800);
  close(cell.mine, v.a.mine, 'grid cell'); assert.equal(cell.broken, v.broken);
  assert.ok(g[0][1].mine > g[1][1].mine, 'less cash in costs more a month');
  assert.ok(g[1][1].mine > g[1][0].mine, 'a dearer home costs more a month');
}
console.log('home exploring: ok');
