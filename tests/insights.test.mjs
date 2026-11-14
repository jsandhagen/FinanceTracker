// The dashboard's derived numbers, run over the demo exports (no DOM).
import * as A from '../js/analyzer.js';
import * as I from '../js/insights.js';
import { demoFiles } from '../js/demo.js';
import assert from 'node:assert/strict';

const stored = demoFiles(new Date(2026, 5, 20)).flatMap(text => {
  const { format, transactions } = A.parseFile(text);
  assert.notEqual(format, 'unknown', 'demo files must parse as real exports');
  return transactions;
});
const txns = A.categorize(stored, { merchant: {}, amount_rules: [] }, []);
const ops = txns.filter(t => !t.is_transfer);
assert.equal(new Set(txns.map(t => t.account)).size, 3);

// Totals agree however they are sliced.
const sum = I.summarize(txns);
const months = I.monthly(ops);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} vs ${b}`);
close(months.reduce((s, m) => s + m.inc, 0), sum.income, 'monthly income');
close(months.reduce((s, m) => s + m.exp, 0), sum.expense, 'monthly spending');
close(I.totalsBy(ops, 'category').reduce((s, c) => s + c.total, 0), sum.expense, 'category spending');
close(I.totalsBy(ops, 'merchant', 1).reduce((s, c) => s + c.total, 0), sum.income, 'income by source');
const s = txns[txns.length - 1].ts, e = txns[0].ts;
const b = I.buckets(ops, s, e, 12);
close(b.exp.reduce((x, y) => x + y, 0), sum.expense, 'bucketed spending');
close([...I.dailySpend(ops).values()].reduce((x, y) => x + y, 0), sum.expense, 'daily spending');
assert.ok(sum.xfrOut > 0 && sum.savingsRate > 0 && sum.savingsRate < 1);

// Pace: the running total for the last month equals that month's spending.
const pace = I.spendPace(ops, '2026-06-20');
assert.equal(pace.cur.length, 20);
assert.equal(pace.prev.length, 31);
close(pace.curTotal, months.at(-1).exp, 'pace total');
close(pace.prevTotal, months.at(-2).exp, 'previous month total');
assert.equal(I.prevMonth('2026-01'), '2025-12');

// Recurring: rent is monthly, alive, and next due about a month after June 1.
const streams = A.findRecurringStreams(txns);
const asOf = A.localTs('2026-06-20');
const rent = streams.find(x => x.merchant.startsWith('RENT'));
const sch = I.schedule(rent, asOf);
assert.ok(sch.active && sch.interval >= 28 && sch.interval <= 31);
assert.ok(Math.abs(sch.next - A.localTs('2026-07-01')) <= 2 * I.DAY, 'next rent date');
close(sch.monthly, 1725 * 30.44 / sch.interval, 'rent per month');
assert.equal(I.schedule(rent, asOf + 200 * I.DAY).active, false, 'a stream that stopped is lapsed');
assert.equal(I.parseFmtDate(A.fmtDate('2026-03-09')), A.localTs('2026-03-09'));

// A paycheck's expected amount is what it has been lately: a $10,000 bonus from
// the same employer in March does not lift the biweekly $3,400, and a raise
// is picked up once it has been paid a few times.
const pay = [];
for (let d = A.localTs('2026-01-02'); d <= A.localTs('2026-10-30'); d += 14 * I.DAY) {
  pay.push({ date: A.fmtDate(new Date(d).toLocaleDateString('sv')), amount: d < A.localTs('2026-02-01') ? 3200 : 3400 });
}
pay.splice(6, 0, { date: pay[5].date, amount: 10000 });
const payStream = { merchant: 'ACME PAYROLL', direction: 'income',
  avg_amount: A.round2(pay.reduce((s, t) => s + t.amount, 0) / pay.length), transactions: pay };
assert.ok(payStream.avg_amount > 3650, 'the all-time mean is what the bonus skews');
const paySch = I.schedule(payStream, A.localTs('2026-11-05'));
assert.equal(paySch.amount, 3400, 'expected paycheck ignores the bonus');
close(paySch.monthly, 3400 * 30.44 / 14, 'paycheck per month');
const raised = { ...payStream, transactions: [...pay.slice(0, -3), ...pay.slice(-3).map(t => ({ ...t, amount: 3600 }))] };
assert.equal(I.schedule(raised, A.localTs('2026-11-05')).amount, 3600, 'a raise shows up by its third paycheck');

// As the salaried paycheck, with the bonus month known: the bonus is dropped
// from its amount and cadence, and a raise shows from the first new paycheck.
const asPay = I.schedule(payStream, A.localTs('2026-11-05'), { bonusMonth: 3 });
assert.equal(asPay.amount, 3400);
assert.equal(asPay.interval, 14);
assert.ok(I.withoutBonus(pay, 3).every(t => t.amount < 10000), 'bonus left out');
assert.equal(I.withoutBonus(pay, 3).length, pay.length - 1, 'the March paychecks stay');
const folded = pay.filter(t => t.amount !== 10000).map((t, i) => (i === 5 ? { ...t, amount: 13400 } : t));
assert.equal(I.withoutBonus(folded, 3).length, folded.length - 1, 'a paycheck with the bonus folded in is left out');
// The base and bonus paid together on the Mar 13 check, with the data ending
// soon after: that check was a payday, so the next one is Mar 27.
const toMarch = { ...payStream, transactions: folded.slice(0, 6) };
assert.equal(toMarch.transactions.at(-1).amount, 13400);
for (const end of ['2026-03-16', '2026-04-02']) {
  const sch = I.schedule(toMarch, A.localTs(end), { bonusMonth: 3 });
  assert.ok(sch.active, `still paid as of ${end}`);
  assert.equal(sch.amount, 3400);
  assert.equal(sch.last, A.localTs('2026-03-13'), 'the combined check was a payday');
  // within the hour the clocks moved on Mar 8
  assert.ok(Math.abs(sch.next - Math.max(A.localTs('2026-03-27'), A.localTs(end))) <= 3600000, `next payday as of ${end}`);
}
// A bonus on a day of its own does not move the paydays.
const ownDay = { ...payStream, transactions: [...pay.slice(0, 5), { date: A.fmtDate('2026-03-06'), amount: 10000 }] };
assert.ok(Math.abs(I.schedule(ownDay, A.localTs('2026-03-09'), { bonusMonth: 3 }).next - A.localTs('2026-03-13')) <= 3600000);
const oneRaise = { ...payStream, transactions: [...pay.slice(0, -1), { ...pay.at(-1), amount: 3600 }] };
assert.equal(I.schedule(oneRaise, A.localTs('2026-11-05'), { bonusMonth: 3 }).amount, 3600, 'salary raise shows at once');
assert.equal(I.schedule(oneRaise, A.localTs('2026-11-05')).amount, 3400, 'other streams wait for a new amount to repeat');

// Budgets: budgeted categories first, spent matches the category total for the month.
const rows = I.budgetRows(ops, '2026-05', { Groceries: 600 });
assert.equal(rows[0].name, 'Groceries');
close(rows[0].spent, I.totalsBy(ops.filter(t => t.date_iso.startsWith('2026-05')), 'category').find(c => c.name === 'Groceries').total, 'budget spent');
assert.ok(rows[0].avg > 0);

// Signals: the price rise and the fee both surface.
const sig = I.signals({ ops, priorOps: [], hasPrior: false, streams, asOf, money: n => '$' + Math.round(n) });
assert.ok(sig.some(x => /SPOTIFY/.test(x.title) && /went up/.test(x.title)), 'price change');
assert.ok(sig.some(x => x.cat === 'Fees'), 'fees');
assert.ok(sig.some(x => /Kept \d+% of income/.test(x.title)), 'savings rate');
console.log('insights tests passed');

// Outlook: the forecast is the starting balance, each expected event on its day,
// and everyday spending; the room for a one-off is the low point less the cushion.
{
  const day0 = new Date(2026, 5, 20).getTime(), at = n => { const d = new Date(day0); d.setDate(d.getDate() + n); return d.getTime(); };
  const sched = [
    { active: true, amount: 1000, interval: 14, next: at(5), idx: 0, s: { direction: 'income', merchant: 'PAY' } },
    { active: true, amount: 1200, interval: 30, next: at(11), idx: 1, s: { direction: 'expense', merchant: 'RENT' } },
    { active: false, amount: 50, interval: 30, next: at(2), idx: 2, s: { direction: 'expense', merchant: 'GONE' } },
  ];
  const ev = I.expected(sched, day0, 60);
  assert.deepEqual(ev.filter(e => e.name === 'PAY').map(e => Math.round((e.ts - day0) / I.DAY)), [5, 19, 33, 47]);
  assert.deepEqual(ev.filter(e => e.name === 'RENT').map(e => new Date(e.ts).getDate()), [1, 1], 'a monthly bill keeps its day of the month');
  assert.ok(!ev.some(e => e.name === 'GONE'), 'lapsed streams are not expected');
  const f = I.forecast({ start: 1000, asOf: day0, events: ev, perDay: 20, days: 60 });
  assert.equal(f.length, 61);
  assert.equal(f[0].bal, 1000);
  assert.equal(f[4].bal, 920);
  assert.equal(f[5].bal, 1900);
  close(f[60].bal, 1000 + 4000 - 2400 - 60 * 20, 'forecast end');
  const low = I.lowPoint(f);
  assert.equal(low.day, 18); assert.equal(low.bal, 440);
  assert.equal(I.roomOn(f, 0), 440);
  assert.equal(I.roomOn(f, 100), 340);
  assert.equal(I.roomOn(f, 500), 0, 'no room once the low point is under the cushion');
  assert.equal(I.roomOn(f, 0, 19), I.lowPoint(f, 19).bal);
  assert.ok(I.roomOn(f, 0, 33) >= I.roomOn(f, 0), 'waiting never leaves less room');
  // Something already due lands on the first day.
  assert.equal(I.forecast({ start: 0, asOf: day0, events: [{ ts: day0, amount: -30 }], perDay: 0, days: 2 })[1].bal, -30);
}
{
  const asOf = txns[0].ts;
  const all = I.spendRate(ops, asOf, { days: 90 }), noTravel = I.spendRate(ops, asOf, { days: 90, skip: t => t.category !== 'Groceries' });
  assert.ok(all.perDay > noTravel.perDay && noTravel.perDay > 0 && all.span === 90);
  const day = I.DAY, mk = (d, amount, merchant = 'DELTA', category = 'Travel') => ({ ts: d * day, amount, merchant, category, account: 'Card', date_fmt: String(d) });
  // Trips: one a month, dated by the stay; what was paid ahead goes to the trip it was for.
  const d = (m, dd) => new Date(2026, m - 1, dd).getTime();
  const tv = (ts, amount, description, raw_category = '') => ({ ts, amount, description, raw_category, merchant: description, category: 'Travel' });
  const travel = [
    tv(d(1, 5), -380, 'DELTA AIR LINES', 'Airfare'),          // paid in January for March
    tv(d(2, 10), -290, 'UNITED AIRLINES', 'Airfare'),         // paid in February for February
    tv(d(2, 20), -410, 'HILTON GARDEN INN', 'Lodging'),
    tv(d(2, 21), -35, 'NATIONAL PARK ENTRY'),
    tv(d(3, 1), -120, 'HERTZ', 'Car Rental'),                 // prepaid
    tv(d(3, 14), -260, 'MARRIOTT DOWNTOWN', 'Lodging'),
    tv(d(3, 16), -240, 'MARRIOTT DOWNTOWN', 'Lodging'),
    tv(d(3, 28), -180, 'HOLIDAY INN', 'Lodging'),             // a second stay the same month: still March
    tv(d(4, 2), -85, 'GLOBAL ENTRY'),                         // not a trip
    tv(d(4, 10), -450, 'SOUTHWEST AIR', 'Airfare'),           // no stay with it: its own trip
    tv(d(6, 12), -520, 'AIRBNB', 'Lodging'),                  // paid ahead, nothing stayed yet
    tv(d(6, 14), -310, 'JETBLUE', 'Airfare'),
    { ts: d(3, 15), amount: -60, description: 'CAFE', merchant: 'CAFE', category: 'Dining' },
  ];
  assert.deepEqual(['DELTA AIR LINES', 'Sixt AB1CDEFGH', 'SIXT 9600000001', 'AIRBNB * HM1ABCDEF2', 'HILTON', 'CAPITAL 1 LOUNGE', 'GLOBAL ENTRY'].map(x => I.travelKind({ description: x })),
    ['flight', 'car', 'counter', 'booked', 'stay', 'other', null], 'a rental with a booking reference was reserved online; without one it was paid at the counter');
  assert.equal(I.travelKind({ description: 'UNITED      0160000000001', raw_category: 'Airfare' }), 'flight', "the card's own label decides first");
  const tr = I.trips(travel, d(6, 20));
  assert.deepEqual(tr.map(x => [x.ym, x.total, x.booked]), [['2026-02', 735, false], ['2026-03', 1180, false], ['2026-04', 450, false], ['2026-06', 830, true]]);
  assert.deepEqual(tr[1].parts, { flight: 380, car: 120, stay: 680, other: 0 });
  // A car reserved online goes to the trip where that company was paid at the
  // counter, not to a nearer trip that used another; a booking charged again
  // weeks later was settled then, and is a trip of its own.
  const cars = [
    tv(d(6, 14), -1400, 'Sixt AB1CDEFGH', 'Car Rental'), tv(d(7, 5), -250, 'Sixt AB1CDEFGH', 'Car Rental'),
    tv(d(8, 8), -650, 'Sixt AB2JKLMNP', 'Car Rental'),
    tv(d(8, 16), -600, 'COURTYARD HOTEL', 'Lodging'), tv(d(8, 17), -180, 'ENTERPRISE RENT-A-CAR', 'Car Rental'),
    tv(d(8, 29), -20, 'SIXT_DENVER AP_POS_12', 'Car Rental'), tv(d(9, 1), -370, 'COT*HTL'), tv(d(9, 3), -10, 'LAKESIDE INN', 'Lodging'),
  ];
  assert.deepEqual(I.trips(cars, d(11, 7)).map(x => [x.ym, x.total, x.parts.car]), [['2026-07', 1650, 1650], ['2026-08', 780, 180], ['2026-09', 1050, 670]]);
  const st = I.tripStats(travel, d(6, 20));
  assert.deepEqual([st.count, st.typical, st.ahead, st.aheadCount], [3, 735, 830, 1]);
  const dup = I.duplicates([mk(1, -45, 'SHOP'), mk(2, -45, 'SHOP'), mk(5, -45, 'OTHER'), mk(30, -45, 'OTHER'), mk(1, -5, 'CAFE'), mk(1, -5, 'CAFE')]);
  assert.deepEqual(dup.map(t => t.merchant), ['SHOP']);
}

// Room before the savings rate turns: at the room exactly, the rate is the target.
{
  assert.equal(I.spendRoom(10000, 6000), 4000);
  assert.equal(I.spendRoom(10000, 6000, 0.2), 2000);
  close((10000 - 6000 - I.spendRoom(10000, 6000, 0.2)) / 10000, 0.2, 'rate at the room');
  assert.ok(I.spendRoom(5000, 6000) < 0);
  const from = txns[txns.length - 1].ts, to = txns[0].ts, k = I.keptByDay(ops, from, to);
  close(k[k.length - 1].bal, sum.net, 'kept over all the data is its net');
  assert.ok(k.every((p, i) => !i || p.ts > k[i - 1].ts));
}
