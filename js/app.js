import * as store from './storage.js';
import * as A from './analyzer.js';
import * as I from './insights.js';
import * as sync from './sync.js';
import * as watch from './watch.js';
import { cleanLink, downloadLink } from './links.js';
import { demoFiles } from './demo.js';
import { BUILD } from './version.js';

const { ALL_CATS, TRANSFER_CATEGORIES: TRANSFER_CATS } = A;
const DAY = I.DAY;

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmt(n) { return Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const fmt0 = n => Math.round(Math.abs(n)).toLocaleString('en-US');
const money = n => (n < 0 ? '−$' : '$') + fmt(n);
const money0 = n => (Math.round(n) < 0 ? '−$' : '$') + fmt0(n);
const signed = n => (n >= 0 ? '+$' : '−$') + fmt(n);
const moneyK = v => {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1).replace('.0', '')}M` : a >= 1e4 ? `${s}$${Math.round(a / 1e3)}k` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(1).replace('.0', '')}k` : `${s}$${Math.round(a)}`;
};
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const isoLocal = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isPhone = () => matchMedia('(max-width: 640px)').matches;
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shortDate = ms => new Date(ms).toLocaleString('en-US', { month: 'short', day: '2-digit' });
// Calendar arithmetic. Adding 24-hour blocks drifts an hour across a daylight
// saving change, which is enough to drop or add a day at the edge of a period.
const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
const dayStart = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const dayEnd = ms => addDays(dayStart(ms), 1) - 1;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isErr ? 6000 : 3500);
}

function monthLabel(ym, long = false) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return long ? d.toLocaleString('en-US', { month: 'long', year: 'numeric' }) : `${d.toLocaleString('en-US', { month: 'short' })} ’${String(y).slice(2)}`;
}
const monthName = ym => new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1).toLocaleString('en-US', { month: 'short' });

// Chart colours. Money in is blue and money out is orange: that pair stays apart
// for colour-blind readers, which green and red do not. Green and red are kept
// for signed figures in text, where the sign says it too.
const C = {
  in: '#3987e5', out: '#d95926', kept: '#199e70', lead: '#5aa2f5',
  ink: '#ededed', ink2: '#b4b4b4', ink3: '#7a7a7a',
  grid: 'rgba(255,255,255,0.1)', surface: '#060606', other: '#6e6e6e',
};
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];
const HEAT = ['#184f95', '#256abf', '#3987e5', '#9ec5f4']; // one blue ramp, brighter for a heavier day
const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const ZERO = '#10151c'; // an empty heatmap day

// ── State ─────────────────────────────────────────────────────────────────────
let state;            // what storage.js holds
let demo = false;     // synthetic data in memory; nothing is written or synced
let ALL_TXN = [];     // derived: categorized, newest first
let STREAMS = [];
let SCHED = [];       // STREAMS with their next expected date
let BALANCE = [];
let DATA_MIN = 0, DATA_MAX = 0;   // first moment of the first day, last moment of the last
let DATA_LAST = 0;                // first moment of the last day
let CAT_SLOT = {};    // category -> series colour, fixed by all-time rank
let CTX = null;       // everything the views draw, for the selected period

let view = 'overview';
let rangePreset = null;
let activeCat = 'all';
let showTransfers = false;
let txnDir = '';
let txnLimit = 200;
let txnSort = { key: 'date', dir: -1 };
let visibleTxns = [];
let cpIncomeOverride = null;
const cpExcluded = new Set();
let budMonth = null;

// Saves the state, and queues a sync. `rules` marks the rule set as changed, which
// is what lets the newer rule set win when two devices merge.
async function commit({ rules = false } = {}) {
  if (demo) return;
  const now = Date.now();
  state.meta.updatedAt = now;
  if (rules) state.meta.rulesUpdatedAt = now;
  await store.saveData(state);
  scheduleSync();
}

// ── Charts ────────────────────────────────────────────────────────────────────
const charts = {};
let chartsReady = false;

const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(c, _a, opts) {
    if (!opts.on) return;
    const act = c.tooltip?.getActiveElements?.() || [];
    if (!act.length) return;
    const x = act[0].element.x, { top, bottom } = c.chartArea, g = c.ctx;
    g.save();
    g.strokeStyle = 'rgba(138,187,255,0.6)'; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
    g.restore();
  },
};

function initCharts() {
  if (chartsReady) return;
  chartsReady = true;
  const d = Chart.defaults;
  d.color = C.ink3;
  d.borderColor = C.grid;
  d.font.family = MONO;
  d.font.size = 10;
  d.maintainAspectRatio = false;
  d.animation.duration = 250;
  d.plugins.legend.labels.boxWidth = 10;
  d.plugins.legend.labels.boxHeight = 2;
  d.plugins.legend.labels.padding = 14;
  d.plugins.legend.labels.color = C.ink2;
  d.plugins.legend.labels.font = { family: MONO, size: 10 };
  d.plugins.legend.align = 'start';
  Object.assign(d.plugins.tooltip, {
    backgroundColor: '#000', borderColor: '#4c90f0', borderWidth: 1, cornerRadius: 0, padding: 9,
    titleColor: C.ink2, bodyColor: C.ink, boxWidth: 8, boxHeight: 8, boxPadding: 4,
    titleFont: { family: MONO, size: 10, weight: '500' }, bodyFont: { family: MONO, size: 11 }, footerFont: { family: MONO, size: 11 },
  });
  Chart.register(crosshair);
}

function chart(id, cfg) {
  charts[id]?.destroy();
  charts[id] = new Chart($(id), cfg);
  return charts[id];
}
const yMoney = { ticks: { callback: v => moneyK(v), padding: 8 }, grid: { color: C.grid }, border: { display: false, dash: [2, 4] } };
const xPlain = extra => ({ grid: { display: false }, border: { color: '#3d3d3d' }, ticks: { maxRotation: 0, autoSkipPadding: 12, ...extra } });
const hoverLine = { interaction: { mode: 'index', intersect: false } };

// Tiny inline charts for the stat tiles.
function sparkBars(arr, color) {
  const max = Math.max(...arr.map(Math.abs), 1), n = arr.length, w = 100 / n;
  const neg = arr.some(v => v < 0), base = neg ? 14 : 28, h = neg ? 14 : 28;
  return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">${arr.map((v, i) => {
    const bh = Math.max(Math.abs(v) / max * h, v ? 1 : 0);
    return `<rect x="${(i * w + w * 0.15).toFixed(2)}" y="${(v >= 0 ? base - bh : base).toFixed(2)}" width="${(w * 0.7).toFixed(2)}" height="${bh.toFixed(2)}" fill="${color}"/>`;
  }).join('')}</svg>`;
}
function sparkLine(arr, color) {
  if (arr.length < 2) return '';
  const min = Math.min(...arr), max = Math.max(...arr), span = max - min || 1;
  const pts = arr.map((v, i) => `${(i / (arr.length - 1) * 100).toFixed(2)},${(26 - (v - min) / span * 24).toFixed(2)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="0,28 ${pts} 100,28" fill="${color}" opacity="0.14"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

// ── Hover tooltip for the hand-drawn marks (data-tip="Title|value") ──────────
const tipEl = $('tip');
function hideTip() { tipEl.classList.remove('show'); }
document.addEventListener('pointerover', ev => {
  const t = ev.target.closest?.('[data-tip], .app.rail [data-rail-tip]');
  if (!t) { hideTip(); return; }
  const [title, value] = (t.dataset.tip || t.dataset.railTip).split('|');
  tipEl.innerHTML = `<div class="tip-t">${esc(title)}</div>${value ? `<div class="tip-v">${esc(value)}</div>` : ''}`;
  tipEl.classList.add('show');
});
document.addEventListener('pointermove', ev => {
  if (!tipEl.classList.contains('show')) return;
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  tipEl.style.left = Math.max(6, Math.min(ev.clientX + 12, innerWidth - w - 6)) + 'px';
  tipEl.style.top = (ev.clientY + 16 + h > innerHeight ? ev.clientY - h - 10 : ev.clientY + 16) + 'px';
});
document.addEventListener('scroll', hideTip, true);

// ── Views ─────────────────────────────────────────────────────────────────────
const VIEWS = { overview: 'Overview', cashflow: 'Cash flow', spending: 'Spending', budgets: 'Budgets', recurring: 'Recurring', transactions: 'Transactions' };
const RANGE_FREE = new Set(['budgets', 'recurring']); // these keep their own clock

function showView() {
  const has = state.transactions.length > 0;
  $('welcome').hidden = has;
  $('dashboard').hidden = !has;
  $('demo-banner').hidden = !demo;
  if (has) rebuild(false);
}

function setView(v, { push = true } = {}) {
  if (!VIEWS[v]) return;
  view = v;
  document.querySelectorAll('.view').forEach(s => { s.hidden = s.dataset.view !== v; });
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('view-title').textContent = VIEWS[v];
  $('filter-bar').hidden = RANGE_FREE.has(v);
  if (push && location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
  $('views').scrollTop = 0;
  if (!$('dashboard').hidden) window.scrollTo(0, 0);
  renderActive();
}

document.addEventListener('click', ev => {
  const nav = ev.target.closest('.nav-item, [data-goto]');
  if (nav) setView(nav.dataset.view || nav.dataset.goto);
});

// Jump to the ledger with a filter already applied.
function goTxns({ cat = 'all', search = '' } = {}) {
  activeCat = cat;
  $('txn-search').value = search ? escRe(search) : '';
  txnDir = '';
  document.querySelectorAll('.txn-dir-pill').forEach(b => b.classList.toggle('active', b.dataset.dir === ''));
  $('txn-amt-op').value = ''; $('txn-amt-val').value = '';
  if (cat !== 'all' && TRANSFER_CATS.has(cat)) { showTransfers = true; $('show-xfr').checked = true; }
  txnLimit = 200;
  setView('transactions');
}
document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-txn-cat], [data-txn-search]');
  if (!el || ev.target.closest('.txn-cat')) return;
  goTxns({ cat: el.dataset.txnCat || 'all', search: el.dataset.txnSearch || '' });
});

// Re-derives everything from storage. keepRange holds the date filter where it was
// (after a recategorize); otherwise the period goes back to its preset.
function rebuild(keepRange) {
  initCharts();
  ALL_TXN = A.categorize(state.transactions, state.rules, state.training);
  STREAMS = A.findRecurringStreams(ALL_TXN);
  BALANCE = A.buildAssetSeries(ALL_TXN, Number(state.settings.cc_start) || 0);

  const tss = ALL_TXN.map(t => t.ts);
  DATA_MIN = Math.min(...tss);
  DATA_LAST = Math.max(...tss);
  DATA_MAX = dayEnd(DATA_LAST);
  for (const id of ['date-start', 'date-end']) { $(id).min = isoLocal(DATA_MIN); $(id).max = isoLocal(DATA_MAX); }
  SCHED = STREAMS.map((s, idx) => ({ s, idx, ...I.schedule(s, DATA_LAST) }));

  const allOps = ALL_TXN.filter(t => !t.is_transfer);
  CAT_SLOT = {};
  I.totalsBy(allOps, 'category').slice(0, SERIES.length).forEach((c, i) => { CAT_SLOT[c.name] = SERIES[i]; });

  // Latest known balance per account for the side rail.
  const accts = new Map();
  for (const t of ALL_TXN) if (!accts.has(t.account)) accts.set(t.account, null);
  for (const t of ALL_TXN) if (t.balance != null && accts.get(t.account) == null) accts.set(t.account, t.balance);
  $('acct-badges').innerHTML = [...accts].sort((a, b) => a[0].localeCompare(b[0])).map(([a, bal]) =>
    `<div class="acct"><span class="acct-name">${esc(a)}</span><span class="acct-bal">${bal == null ? '' : money0(bal)}</span></div>`).join('');

  const hasBal = BALANCE.length > 1;
  $('balance-card').hidden = !hasBal;
  $('pace-card').className = 'panel ' + (hasBal ? 'c4' : 'c12');

  const months = [...new Set(allOps.map(t => t.date_iso.slice(0, 7)))].sort().reverse();
  if (!months.includes(budMonth)) budMonth = months[0];
  $('bud-month').innerHTML = months.map(m => `<option value="${m}"${m === budMonth ? ' selected' : ''}>${monthLabel(m, true)}</option>`).join('');

  let [s, e] = getInputMs();
  if (!keepRange || isNaN(s) || isNaN(e)) {
    if (!rangePreset || rangePreset === 'custom') rangePreset = (DATA_MAX - DATA_MIN) / DAY > 200 ? '90' : '0';
    [s, e] = presetRange(rangePreset);
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.days === rangePreset));
    setDateInputs(s, e);
  }
  setView(view, { push: false });
  recompute(s, e);
}

// ── Core recompute ────────────────────────────────────────────────────────────
function recompute(startMs, endMs) {
  const inRange = (a, b) => ALL_TXN.filter(t => t.ts >= a && t.ts <= b);
  const txns = inRange(startMs, endMs);
  const ops = txns.filter(t => !t.is_transfer);
  const len = endMs - startMs + 1;
  const ps = addDays(startMs, -Math.max(1, Math.round(len / DAY))), pe = startMs - 1;
  const hasPrior = ps >= DATA_MIN - 3 * DAY;
  const priorTxns = hasPrior ? inRange(ps, pe) : [];
  CTX = {
    s: startMs, e: endMs, days: Math.max(1, Math.round(len / DAY)),
    txns, ops, cur: I.summarize(txns),
    hasPrior, priorOps: priorTxns.filter(t => !t.is_transfer), prior: I.summarize(priorTxns),
    allOps: ALL_TXN.filter(t => !t.is_transfer),
  };
  txnLimit = 200;
  renderActive();
  renderStatus();
}

function renderActive() {
  if (!CTX || $('dashboard').hidden) return;
  hideTip();
  ({ overview: renderOverview, cashflow: renderCashflow, spending: renderSpending,
    budgets: renderBudgets, recurring: renderRecurring, transactions: renderTransactions })[view](CTX);
}

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (view === 'cashflow' || view === 'spending') renderActive(); }, 150); });

// A stat tile. `good` says whether the change is welcome, which is not the same
// as whether it went up: spending going up is not.
function kpiTile({ label, value, tone = '', delta = null, sub = '', spark = '' }) {
  const d = deltaHtml(delta);
  return `<div class="kpi ${tone}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-val">${value}</div>
    <div class="kpi-foot">${d}<span class="kpi-sub">${sub}</span></div>
    ${spark}
  </div>`;
}
function deltaHtml(delta) {
  if (!delta) return '';
  const flat = delta.good == null;
  return `<span class="delta ${flat ? 'flat' : delta.good ? 'good' : 'bad'}">${flat ? '=' : delta.v > 0 ? '▲' : '▼'} ${delta.text}</span>`;
}
function setKpis(id, tiles) {
  $(id).style.setProperty('--n', tiles.length);
  $(id).innerHTML = tiles.join('');
}
function relDelta(now, was, upIsGood) {
  if (!was) return null;
  const v = (now - was) / Math.abs(was), flat = Math.abs(v) < 0.0005;
  return { v, text: pct(Math.abs(v), Math.abs(v) < 0.1 ? 1 : 0), good: flat ? null : (v > 0) === upIsGood };
}

// ── Overview ──────────────────────────────────────────────────────────────────
function renderOverview(c) {
  const { cur, prior, hasPrior } = c;
  const b = I.buckets(c.ops, c.s, c.e, Math.min(24, Math.max(6, Math.round(c.days / 7))));
  const vs = hasPrior ? `vs prior ${c.days}d` : '';
  const tiles = [];

  const bal = BALANCE.filter(d => { const ts = A.localTs(d.date); return ts >= c.s && ts <= c.e; });
  if (bal.length > 1) {
    const first = bal[0].net, last = bal[bal.length - 1].net, diff = last - first;
    tiles.push(kpiTile({ label: 'Net worth', value: money0(last),
      delta: { v: diff, text: money0(Math.abs(diff)), good: Math.abs(diff) < 0.5 ? null : diff > 0 }, sub: 'over period',
      spark: sparkLine(bal.map(d => d.net), C.lead) }));
  }
  tiles.push(kpiTile({ label: 'Income', value: money0(cur.income), delta: hasPrior ? relDelta(cur.income, prior.income, true) : null, sub: vs, spark: sparkBars(b.inc, C.in) }));
  tiles.push(kpiTile({ label: 'Spending', value: money0(cur.expense), delta: hasPrior ? relDelta(cur.expense, prior.expense, false) : null, sub: vs, spark: sparkBars(b.exp, C.out) }));
  tiles.push(kpiTile({ label: 'Net cash flow', value: (cur.net >= 0 ? '+' : '') + money0(cur.net), tone: cur.net >= 0 ? 'pos' : 'neg',
    delta: hasPrior ? { v: cur.net - prior.net, text: money0(Math.abs(cur.net - prior.net)), good: Math.abs(cur.net - prior.net) < 0.5 ? null : cur.net > prior.net } : null,
    sub: vs, spark: sparkBars(b.net, C.ink3) }));
  if (cur.savingsRate != null) {
    const r = cur.savingsRate, pr = prior.savingsRate;
    tiles.push(kpiTile({ label: 'Savings rate', value: pct(r, 1), tone: r >= 0 ? 'pos' : 'neg',
      delta: hasPrior && pr != null ? { v: r - pr, text: `${Math.abs((r - pr) * 100).toFixed(1)} pts`, good: Math.abs(r - pr) < 0.0005 ? null : r > pr } : null, sub: vs,
      spark: `<div class="meter" aria-hidden="true"><div style="width:${Math.max(0, Math.min(100, r * 100)).toFixed(1)}%"></div></div>` }));
  }
  if (bal.length <= 1) tiles.push(kpiTile({ label: 'Transactions', value: cur.count.toLocaleString(), sub: `${moneyK(cur.xfrOut)} in transfers excluded` }));
  setKpis('kpi-row', tiles);

  if (bal.length > 1) {
    const g = $('balance-chart').getContext('2d').createLinearGradient(0, 0, 0, 260);
    g.addColorStop(0, 'rgba(57,135,229,0.3)'); g.addColorStop(1, 'rgba(57,135,229,0)');
    chart('balance-chart', {
      type: 'line',
      data: { labels: bal.map(d => A.fmtDate(d.date)), datasets: [
        { label: 'Net worth', data: bal.map(d => d.net), borderColor: C.lead, backgroundColor: g, borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0, fill: true },
        { label: 'Bank balance', data: bal.map(d => d.total_bank), borderColor: C.ink2, borderWidth: 1, pointRadius: 0, pointHoverRadius: 3, tension: 0, borderDash: [3, 3] },
        { label: 'Card balance', data: bal.map(d => d.cc_outstanding), borderColor: C.out, borderWidth: 1, pointRadius: 0, pointHoverRadius: 3, tension: 0, borderDash: [3, 3] },
      ] },
      options: { ...hoverLine,
        plugins: { crosshair: { on: true }, tooltip: { callbacks: { label: x => ` ${x.dataset.label}  ${money(x.parsed.y)}` } } },
        scales: { x: xPlain({ maxTicksLimit: 7 }), y: yMoney } },
    });
  }

  // This month against last, as running totals.
  const p = I.spendPace(c.allOps, isoLocal(Math.min(c.e, DATA_MAX)));
  $('pace-meta').textContent = `${monthName(p.ym)} vs ${monthName(p.pm)}`;
  const diff = p.curTotal - p.prevAtDay;
  $('pace-head').innerHTML = `<span class="pace-val">${money0(p.curTotal)}</span>
    <span class="pace-note">${p.hasPrev
      ? `<b class="${diff <= 0 ? 'pos' : 'neg'}">${money0(Math.abs(diff))} ${diff <= 0 ? 'less' : 'more'}</b> than ${monthName(p.pm)} at day ${p.day}`
      : `through day ${p.day} of ${monthName(p.ym)}`}</span>`;
  const n = Math.max(p.cur.length, p.prev.length, 28);
  chart('pace-chart', {
    type: 'line',
    data: { labels: Array.from({ length: n }, (_, i) => i + 1), datasets: [
      { label: monthName(p.ym), data: p.cur, borderColor: C.lead, backgroundColor: 'rgba(57,135,229,0.16)', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, fill: true, stepped: true },
      ...(p.hasPrev ? [{ label: monthName(p.pm), data: p.prev, borderColor: C.ink3, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, pointHoverRadius: 3, stepped: true }] : []),
    ] },
    options: { ...hoverLine,
      plugins: { crosshair: { on: true }, tooltip: { callbacks: { title: x => `Day ${x[0].label}`, label: x => ` ${x.dataset.label}  ${money(x.parsed.y)}` } } },
      scales: { x: xPlain({ maxTicksLimit: 6 }), y: { ...yMoney, beginAtZero: true } } },
  });

  const months = I.monthly(c.ops);
  chart('monthly-chart', {
    type: 'bar',
    data: { labels: months.map(m => monthLabel(m.ym)), datasets: [
      { label: 'Net', type: 'line', data: months.map(m => A.round2(m.net)), borderColor: C.ink, backgroundColor: C.ink, borderWidth: 1.25, pointRadius: 2.5, pointHoverRadius: 4, pointBorderColor: C.surface, pointBorderWidth: 2, tension: 0 },
      { label: 'Income', data: months.map(m => A.round2(m.inc)), backgroundColor: C.in, borderRadius: 0, maxBarThickness: 22 },
      { label: 'Spending', data: months.map(m => A.round2(m.exp)), backgroundColor: C.out, borderRadius: 0, maxBarThickness: 22 },
    ] },
    options: { ...hoverLine,
      plugins: { tooltip: { callbacks: { label: x => ` ${x.dataset.label}  ${money(x.parsed.y)}` } } },
      scales: { x: xPlain(), y: yMoney }, datasets: { bar: { categoryPercentage: 0.6, barPercentage: 0.82 } } },
  });

  const cats = I.totalsBy(c.ops, 'category');
  const before = new Map(I.totalsBy(c.priorOps, 'category').map(x => [x.name, x.total]));
  $('ov-cats').innerHTML = cats.length ? barRows(cats.slice(0, 7), cur.expense, x => ({
    attr: `data-txn-cat="${esc(x.name)}"`, delta: hasPrior ? relDelta(x.total, before.get(x.name), false) : null,
  })) : empty('No spending in this period.');

  const soon = upcoming();
  $('ov-upcoming').innerHTML = soon.length ? soon.slice(0, 6).map(upcomingRow).join('') : empty('No recurring charges expected in the next 30 days.');

  const sig = I.signals({ ops: c.ops, priorOps: c.priorOps, hasPrior, streams: STREAMS, asOf: DATA_LAST, money: money0 });
  $('ov-signals-meta').textContent = `${sig.length} for this period`;
  $('ov-insights').innerHTML = sig.length ? sig.slice(0, 6).map(s => {
    const nav = s.cat ? `data-txn-cat="${esc(s.cat)}"` : s.search ? `data-txn-search="${esc(s.search)}"` : '';
    return `<div class="signal ${s.tone}${nav ? ' link' : ''}" ${nav}>
      <span class="signal-mark">${s.tone === 'good' ? '+' : s.tone === 'warn' ? '!' : 'i'}</span>
      <div><div class="signal-title">${esc(s.title)}</div><div class="signal-detail">${esc(s.detail)}</div></div>
    </div>`;
  }).join('') : empty('Nothing stands out in this period.');

  const ym = isoLocal(DATA_MAX).slice(0, 7);
  const rows = I.budgetRows(c.allOps, ym, state.settings.budgets).filter(r => r.budget > 0);
  $('ov-budgets').innerHTML = rows.length
    ? `<div class="list-note">${monthLabel(ym, true)}</div>` + rows.sort((a, b2) => b2.spent / b2.budget - a.spent / a.budget).slice(0, 5).map(r => budgetBar(r, monthProgress(ym))).join('')
    : `<div class="empty">No budgets yet.<br><button class="btn small" data-goto="budgets" style="margin-top:.6rem">Set monthly limits</button></div>`;
}

const empty = msg => `<div class="empty">${msg}</div>`;

// Ranked rows: name, a bar scaled to the largest, the amount and share of total.
function barRows(items, total, extra = () => ({})) {
  const max = items[0]?.total || 1;
  return items.map(x => {
    const { attr = '', delta = null } = extra(x);
    const d = deltaHtml(delta);
    return `<div class="bar-row link" ${attr}>
      <div class="bar-top"><span class="bar-name">${esc(x.name)}</span>${d}<span class="bar-amt">${money(x.total)}</span><span class="bar-share">${total > 0 ? pct(x.total / total) : ''}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${(x.total / max * 100).toFixed(1)}%"></div></div>
    </div>`;
  }).join('');
}

function upcoming() {
  const asOf = DATA_LAST;
  return SCHED.filter(x => x.active && x.next <= asOf + 30 * DAY).sort((a, b) => a.next - b.next);
}
function upcomingRow(x) {
  const asOf = DATA_LAST, inDays = Math.round((x.next - asOf) / DAY), inc = x.s.direction === 'income';
  return `<div class="up-row link" data-stream="${x.idx}">
    <span class="up-date">${shortDate(x.next)}</span>
    <span class="up-name">${esc(x.s.merchant)}<small>${x.s.frequency} · ${inDays <= 0 ? 'due now' : `in ${inDays}d`}</small></span>
    <span class="amt ${inc ? 'pos' : ''}">${inc ? '+' : '−'}$${fmt(x.s.avg_amount)}</span>
  </div>`;
}

// How far through the month the data is: 1 for a finished month.
function monthProgress(ym) {
  const last = isoLocal(DATA_MAX);
  if (last.slice(0, 7) !== ym) return 1;
  return Number(last.slice(8, 10)) / new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
}
function budgetBar(r, progress) {
  const ratio = r.spent / r.budget, over = r.spent - r.budget;
  const state2 = ratio > 1 ? 'over' : ratio > 0.85 ? 'near' : 'ok';
  return `<div class="bud-mini">
    <div class="bar-top"><span class="bar-name">${esc(r.name)}</span>
      <span class="tag ${state2}">${state2 === 'over' ? `OVER ${money0(over)}` : `${money0(-over)} LEFT`}</span></div>
    <div class="bar-track tall"><div class="bar-fill ${state2}" style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></div>${progress < 1 ? `<i class="pace-tick" style="left:${(progress * 100).toFixed(1)}%"></i>` : ''}</div>
    <div class="bud-nums"><span>${money0(r.spent)} of ${money0(r.budget)}</span><span>${pct(ratio)}</span></div>
  </div>`;
}

// ── Cash flow ─────────────────────────────────────────────────────────────────
function renderCashflow(c) {
  renderSankey(c);

  const months = I.monthly(c.ops).reverse();
  const maxNet = Math.max(...months.map(m => Math.abs(m.net)), 1);
  const avg = k => months.reduce((s, m) => s + m[k], 0) / (months.length || 1);
  const netBar = v => `<div class="div-bar"><i class="${v >= 0 ? 'pos' : 'neg'}" style="width:${(Math.abs(v) / maxNet * 50).toFixed(1)}%"></i></div>`;
  $('cf-table').innerHTML = `<thead><tr><th>Month</th><th class="num">Income</th><th class="num">Spending</th><th class="num">Net</th><th class="col-hide-sm"></th><th class="num">Kept</th></tr></thead>
    <tbody>${months.map(m => `<tr>
      <td>${monthLabel(m.ym, !isPhone())}</td><td class="num">${(isPhone() ? money0 : money)(m.inc)}</td><td class="num">${(isPhone() ? money0 : money)(m.exp)}</td>
      <td class="num ${m.net >= 0 ? 'pos' : 'neg'}">${isPhone() ? (m.net >= 0 ? '+' : '') + money0(m.net) : signed(m.net)}</td><td class="col-hide-sm">${netBar(m.net)}</td>
      <td class="num">${m.rate == null || m.rate < -1 ? '—' : pct(m.rate)}</td></tr>`).join('')}</tbody>
    ${months.length > 1 ? `<tfoot><tr><td>Average</td><td class="num">${money0(avg('inc'))}</td><td class="num">${money0(avg('exp'))}</td>
      <td class="num ${avg('net') >= 0 ? 'pos' : 'neg'}">${(avg('net') >= 0 ? '+' : '') + money0(avg('net'))}</td><td class="col-hide-sm"></td>
      <td class="num">${avg('inc') > 0 ? pct(avg('net') / avg('inc')) : '—'}</td></tr></tfoot>` : ''}`;

  renderPlan(c);
}

// Income sources on the left, where it went on the right. Both sides add up to
// the same height, so what was kept (or drawn down) is its own band.
function renderSankey(c) {
  const el = $('sankey');
  const { income, expense, net } = c.cur;
  $('sankey-meta').textContent = `${money0(income)} in · ${money0(expense)} out`;
  if (income <= 0 && expense <= 0) { el.innerHTML = empty('No income or spending in this period.'); return; }

  const fold = (list, n, label) => {
    if (list.length <= n) return list.map(x => ({ ...x }));
    const rest = list.slice(n - 1);
    return [...list.slice(0, n - 1).map(x => ({ ...x })), { name: label, total: rest.reduce((s, x) => s + x.total, 0), folded: true }];
  };
  const left = fold(I.totalsBy(c.ops, 'merchant', 1), 5, 'Other income').map(x => ({ ...x, color: C.in, tip: 'Income' }));
  const right = fold(I.totalsBy(c.ops, 'category'), 9, 'Everything else').map(x => ({ ...x, color: C.out, tip: 'Spending', cat: x.folded ? null : x.name }));
  if (net < 0) left.push({ name: 'Drawn from balance', total: -net, color: C.other, tip: 'Shortfall' });
  if (net > 0) right.push({ name: 'Kept', total: net, color: C.kept, tip: 'Not spent' });

  const total = Math.max(income, expense);
  const W = Math.max(300, el.clientWidth), narrow = W < 560;
  const gap = 14, nodeW = 4, rows = Math.max(left.length, right.length);
  const H = Math.max(280, rows * 34);
  const scale = (H - gap * (rows - 1)) / total;
  const place = (nodes, x) => {
    let y = (H - (total * scale + gap * (nodes.length - 1))) / 2;
    for (const n of nodes) { n.x = x; n.y = y; n.h = Math.max(1.5, n.total * scale); y += n.h + gap; }
  };
  place(left, 0); place(right, W - nodeW);
  const mid = { x: W / 2 - nodeW / 2, y: (H - total * scale) / 2, h: total * scale };

  let defs = '', gid = 0;
  const ribbon = (x0, y0, x1, y1, h, color, tip, fromLeft) => {
    const mx = (x0 + x1) / 2, id = `skg${gid++}`;
    // Brightest at the named end, fading toward the middle bar.
    defs += `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x0}" x2="${x1}" y1="0" y2="0"><stop offset="0" stop-color="${color}" stop-opacity="${fromLeft ? 0.6 : 0.16}"/><stop offset="1" stop-color="${color}" stop-opacity="${fromLeft ? 0.16 : 0.6}"/></linearGradient>`;
    color = `url(#${id})`;
    return `<path class="flow" d="M${x0},${y0}C${mx},${y0} ${mx},${y1} ${x1},${y1}L${x1},${y1 + h}C${mx},${y1 + h} ${mx},${y0 + h} ${x0},${y0 + h}Z" fill="${color}" data-tip="${esc(tip)}"/>`;
  };
  let svg = '', yl = mid.y, yr = mid.y;
  const label = n => `${n.name}|${money(n.total)} · ${pct(n.total / total, 1)} of ${money0(total)}`;
  for (const n of left) { svg += ribbon(nodeW, n.y, mid.x, yl, n.h, n.color, label(n), true); yl += n.total * scale; }
  for (const n of right) { svg += ribbon(mid.x + nodeW, yr, n.x, n.y, n.h, n.color, label(n), false); yr += n.total * scale; }
  const max = narrow ? 14 : 26;
  for (const n of left) {
    svg += `<rect x="0" y="${n.y}" width="${nodeW}" height="${n.h}" fill="${n.color}"/>
      <text class="sk-label" x="${nodeW + 8}" y="${n.y + n.h / 2}" dy="0.35em">${esc(clip(n.name, max))} <tspan class="sk-val">${moneyK(n.total)}</tspan></text>`;
  }
  for (const n of right) {
    svg += `<rect x="${n.x}" y="${n.y}" width="${nodeW}" height="${n.h}" fill="${n.color}"/>
      <text class="sk-label${n.cat ? ' link' : ''}" ${n.cat ? `data-txn-cat="${esc(n.cat)}"` : ''} x="${n.x - 8}" y="${n.y + n.h / 2}" dy="0.35em" text-anchor="end">${esc(clip(n.name, max))} <tspan class="sk-val">${moneyK(n.total)} · ${pct(n.total / total)}</tspan></text>`;
  }
  svg += `<rect x="${mid.x}" y="${mid.y}" width="${nodeW}" height="${mid.h}" fill="${C.ink}"/>`;
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Income sources flowing into spending categories"><defs>${defs}</defs>${svg}</svg>`;
}

// Average month: what each category takes out of a month's income.
function renderPlan(c) {
  const months = c.days / 30.44;
  const actualMonthly = c.cur.income / months;
  const monthlyIncome = cpIncomeOverride != null ? cpIncomeOverride : actualMonthly;
  if (cpIncomeOverride == null) { $('cp-income').value = ''; $('cp-income').placeholder = fmt0(actualMonthly); }

  const periodStr = c.days < 32 ? `${c.days} days` : `${months.toFixed(1)} months`;
  $('cp-period-note').textContent = `Averages over ${periodStr}` +
    (cpIncomeOverride != null ? ' · income set by hand' : ' · income from data') +
    (cpExcluded.size ? ` · ${cpExcluded.size} categor${cpExcluded.size > 1 ? 'ies' : 'y'} left out` : '') +
    ' · tick a category off to see the month without it';

  const all = I.totalsBy(c.ops, 'category').map(x => ({ name: x.name, avg: x.total / months }));
  const active = all.filter(x => !cpExcluded.has(x.name));
  const totalSpend = active.reduce((s, x) => s + x.avg, 0);
  const remaining = monthlyIncome - totalSpend;
  const scaleMax = Math.max(monthlyIncome, totalSpend, 1);

  $('cp-meter').innerHTML = `
    <div class="seg-bar" role="img" aria-label="Spending against income">
      <i class="out" style="width:${(totalSpend / scaleMax * 100).toFixed(2)}%" data-tip="Spending|${money(totalSpend)}/mo"></i>
      ${remaining > 0 ? `<i class="kept" style="width:${(remaining / scaleMax * 100).toFixed(2)}%" data-tip="Remaining|${money(remaining)}/mo"></i>` : ''}
    </div>
    <div class="legend"><span><i style="background:${C.out}"></i>Spending ${money0(totalSpend)}/mo</span>
      ${remaining > 0 ? `<span><i style="background:${C.kept}"></i>Remaining ${money0(remaining)}/mo</span>` : `<span class="neg">Over income by ${money0(-remaining)}/mo</span>`}</div>`;

  $('cp-list').innerHTML = all.map(x => {
    const excl = cpExcluded.has(x.name);
    const p = monthlyIncome > 0 ? Math.min(x.avg / monthlyIncome * 100, 100) : 0;
    return `<label class="cp-row${excl ? ' off' : ''}">
      <input type="checkbox" class="cp-toggle" data-cat="${esc(x.name)}" ${excl ? '' : 'checked'} />
      <span class="cp-name">${esc(x.name)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${p.toFixed(1)}%"></span></span>
      <span class="amt">${money(x.avg)}<small>/mo</small></span>
      <span class="cp-pct">${monthlyIncome > 0 ? pct(x.avg / monthlyIncome, 1) : ''}</span>
    </label>`;
  }).join('');

  $('cp-summary').innerHTML = `
    <div class="sum-row"><span>Monthly income</span><span class="amt">${money(monthlyIncome)}</span></div>
    <div class="sum-row"><span>Spending counted</span><span class="amt">−$${fmt(totalSpend)}</span></div>
    <div class="sum-row total"><span>Remaining</span><span class="amt ${remaining >= 0 ? 'pos' : 'neg'}">${signed(remaining)}/mo</span></div>`;
}

$('cp-list').addEventListener('change', ev => {
  const box = ev.target.closest('.cp-toggle');
  if (!box) return;
  if (box.checked) cpExcluded.delete(box.dataset.cat); else cpExcluded.add(box.dataset.cat);
  renderPlan(CTX);
});
$('cp-income').addEventListener('input', () => {
  const v = parseFloat($('cp-income').value);
  cpIncomeOverride = (!isNaN(v) && v > 0) ? v : null;
  renderPlan(CTX);
});
$('cp-income-reset').addEventListener('click', () => { cpIncomeOverride = null; $('cp-income').value = ''; renderPlan(CTX); });

// ── Spending ──────────────────────────────────────────────────────────────────
function renderSpending(c) {
  const cats = I.totalsBy(c.ops, 'category');
  const before = new Map(I.totalsBy(c.priorOps, 'category').map(x => [x.name, x.total]));
  const total = c.cur.expense, max = cats[0]?.total || 1;
  $('sp-cat-meta').textContent = `${money0(total)} across ${cats.length} categories`;
  $('sp-cats').innerHTML = cats.length ? `<thead><tr><th>Category</th><th class="col-bar"></th><th class="num">Amount</th><th class="num">Share</th>${c.hasPrior ? '<th class="num col-hide-sm">vs prior</th>' : ''}<th class="num col-hide-sm">Txns</th></tr></thead>
    <tbody>${cats.map(x => {
      const d = c.hasPrior ? relDelta(x.total, before.get(x.name), false) : null;
      return `<tr class="link" data-txn-cat="${esc(x.name)}">
        <td><span class="swatch" style="background:${CAT_SLOT[x.name] || C.other}"></span>${esc(x.name)}</td>
        <td class="col-bar"><div class="bar-track"><div class="bar-fill" style="width:${(x.total / max * 100).toFixed(1)}%"></div></div></td>
        <td class="num">${money(x.total)}</td><td class="num dim">${pct(x.total / total, 1)}</td>
        ${c.hasPrior ? `<td class="num col-hide-sm">${deltaHtml(d) || '<span class="dim">new</span>'}</td>` : ''}
        <td class="num dim col-hide-sm">${x.count}</td></tr>`;
    }).join('')}</tbody>` : `<tbody><tr><td class="empty">No spending in this period.</td></tr></tbody>`;

  // Stacked by month. The six largest categories of all time keep their colour
  // whatever the period; the rest fold into one grey band.
  const yms = [...new Set(c.ops.filter(t => I.spent(t)).map(t => t.date_iso.slice(0, 7)))].sort();
  const named = Object.keys(CAT_SLOT);
  const grid = Object.fromEntries([...named, 'Other categories'].map(k => [k, yms.map(() => 0)]));
  for (const t of c.ops) {
    const v = I.spent(t);
    if (v) grid[CAT_SLOT[t.category] ? t.category : 'Other categories'][yms.indexOf(t.date_iso.slice(0, 7))] += v;
  }
  for (const v of Object.values(grid)) v.forEach((x, i) => { if (x < 0) v[i] = 0; }); // a month refunded below zero
  const series = Object.entries(grid).filter(([, v]) => v.some(x => x > 0));
  $('trend-legend').innerHTML = series.map(([k]) => `<span><i style="background:${CAT_SLOT[k] || C.other}"></i>${esc(k)}</span>`).join('');
  chart('trend-chart', {
    type: 'bar',
    data: { labels: yms.map(m => monthLabel(m)), datasets: series.map(([k, v]) => ({
      label: k, data: v.map(A.round2), backgroundColor: CAT_SLOT[k] || C.other, borderColor: C.surface, borderWidth: { top: 2 }, maxBarThickness: 28 })) },
    options: { ...hoverLine,
      plugins: { legend: { display: false }, tooltip: { itemSort: (a, b2) => b2.datasetIndex - a.datasetIndex, filter: x => x.parsed.y > 0,
        callbacks: { label: x => ` ${x.dataset.label}  ${money(x.parsed.y)}`, footer: items => `Total  ${money(items.reduce((s, x) => s + x.parsed.y, 0))}` } } },
      scales: { x: { ...xPlain(), stacked: true }, y: { ...yMoney, stacked: true } } },
  });

  renderHeatmap(c);

  const merch = I.totalsBy(c.ops, 'merchant').slice(0, 10);
  $('merchant-list').innerHTML = merch.length ? merch.map(x => `
    <div class="bar-row link" data-txn-search="${esc(x.name)}">
      <div class="bar-top"><span class="bar-name">${esc(x.name)}</span><span class="bar-share">${x.count}×</span><span class="bar-amt">${money(x.total)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${(x.total / merch[0].total * 100).toFixed(1)}%"></div></div>
    </div>`).join('') : empty('No spending in this period.');

  // Average spend on each weekday: total for that weekday over how many of them
  // the period holds.
  const sums = new Array(7).fill(0), counts = new Array(7).fill(0);
  for (let t = A.localTs(isoLocal(c.s)); t <= c.e; t += DAY) counts[new Date(t + DAY / 2).getDay()]++;
  for (const t of c.ops) sums[new Date(t.ts).getDay()] += I.spent(t);
  const avgs = sums.map((v, i) => (counts[i] ? Math.max(0, v) / counts[i] : 0)), top = Math.max(...avgs, 1);
  $('dow').innerHTML = `<div class="dow">${[1, 2, 3, 4, 5, 6, 0].map(i => `
    <div class="dow-col" data-tip="${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]}|${money(avgs[i])} on average">
      <span class="dow-val">${moneyK(avgs[i])}</span>
      <div class="dow-bar"><i style="height:${(avgs[i] / top * 100).toFixed(1)}%"></i></div>
      <span class="dow-name">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]}</span>
    </div>`).join('')}</div>`;
}

// One square per day, a column per week, darker blue for a quiet day and
// lighter for a heavy one. Shows at most the last year of the period; a short
// period is given the weeks before it as context, so the grid stays wide.
function renderHeatmap(c) {
  const el = $('heatmap');
  const daily = I.dailySpend(c.allOps);
  const end = A.localTs(isoLocal(Math.min(c.e, DATA_MAX)));
  const from = Math.max(A.localTs(isoLocal(c.s)), addDays(end, -370));  // first day of the period shown
  const start = Math.max(A.localTs(isoLocal(DATA_MIN)), Math.min(from, addDays(end, -182)));
  for (const k of [...daily.keys()]) { const ts = A.localTs(k); if (ts < start || ts > end) daily.delete(k); }
  const vals = [...daily.values()].filter(v => v > 0).sort((a, b) => a - b);
  if (!vals.length) { el.innerHTML = empty('No spending in this period.'); $('heat-meta').textContent = ''; return; }
  const q = f => vals[Math.min(vals.length - 1, Math.floor(vals.length * f))];
  const cuts = [q(0.25), q(0.5), q(0.8)];
  const level = v => (v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : 3);

  const first = new Date(start), padL = 30, padT = 18;
  const gridStart = new Date(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay());
  const nWeeks = Math.ceil((end - gridStart.getTime() + DAY) / (7 * DAY));
  const step = Math.max(16, Math.min(30, Math.floor((el.clientWidth - padL) / nWeeks))), cell = step - 3;
  let rects = '', labels = '', lastMonth = -1, lastLabelX = -99, weeks = 0, peak = { v: 0, iso: '' }, n = 0, spendDays = 0;
  for (let d = new Date(gridStart), i = 0; d.getTime() <= end; d.setDate(d.getDate() + 1), i++) {
    const w = Math.floor(i / 7), dow = i % 7, ts = d.getTime();
    weeks = w + 1;
    if (ts < start) continue;
    const iso = isoLocal(ts), v = daily.get(iso) || 0, x = padL + w * step;
    const inPeriod = ts >= from;
    if (inPeriod) { n++; if (v > 0) spendDays++; if (v > peak.v) peak = { v, iso }; }
    if (d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      if (x - lastLabelX > 28) { labels += `<text class="hm-label" x="${x}" y="11">${MONTH_ABBR[lastMonth]}</text>`; lastLabelX = x; }
    }
    // Days before the period are drawn small, so they read as context, not as low values.
    const sz = inPeriod ? cell : Math.round(cell * 0.4), off = (cell - sz) / 2;
    rects += `<rect x="${x + off}" y="${padT + dow * step + off}" width="${sz}" height="${sz}" ${inPeriod ? '' : ' class="out"'} fill="${v > 0 ? HEAT[level(v)] : ZERO}" data-tip="${A.fmtDate(iso)}|${v > 0 ? money(v) : 'No spending'}"/>`;
  }
  ['Mon', 'Wed', 'Fri'].forEach((nme, k) => { labels += `<text class="hm-label" x="0" y="${padT + (1 + k * 2) * step + 10}">${nme}</text>`; });
  $('heat-meta').textContent = `${n - spendDays} no-spend days` + (peak.v ? ` · peak ${money0(peak.v)} on ${A.fmtDate(peak.iso)}` : '') + (start < from ? ' · earlier weeks shown small' : '');
  el.innerHTML = `<div class="hm-scroll"><svg width="${padL + weeks * step}" height="${padT + 7 * step}" role="img" aria-label="Spending per day">${labels}${rects}</svg></div>
    <div class="legend hm-legend"><span>Less</span><i style="background:${ZERO}"></i>${HEAT.map(h => `<i style="background:${h}"></i>`).join('')}<span>More</span></div>`;
  const sc = el.querySelector('.hm-scroll'); sc.scrollLeft = sc.scrollWidth;
}
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Budgets ───────────────────────────────────────────────────────────────────
function renderBudgets(c) {
  const budgets = state.settings.budgets || {};
  const rows = I.budgetRows(c.allOps, budMonth, budgets);
  const progress = monthProgress(budMonth);
  const set = rows.filter(r => r.budget > 0);
  const budgeted = set.reduce((s, r) => s + r.budget, 0), spent = set.reduce((s, r) => s + r.spent, 0);
  const unbudgeted = rows.filter(r => !r.budget).reduce((s, r) => s + r.spent, 0);
  const dim = new Date(+budMonth.slice(0, 4), +budMonth.slice(5, 7), 0).getDate();
  const daysLeft = Math.round(dim * (1 - progress));

  setKpis('bud-kpis', [
    kpiTile({ label: 'Budgeted', value: money0(budgeted), sub: `${set.length} categor${set.length === 1 ? 'y' : 'ies'}` }),
    kpiTile({ label: 'Spent of budget', value: money0(spent), sub: budgeted ? `${pct(spent / budgeted)} used` : '',
      spark: budgeted ? `<div class="meter" aria-hidden="true"><div class="${spent > budgeted ? 'over' : ''}" style="width:${Math.min(100, spent / budgeted * 100).toFixed(1)}%"></div></div>` : '' }),
    kpiTile({ label: budgeted - spent >= 0 ? 'Left to spend' : 'Over budget', value: money0(Math.abs(budgeted - spent)), tone: budgeted - spent >= 0 ? 'pos' : 'neg',
      sub: progress < 1 && daysLeft > 0 && budgeted > spent ? `${money0((budgeted - spent) / daysLeft)}/day for ${daysLeft} days` : progress < 1 ? `${daysLeft} days left` : 'month closed' }),
    kpiTile({ label: 'Outside budgets', value: money0(unbudgeted), sub: 'spent in categories with no limit' }),
  ]);

  $('bud-list').innerHTML = rows.length ? rows.map(r => {
    const ratio = r.budget ? r.spent / r.budget : 0, over = r.spent - r.budget;
    const st = !r.budget ? 'none' : ratio > 1 ? 'over' : ratio > 0.85 ? 'near' : 'ok';
    const status = st === 'none' ? `<span class="dim">avg ${money0(r.avg)}/mo</span>`
      : `<span class="tag ${st}">${st === 'over' ? `OVER ${money0(over)}` : `${money0(-over)} LEFT`}</span>`;
    return `<div class="bud-row${r.budget ? '' : ' unset'}">
      <div class="bud-name link" data-txn-cat="${esc(r.name)}">${esc(r.name)}</div>
      <div class="bud-bar">
        <div class="bar-track tall">${r.budget ? `<div class="bar-fill ${st}" style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></div>${progress < 1 ? `<i class="pace-tick" style="left:${(progress * 100).toFixed(1)}%" data-tip="Today|${pct(progress)} of the month gone"></i>` : ''}` : ''}</div>
        <div class="bud-nums"><span>${money(r.spent)} spent${r.budget ? ` · ${pct(ratio)}` : ''}</span>${status}</div>
      </div>
      <div class="input-affix bud-input"><span>$</span><input type="number" inputmode="decimal" min="0" step="10" data-budget="${esc(r.name)}" value="${r.budget || ''}" placeholder="${r.avg ? fmt0(Math.ceil(r.avg / 10) * 10) : 'limit'}" aria-label="Monthly budget for ${esc(r.name)}" /></div>
    </div>`;
  }).join('') : empty('No spending to budget yet.');
}

async function saveBudgets(next) {
  state.settings.budgets = next;
  await commit();
  renderActive();
}
$('bud-month').addEventListener('change', e => { budMonth = e.target.value; renderActive(); });
$('bud-list').addEventListener('change', ev => {
  const inp = ev.target.closest('[data-budget]');
  if (!inp) return;
  const v = parseFloat(inp.value), next = { ...(state.settings.budgets || {}) };
  if (v > 0) next[inp.dataset.budget] = A.round2(v); else delete next[inp.dataset.budget];
  saveBudgets(next);
});
$('bud-auto').addEventListener('click', () => {
  const avg = I.avgMonthlyByCat(CTX.allOps, budMonth);
  const next = { ...(state.settings.budgets || {}) };
  let n = 0;
  for (const [k, v] of Object.entries(avg)) if (!next[k] && v >= 5) { next[k] = Math.ceil(v / 10) * 10; n++; }
  if (!n) { toast('Every category with a spending history already has a budget.'); return; }
  saveBudgets(next);
  toast(`Set ${n} budget${n === 1 ? '' : 's'} from the three months before ${monthLabel(budMonth, true)}.`);
});
$('bud-clear').addEventListener('click', () => {
  if (!Object.keys(state.settings.budgets || {}).length) return;
  if (confirm('Remove every category budget?')) saveBudgets({});
});

// ── Recurring ─────────────────────────────────────────────────────────────────
function renderRecurring() {
  const live = SCHED.filter(x => x.active);
  const out = live.filter(x => x.s.direction === 'expense'), inc = live.filter(x => x.s.direction === 'income');
  const soon = upcoming(), due = soon.filter(x => x.s.direction === 'expense');
  setKpis('rec-kpis', [
    kpiTile({ label: 'Committed per month', value: money0(out.reduce((s, x) => s + x.monthly, 0)), sub: `${out.length} active charges` }),
    kpiTile({ label: 'Recurring income', value: money0(inc.reduce((s, x) => s + x.monthly, 0)), tone: 'pos', sub: `${inc.length} source${inc.length === 1 ? '' : 's'} per month` }),
    kpiTile({ label: 'Due in 30 days', value: money0(due.reduce((s, x) => s + x.s.avg_amount, 0)), sub: `${due.length} charge${due.length === 1 ? '' : 's'} expected` }),
    kpiTile({ label: 'Streams', value: `${live.length}<small> / ${SCHED.length}</small>`, sub: 'active / detected' }),
  ]);

  $('streams-list').innerHTML = SCHED.length ? `<thead><tr><th>Merchant</th><th class="col-hide-sm">Category</th><th>Cadence</th><th class="num">Typical</th><th class="num col-hide-sm">Per month</th><th>Next</th></tr></thead>
    <tbody>${[...SCHED].sort((a, b) => b.active - a.active || b.monthly - a.monthly).map(x => {
      const isInc = x.s.direction === 'income';
      return `<tr class="link${x.active ? '' : ' lapsed'}" data-stream="${x.idx}">
        <td><span class="dir ${isInc ? 'in' : 'out'}" title="${isInc ? 'Income' : 'Expense'}">${isInc ? '↓' : '↑'}</span>${esc(x.s.merchant)}</td>
        <td class="col-hide-sm dim">${esc(x.s.category)}</td>
        <td><span class="tag">${x.s.frequency}</span></td>
        <td class="num ${isInc ? 'pos' : ''}">${isInc ? '+' : ''}${money(x.s.avg_amount)}</td>
        <td class="num col-hide-sm dim">${money(x.monthly)}</td>
        <td>${x.active ? shortDate(x.next) : `<span class="tag" title="Last seen ${shortDate(x.last)}">LAPSED</span>`}</td></tr>`;
    }).join('')}</tbody>` : `<tbody><tr><td class="empty">No recurring streams detected yet. They appear once a merchant shows up at least three times at regular intervals.</td></tr></tbody>`;

  $('rec-upcoming-meta').textContent = soon.length ? `after ${shortDate(DATA_MAX)}` : '';
  $('rec-upcoming').innerHTML = soon.length ? soon.map(upcomingRow).join('') : empty('Nothing expected in the next 30 days.');
}

const streamOverlay = $('stream-overlay');
document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-stream]');
  if (el) openStreamModal(STREAMS[parseInt(el.dataset.stream, 10)]);
});

function openStreamModal(s) {
  if (!s) return;
  $('stream-modal-title').textContent = s.merchant;
  $('stream-modal-meta').textContent = `${s.category} · ${s.frequency} · ${s.occurrences} occurrences`;
  const txns = s.transactions || [];
  const color = s.direction === 'income' ? C.in : C.out;
  streamOverlay.classList.add('open');
  chart('stream-chart', {
    type: 'line',
    data: { labels: txns.map(t => t.date), datasets: [{
      label: s.merchant, data: txns.map(t => Math.abs(t.amount)), borderColor: color, backgroundColor: color, borderWidth: 2,
      pointRadius: 3, pointHoverRadius: 5, tension: 0 }] },
    options: { ...hoverLine,
      plugins: { legend: { display: false }, crosshair: { on: true }, tooltip: { callbacks: { label: x => ` ${money(x.parsed.y)}` } } },
      scales: { x: xPlain({ maxTicksLimit: 6 }), y: { ...yMoney, ticks: { ...yMoney.ticks, callback: v => money0(v), maxTicksLimit: 5 } } } },
  });
  $('stream-timeline').innerHTML = [...txns].reverse().map(t =>
    `<div class="tl-row"><span>${t.date}</span><span class="amt ${t.amount >= 0 ? 'pos' : ''}">${signed(t.amount)}</span></div>`).join('');
  const total = txns.reduce((sum, t) => sum + t.amount, 0);
  $('stream-total-label').textContent = `Total across ${txns.length} transactions`;
  $('stream-total-val').textContent = signed(total);
  $('stream-total-val').className = 'mono ' + (total >= 0 ? 'pos' : 'neg');
}
$('stream-modal-close').addEventListener('click', () => streamOverlay.classList.remove('open'));
streamOverlay.addEventListener('click', ev => { if (ev.target === streamOverlay) streamOverlay.classList.remove('open'); });

// ── Transactions ──────────────────────────────────────────────────────────────
function renderTransactions(c) {
  const inData = new Set(c.txns.map(t => t.category));
  const cats = [...new Set([...ALL_CATS, ...TRANSFER_CATS, ...inData])].filter(x => inData.has(x) || x === activeCat);
  $('txn-cat-select').innerHTML = `<option value="all">All categories</option>` +
    cats.sort().map(x => `<option value="${esc(x)}"${x === activeCat ? ' selected' : ''}>${esc(x)}</option>`).join('');
  renderTable();
}

function renderTable() {
  const txns = CTX.txns;
  const searchRaw = $('txn-search').value.trim();
  const amtOp = $('txn-amt-op').value;
  const amtNum = parseFloat($('txn-amt-val').value);

  let regex = null;
  const searchEl = $('txn-search');
  searchEl.classList.remove('invalid');
  if (searchRaw) {
    try { regex = new RegExp(searchRaw, 'i'); } catch { searchEl.classList.add('invalid'); }
  }

  const visible = txns.filter(t => {
    if (!showTransfers && t.is_transfer && activeCat !== t.category) return false;
    if (activeCat !== 'all' && t.category !== activeCat) return false;
    if (regex && !regex.test(t.description)) return false;
    if (txnDir === 'income' && t.amount <= 0) return false;
    if (txnDir === 'expense' && t.amount >= 0) return false;
    if (amtOp && !isNaN(amtNum)) {
      const v = Math.abs(t.amount);
      if (amtOp === 'lt' && !(v < amtNum)) return false;
      if (amtOp === 'lte' && !(v <= amtNum)) return false;
      if (amtOp === 'eq' && !(Math.abs(v - amtNum) < 0.005)) return false;
      if (amtOp === 'gte' && !(v >= amtNum)) return false;
      if (amtOp === 'gt' && !(v > amtNum)) return false;
    }
    return true;
  });

  // The list arrives newest first; only re-sort when another column is chosen.
  const { key, dir } = txnSort;
  if (key !== 'date' || dir !== -1) {
    const val = key === 'date' ? t => t.ts : key === 'amount' ? t => t.amount : t => String(t[key]).toLowerCase();
    visible.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  }
  visibleTxns = visible;

  document.querySelectorAll('.txn-table th[data-sort]').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === key);
    th.dataset.dir = th.dataset.sort === key ? (dir > 0 ? '▲' : '▼') : '';
  });
  const inSum = visible.reduce((s, t) => s + (t.amount > 0 ? t.amount : 0), 0), outSum = visible.reduce((s, t) => s + (t.amount < 0 ? -t.amount : 0), 0);
  $('txn-count').textContent = `${visible.length.toLocaleString()} rows · in ${money0(inSum)} · out ${money0(outSum)}`;
  $('txn-reset').hidden = !(searchRaw || activeCat !== 'all' || txnDir || amtOp || showTransfers);

  const tbody = $('txn-tbody');
  const more = $('txn-more');
  if (!visible.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No transactions match the current filter.</td></tr>';
    more.hidden = true;
    return;
  }
  // Thousands of rows is slow to lay out on a phone; page them in.
  tbody.innerHTML = visible.slice(0, txnLimit).map((t, i) => {
    const tag = `<button class="txn-cat tag${t.is_transfer ? ' xfr' : ''}" data-merchant="${esc(t.merchant)}" data-cat="${esc(t.category)}" data-amount="${Math.abs(t.amount)}" title="Change category">${esc(t.category)}</button>`;
    return `
    <tr class="link${t.is_transfer ? ' xfr-row' : ''}" data-row="${i}">
      <td class="txn-date">${t.date_fmt.slice(0, 6)}<span class="yr">${t.date_fmt.slice(6)}</span></td>
      <td class="txn-desc"><span class="txn-merchant">${esc(t.merchant || t.description)}</span>${t.merchant && t.merchant.toLowerCase() !== t.description.toLowerCase() ? `<small>${esc(t.description)}</small>` : ''}<span class="cat-inline">${tag}</span></td>
      <td class="col-cat">${tag}</td>
      <td class="col-acct dim">${esc(t.account)}</td>
      <td class="num ${t.amount >= 0 ? 'pos' : ''}">${signed(t.amount)}</td>
    </tr>`; }).join('');
  if (visible.length > txnLimit) {
    more.hidden = false;
    more.innerHTML = `<button class="btn small" id="txn-more-btn">Show more (${(visible.length - txnLimit).toLocaleString()} left)</button>`;
  } else {
    more.hidden = true;
  }
}

$('txn-more').addEventListener('click', ev => {
  if (!ev.target.closest('#txn-more-btn')) return;
  txnLimit += 500;
  renderTable();
});
document.querySelector('.txn-table thead').addEventListener('click', ev => {
  const th = ev.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  txnSort = txnSort.key === key ? { key, dir: -txnSort.dir } : { key, dir: key === 'date' || key === 'amount' ? -1 : 1 };
  renderTable();
});
$('txn-cat-select').addEventListener('change', e => { activeCat = e.target.value; txnLimit = 200; renderTable(); });
$('show-xfr').addEventListener('change', e => { showTransfers = e.target.checked; renderTable(); });
$('txn-search').addEventListener('input', () => renderTable());
$('txn-amt-op').addEventListener('change', () => renderTable());
$('txn-amt-val').addEventListener('input', () => renderTable());
document.querySelectorAll('.txn-dir-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.txn-dir-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    txnDir = btn.dataset.dir;
    renderTable();
  });
});
$('txn-reset').addEventListener('click', () => {
  showTransfers = false; $('show-xfr').checked = false;
  goTxns();
});

$('txn-export').addEventListener('click', () => {
  if (!visibleTxns.length) { toast('Nothing to export with the current filter.'); return; }
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const lines = [['Date', 'Description', 'Merchant', 'Category', 'Account', 'Amount', 'Transfer'].join(',')]
    .concat(visibleTxns.map(t => [t.date_iso, t.description, t.merchant, t.category, t.account, t.amount.toFixed(2), t.is_transfer ? 'yes' : 'no'].map(q).join(',')));
  download(new Blob([lines.join('\n')], { type: 'text/csv' }), `financetracker-transactions-${isoLocal(Date.now())}.csv`);
});

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Transaction detail ───────────────────────────────────────────────────────
const drawerOverlay = $('drawer-overlay');
function openDrawer(t) {
  const same = ALL_TXN.filter(x => x.merchant === t.merchant && !x.is_transfer === !t.is_transfer);
  const total = same.reduce((s, x) => s + x.amount, 0);
  $('drawer-body').innerHTML = `
    <div class="dr-hero">
      <div class="dr-amt ${t.amount >= 0 ? 'pos' : ''}">${signed(t.amount)}</div>
      <div class="dr-merchant">${esc(t.merchant || t.description)}</div>
      <div class="dim">${t.date_fmt} · ${esc(t.account)}</div>
    </div>
    <dl class="dr-fields">
      <dt>Category</dt><dd><button class="txn-cat tag${t.is_transfer ? ' xfr' : ''}" data-merchant="${esc(t.merchant)}" data-cat="${esc(t.category)}" data-amount="${Math.abs(t.amount)}">${esc(t.category)}</button> <span class="dim">tap to change</span></dd>
      <dt>Statement text</dt><dd class="mono wrap">${esc(t.description)}</dd>
      ${t.balance != null ? `<dt>Balance after</dt><dd class="mono">${money(t.balance)}</dd>` : ''}
      ${t.is_transfer ? '<dt>Counted</dt><dd>Transfer between your own accounts, left out of income and spending.</dd>' : ''}
      ${t.refund ? `<dt>Counted</dt><dd>Refund: taken off ${esc(t.category)} spending, not counted as income.</dd>` : ''}
    </dl>
    <div class="dr-section">
      <div class="dr-section-head"><span>${esc(t.merchant)} · all time</span><span class="mono">${same.length}× · ${signed(total)}</span></div>
      ${same.slice(0, 8).map(x => `<div class="tl-row${x.id === t.id ? ' current' : ''}"><span>${x.date_fmt}</span><span class="amt ${x.amount >= 0 ? 'pos' : ''}">${signed(x.amount)}</span></div>`).join('')}
      ${same.length > 1 ? `<button class="btn block" data-txn-search="${esc(t.merchant)}" style="margin-top:.75rem">Show all ${same.length} in the ledger</button>` : ''}
    </div>`;
  drawerOverlay.classList.add('open');
}
function closeDrawer() { drawerOverlay.classList.remove('open'); }
$('drawer-close').addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', ev => { if (ev.target === drawerOverlay || ev.target.closest('[data-txn-search]')) closeDrawer(); });
$('txn-tbody').addEventListener('click', ev => {
  if (ev.target.closest('.txn-cat')) return;
  const tr = ev.target.closest('tr[data-row]');
  if (tr) openDrawer(visibleTxns[Number(tr.dataset.row)]);
});

// ── Date range ───────────────────────────────────────────────────────────────
function presetRange(key) {
  if (key === 'ytd') return [Math.max(DATA_MIN, new Date(new Date(DATA_MAX).getFullYear(), 0, 1).getTime()), DATA_MAX];
  const days = parseInt(key, 10);
  return [days === 0 ? DATA_MIN : Math.max(DATA_MIN, addDays(DATA_LAST, 1 - days)), DATA_MAX];
}
function setDateInputs(startMs, endMs) {
  $('date-start').value = isoLocal(startMs);
  $('date-end').value = isoLocal(endMs);
  updateRangeDisp(startMs, endMs);
}
function updateRangeDisp(startMs, endMs) {
  $('range-disp').textContent = `${Math.round((endMs - startMs) / DAY)} days`;
}
function getInputMs() {
  const sv = $('date-start').value, ev = $('date-end').value;
  if (!sv || !ev) return [NaN, NaN];
  return [A.localTs(sv), dayEnd(A.localTs(ev))];
}
function applyPreset(key) {
  rangePreset = key;
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.days === key));
  const [s, e] = presetRange(key);
  setDateInputs(s, e);
  recompute(s, e);
}
document.querySelectorAll('.preset-btn').forEach(btn => btn.addEventListener('click', () => applyPreset(btn.dataset.days)));

['date-start', 'date-end'].forEach(id => {
  $(id).addEventListener('change', () => {
    const [s, e] = getInputMs();
    if (isNaN(s) || isNaN(e) || s > e) return;
    rangePreset = 'custom';
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    updateRangeDisp(s, e);
    recompute(s, e);
  });
});

// ── Status bar ───────────────────────────────────────────────────────────────
const clockText = () => new Date().toISOString().slice(0, 19).replace('T', ' ') + 'Z';
setInterval(() => { const el = $('clock'); if (el && !document.hidden) el.textContent = clockText(); }, 1000);
function renderStatus() {
  if (!ALL_TXN.length) return;
  const accts = new Set(ALL_TXN.map(t => t.account)).size;
  const age = dataAge(DATA_LAST);
  $('asof').textContent = `Data as of ${shortDate(DATA_LAST)}` + (age >= 4 && !demo ? ` · ${age}d old` : '');
  $('asof').className = 'asof' + (demo ? '' : age >= 21 ? ' old' : age >= 7 ? ' stale' : '');
  const syncCls = $('sync-dot').className.replace('sync-dot', '').trim();
  const syncTxt = demo ? 'DEMO' : !state.sync ? 'SYNC OFF' : syncCls === 'err' ? 'SYNC FAILED' : syncCls === 'busy' ? 'SYNCING' : 'SYNC ON';
  $('statusbar').innerHTML = `
    <span><i class="dot ok"></i>ON-DEVICE</span>
    <span>${ALL_TXN.length.toLocaleString()} TXNS</span>
    <span>${accts} ACCOUNT${accts === 1 ? '' : 'S'}</span>
    <span>DATA ${A.fmtDate(isoLocal(DATA_MIN)).toUpperCase()} → ${A.fmtDate(isoLocal(DATA_MAX)).toUpperCase()}</span>
    <span><i class="dot ${demo || !state.sync ? '' : syncCls || 'ok'}"></i>${syncTxt}</span>
    <span class="spacer"></span>
    <span class="clock" id="clock">${clockText()}</span>
    <span>${BUILD.startsWith('__') ? 'DEV BUILD' : 'BUILD ' + esc(BUILD.split('-')[0])}</span>`;
}

// ── Command palette ──────────────────────────────────────────────────────────
const cmdOverlay = $('cmd-overlay');
let cmdItems = [], cmdShown = [], cmdSel = 0;
$('cmd-kbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

function openCmd() {
  if ($('dashboard').hidden) return;
  cmdItems = [
    ...Object.entries(VIEWS).map(([k, label]) => ({ kind: 'View', label, run: () => setView(k) })),
    ...[['30', 'Last month'], ['90', 'Last 3 months'], ['180', 'Last 6 months'], ['ytd', 'Year to date'], ['365', 'Last year'], ['0', 'All time']]
      .map(([k, label]) => ({ kind: 'Period', label, run: () => applyPreset(k) })),
    { kind: 'Action', label: 'Refresh data (add CSV files)', run: openRefresh },
    ...(watch.current() ? [{ kind: 'Action', label: `Check ${watch.current().name} for new exports`, run: () => watchScan({ ask: true, loud: true }) }] : []),
    { kind: 'Action', label: 'Export visible transactions as CSV', run: () => { setView('transactions'); $('txn-export').click(); } },
    { kind: 'Action', label: 'Download backup', run: () => $('export-backup').click() },
    { kind: 'Action', label: 'Open settings', run: openSettings },
    ...(state.sync && !demo ? [{ kind: 'Action', label: 'Sync now', run: () => syncNow() }] : []),
    ...(demo ? [{ kind: 'Action', label: 'Exit demo', run: exitDemo }] : []),
    ...[...new Set(ALL_TXN.map(t => t.category))].sort().map(x => ({ kind: 'Category', label: x, run: () => goTxns({ cat: x }) })),
    ...I.totalsBy(ALL_TXN, 'merchant').slice(0, 300).map(m => ({ kind: 'Merchant', label: m.name, hint: money0(m.total), run: () => goTxns({ search: m.name }) })),
  ];
  $('cmd-input').value = '';
  cmdSel = 0;
  renderCmd();
  cmdOverlay.classList.add('open');
  setTimeout(() => $('cmd-input').focus(), 20);
}
function closeCmd() { cmdOverlay.classList.remove('open'); }
function renderCmd() {
  const q = $('cmd-input').value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  cmdShown = cmdItems.filter(it => words.every(w => (it.kind + ' ' + it.label).toLowerCase().includes(w))).slice(0, q ? 40 : 14);
  cmdSel = Math.min(cmdSel, Math.max(0, cmdShown.length - 1));
  $('cmd-list').innerHTML = cmdShown.length ? cmdShown.map((it, i) =>
    `<div class="cmd-item${i === cmdSel ? ' sel' : ''}" data-i="${i}" role="option"><span class="tag">${it.kind}</span><span class="cmd-label">${esc(it.label)}</span><span class="dim mono">${it.hint || ''}</span></div>`).join('')
    : empty('No matches.');
  $('cmd-list').querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function runCmd(i) { const it = cmdShown[i]; if (!it) return; closeCmd(); it.run(); }
$('cmd-open').addEventListener('click', openCmd);
$('cmd-input').addEventListener('input', () => { cmdSel = 0; renderCmd(); });
$('cmd-input').addEventListener('keydown', ev => {
  if (ev.key === 'ArrowDown') { cmdSel = Math.min(cmdSel + 1, cmdShown.length - 1); renderCmd(); ev.preventDefault(); }
  else if (ev.key === 'ArrowUp') { cmdSel = Math.max(cmdSel - 1, 0); renderCmd(); ev.preventDefault(); }
  else if (ev.key === 'Enter') runCmd(cmdSel);
});
$('cmd-list').addEventListener('click', ev => { const el = ev.target.closest('.cmd-item'); if (el) runCmd(Number(el.dataset.i)); });
cmdOverlay.addEventListener('click', ev => { if (ev.target === cmdOverlay) closeCmd(); });

document.addEventListener('keydown', ev => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); cmdOverlay.classList.contains('open') ? closeCmd() : openCmd(); return; }
  const a = document.activeElement;
  if (ev.ctrlKey || ev.metaKey || ev.altKey || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
  if (document.querySelector('.overlay.open') || $('dashboard').hidden) return;
  if (ev.key === '/') { ev.preventDefault(); openCmd(); return; }
  const v = Object.keys(VIEWS)[Number(ev.key) - 1];
  if (v) setView(v);
});

// ── Side rail ────────────────────────────────────────────────────────────────
// Collapses to icons. A convenience kept per browser, so it may be forgotten.
function setRail(on) {
  $('dashboard').classList.toggle('rail', on);
  $('nav-toggle').dataset.railTip = 'Expand';
  try { localStorage.setItem('ft-rail', on ? '1' : ''); } catch {}
  setTimeout(() => { if (view === 'cashflow' || view === 'spending') renderActive(); }, 220); // drawn to the new width
}
$('nav-toggle').addEventListener('click', () => { hideTip(); setRail(!$('dashboard').classList.contains('rail')); });
try { if (localStorage.getItem('ft-rail')) $('dashboard').classList.add('rail'); } catch {}

// ── Demo ─────────────────────────────────────────────────────────────────────
function startDemo() {
  demo = true;
  state = {
    transactions: demoFiles().flatMap(text => A.parseFile(text).transactions),
    rules: { merchant: {}, amount_rules: [] }, training: [],
    settings: { cc_start: 0, budgets: { Groceries: 650, Dining: 320, Shopping: 300, Subscriptions: 45, Transportation: 160, Entertainment: 120, 'Utilities & Bills': 200 } },
    sync: null, meta: { updatedAt: 0, rulesUpdatedAt: 0 },
  };
  rangePreset = null;
  showView();
}
async function exitDemo() {
  if (!demo) return;
  demo = false;
  state = await store.loadAll();
  rangePreset = null; view = 'overview';
  showView();
}
$('welcome-demo').addEventListener('click', startDemo);
$('demo-exit').addEventListener('click', exitDemo);

// ── Category picker ──────────────────────────────────────────────────────────
const picker = $('cat-picker');
const pickerOpts = $('cat-picker-opts');
let pickerMerchant = null, pickerCurrentCat = null, pickerAmount = null, pickerPendingCat = null;

function showPickerOpts() {
  $('cat-picker-matchby').style.display = 'none';
  $('cat-pick-tolerance-panel').style.display = 'none';
  $('cat-picker-search').style.display = '';
  pickerOpts.style.display = '';
}

function openPicker(anchorEl, merchant, currentCat, amount) {
  pickerMerchant = merchant;
  pickerCurrentCat = currentCat;
  pickerAmount = amount != null ? parseFloat(amount) : null;
  pickerPendingCat = null;
  showPickerOpts();

  const cats = [...ALL_CATS, ...TRANSFER_CATS];
  if (!cats.includes(currentCat)) cats.push(currentCat);
  $('cat-picker-title').textContent = `Recategorize ${merchant}`;
  pickerOpts.innerHTML = cats.map(c =>
    `<button class="picker-opt${c === currentCat ? ' current' : ''}" data-pick="${esc(c)}">${esc(c)}${TRANSFER_CATS.has(c) ? ' <small class="dim">transfer</small>' : ''}</button>`).join('');
  const searchEl = $('cat-picker-search');
  searchEl.value = '';
  picker.classList.add('open');
  if (!isPhone()) setTimeout(() => searchEl.focus(), 30);

  const rect = anchorEl.getBoundingClientRect();
  const pickerH = 360;
  picker.style.top = (rect.bottom + 6 + pickerH > window.innerHeight ? Math.max(8, rect.top - pickerH - 6) : rect.bottom + 6) + 'px';
  picker.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 220)) + 'px';
}

function closePicker() { picker.classList.remove('open'); pickerMerchant = null; }

$('cat-picker-search').addEventListener('input', () => {
  const q = $('cat-picker-search').value.toLowerCase();
  pickerOpts.querySelectorAll('.picker-opt').forEach(b => { b.style.display = b.dataset.pick.toLowerCase().includes(q) ? '' : 'none'; });
});


pickerOpts.addEventListener('click', ev => {
  const btn = ev.target.closest('.picker-opt');
  if (!btn) return;
  const newCat = btn.dataset.pick;
  if (newCat === pickerCurrentCat) { closePicker(); return; }
  pickerPendingCat = newCat;
  $('cat-pick-by-merchant').textContent = `All "${pickerMerchant}" transactions`;
  const byAmt = $('cat-pick-by-amount');
  byAmt.hidden = pickerAmount == null;
  if (pickerAmount != null) byAmt.textContent = `Only "${pickerMerchant}" at $${fmt(pickerAmount)} (this stream)`;
  pickerOpts.style.display = 'none';
  $('cat-picker-search').style.display = 'none';
  $('cat-picker-matchby').style.display = 'flex';
});

function addTrainingExample(text, category) {
  if (!state.training.some(d => d.text === text && d.category === category)) state.training.push({ text, category });
}

async function applyRule(mutate) {
  mutate();
  closePicker();
  closeDrawer();
  await commit({ rules: true });
  rebuild(true);
  toast('Rule saved. It applies to every past and future upload.');
}

$('cat-pick-by-merchant').addEventListener('click', () => {
  const merchant = pickerMerchant, cat = pickerPendingCat;
  applyRule(() => {
    state.rules.merchant[merchant] = cat;
    addTrainingExample(merchant, cat);
  });
});

function updateTolRange() {
  const tol = parseFloat($('cat-pick-tol-pct').value) || 0;
  if (pickerAmount == null) return;
  $('cat-pick-tol-range').textContent = tol === 0
    ? `Matches exactly $${fmt(pickerAmount)}`
    : `Matches $${fmt(pickerAmount * (1 - tol / 100))} – $${fmt(pickerAmount * (1 + tol / 100))}`;
}

$('cat-pick-by-amount').addEventListener('click', () => {
  $('cat-picker-matchby').style.display = 'none';
  $('cat-pick-tol-pct').value = '0';
  updateTolRange();
  $('cat-pick-tolerance-panel').style.display = 'flex';
});
$('cat-pick-tol-pct').addEventListener('input', updateTolRange);
$('cat-pick-tol-confirm').addEventListener('click', () => {
  const tol = Math.max(0, parseFloat($('cat-pick-tol-pct').value) || 0);
  const merchant = pickerMerchant, cat = pickerPendingCat, amount = A.round2(pickerAmount);
  applyRule(() => {
    state.rules.amount_rules = state.rules.amount_rules.filter(r => !(r.merchant === merchant && Math.abs(r.amount - amount) < 0.01));
    state.rules.amount_rules.push({ merchant, amount, tolerance_pct: A.round2(tol), category: cat });
    addTrainingExample(merchant, cat);
  });
});
$('cat-pick-matchby-back').addEventListener('click', showPickerOpts);
$('cat-pick-matchby-back2').addEventListener('click', () => {
  $('cat-pick-tolerance-panel').style.display = 'none';
  $('cat-picker-matchby').style.display = 'flex';
});
// Category tags open the picker wherever they are drawn (ledger, detail drawer).
document.addEventListener('click', ev => {
  const pill = ev.target.closest('.txn-cat');
  if (pill) {
    if (pickerMerchant === pill.dataset.merchant && picker.classList.contains('open')) { closePicker(); return; }
    openPicker(pill, pill.dataset.merchant, pill.dataset.cat, pill.dataset.amount);
  } else if (!picker.contains(ev.target)) closePicker();
});

// ── Importing CSVs ───────────────────────────────────────────────────────────
// Whatever route the files took (picker, drop, watched folder, share sheet,
// "open with"), they end up here as [{ name, text }].
async function ingest(items, { auto = false } = {}) {
  const wasDemo = demo;
  if (demo) { demo = false; state = await store.loadAll(); rangePreset = null; } // real files replace the demo
  const unknown = [], perAcct = new Map();
  let merged = state.transactions, added = 0, skipped = 0;
  for (const f of items) {
    try {
      // Each file is merged before the next is read, so the next one knows
      // which account numbers are savings.
      const { format, transactions } = A.parseFile(f.text, { known: A.knownAccounts(merged), name: f.name });
      if (format === 'unknown' || !transactions.length) { unknown.push(f.name); continue; }
      const have = new Set(merged.map(t => t.id));
      for (const t of transactions) if (!have.has(t.id)) perAcct.set(t.account, (perAcct.get(t.account) || 0) + 1);
      const r = A.mergeTransactions(merged, transactions);
      merged = r.merged; added += r.added; skipped += r.skipped;
    } catch (e) {
      unknown.push(f.name);
    }
  }
  if (!added && !skipped) {
    if (wasDemo) showView();
    if (!auto) toast(`No recognisable transactions in ${unknown.join(', ')}. Expected a Capital One checking, savings or credit card export.`, true);
    return 0;
  }
  if (added) {
    state.transactions = A.repairStored(merged);
    await commit();
    store.requestPersistence();
    showView();
  } else if (wasDemo) showView();
  if ($('refresh-overlay').classList.contains('open')) renderRefresh();
  if (auto && !added) return 0;
  const detail = [...perAcct].map(([a, n]) => `${a.replace(' ...', ' ')} +${n.toLocaleString()}`).join(', ');
  let msg = added
    ? `${auto ? 'Imported' : 'Added'} ${added.toLocaleString()} new transaction${added === 1 ? '' : 's'}${perAcct.size > 1 ? ` (${detail})` : perAcct.size ? ` to ${[...perAcct.keys()][0]}` : ''}`
    : 'Nothing new: every transaction in those files is already saved';
  if (added && skipped) msg += `, skipped ${skipped.toLocaleString()} already saved`;
  if (unknown.length) msg += `. Not recognised: ${unknown.join(', ')}`;
  toast(msg + '.', unknown.length > 0);
  return added;
}

async function importFiles(fileList) {
  const files = [...fileList].filter(f => /\.csv$/i.test(f.name) || /csv|comma-separated/.test(f.type));
  if (!files.length) { toast('Choose one or more .csv files.', true); return; }
  await ingest(await Promise.all(files.map(async f => ({ name: f.name, text: await f.text() }))));
}

const dropZone = $('drop-zone');
$('file-input').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
$('add-input').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
for (const z of [dropZone, $('rf-drop')]) {
  z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('drag-over'); });
  z.addEventListener('dragleave', () => z.classList.remove('drag-over'));
  z.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); z.classList.remove('drag-over'); importFiles(e.dataTransfer.files); });
}
// The dashboard accepts a drop anywhere too.
document.addEventListener('dragover', e => { if (!$('dashboard').hidden) e.preventDefault(); });
document.addEventListener('drop', e => {
  if ($('dashboard').hidden || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  importFiles(e.dataTransfer.files);
});

// ── Refresh sheet ────────────────────────────────────────────────────────────
// How far behind each account is, where to get the next export, and the
// watched folder that makes the second half of that automatic.
const refreshOverlay = $('refresh-overlay');
const dataAge = ts => Math.max(0, Math.round((dayStart(Date.now()) - ts) / DAY));

// Capital One's download form opens on CSV and "Last 30 Days", and this app
// cannot reach into their page to change it. What it can do is say when the
// form is already right, which with regular refreshes is every time.
const DEFAULT_PERIOD = 30, OVERLAP = 3;
function periodAdvice(age, from) {
  return age <= DEFAULT_PERIOD - OVERLAP ? 'Last 30 Days covers it: just press Download'
    : `needs ${age + OVERLAP} days: choose a Time Period back to ${shortDate(from)}`;
}

function renderRefresh() {
  const last = new Map();
  if (!demo) for (const t of state.transactions) if (!(last.get(t.account) >= t.date)) last.set(t.account, t.date);
  $('rf-accounts-sec').hidden = !last.size;
  let oldest = null;
  $('rf-accounts').innerHTML = [...last].sort((a, b) => a[0].localeCompare(b[0])).map(([acct, iso]) => {
    const ts = A.localTs(iso), age = dataAge(ts), from = addDays(ts, -OVERLAP);
    if (oldest == null || from < oldest) oldest = from;
    const url = acctLink(acct);
    const action = linkEdit === acct
      ? `<form class="rf-link-form" data-acct="${esc(acct)}"><input class="set-input" type="text" inputmode="url" placeholder="Paste any page address of this account from Capital One" value="${esc(url || '')}" aria-label="Capital One page for ${esc(acct)}" /><button class="btn small primary">Save</button><button type="button" class="btn small" data-link-cancel>Cancel</button></form>`
      : url ? `<span class="rf-go"><a class="btn small primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Download ↗</a><button class="link-btn" data-link-edit="${esc(acct)}">edit</button></span>`
      : `<button class="btn small" data-link-edit="${esc(acct)}">Add link</button>`;
    return `<div class="rf-acct"><span>${esc(acct)}</span>
      <span>through ${shortDate(ts)}<small>${periodAdvice(age, from)}</small></span>
      <span class="tag ${age >= 21 ? 'over' : age >= 7 ? 'near' : 'ok'}">${age === 0 ? 'TODAY' : `${age}D BEHIND`}</span>${action}</div>`;
  }).join('');
  const linked = [...last.keys()].filter(acctLink);
  $('rf-open-all').hidden = linked.length < 2;
  $('rf-open-all').textContent = `Open all ${linked.length} ↗`;
  $('rf-open-home').classList.toggle('primary', !linked.length);
  $('rf-link-note').hidden = !last.size || linked.length === last.size;
  const worst = oldest == null ? null : dataAge(oldest) - OVERLAP;
  $('rf-hint').textContent = worst == null ? 'For a first import, pick the longest Time Period offered.'
    : worst <= DEFAULT_PERIOD - OVERLAP ? 'Every account is covered by the form as it opens: CSV, Last 30 Days. Just press Download.'
    : `Furthest behind needs a Time Period reaching back to ${shortDate(oldest)}.`;
  renderWatch();
}

// A saved shortcut to each account's own page on Capital One. Only you can
// supply it: the address holds an id that is different for every customer.
// It lives in settings, so it syncs. Anything that is not a Capital One https
// address is refused, here and again when it is read back.
let linkEdit = null;
const acctLink = acct => cleanLink(state.settings.links?.[acct] || '');  // read back through the same check

$('rf-accounts').addEventListener('click', ev => {
  const edit = ev.target.closest('[data-link-edit]');
  if (edit) { linkEdit = edit.dataset.linkEdit; renderRefresh(); $('rf-accounts').querySelector('.rf-link-form input')?.focus(); }
  else if (ev.target.closest('[data-link-cancel]')) { linkEdit = null; renderRefresh(); }
});
$('rf-accounts').addEventListener('submit', async ev => {
  ev.preventDefault();
  const form = ev.target.closest('.rf-link-form');
  if (!form) return;
  const raw = form.querySelector('input').value.trim(), url = raw ? downloadLink(raw) : null;
  if (raw && !url) { toast('That is not a capitalone.com address. Copy it from the address bar while the account is open.', true); return; }
  const links = { ...(state.settings.links || {}) };
  if (url) links[form.dataset.acct] = url; else delete links[form.dataset.acct];
  state.settings.links = links;
  linkEdit = null;
  await commit();
  renderRefresh();
});
$('rf-open-all').addEventListener('click', () => {
  const urls = [...new Set(state.transactions.map(t => t.account))].map(acctLink).filter(Boolean);
  const opened = urls.filter(u => window.open(u, '_blank')).length;
  if (opened < urls.length) toast(`The browser held back ${urls.length - opened} of ${urls.length} tabs. Allow pop-ups for this site and they will all open next time.`, true);
});

let watchState = 'none'; // none | granted | prompt | denied | missing
function renderWatch() {
  const el = $('rf-watch'), w = watch.current();
  if (!watch.supported) {
    el.innerHTML = `<p>In Chrome or Edge on a computer, this app can watch the folder your downloads land in and import new exports by itself. This browser does not offer that.
      On Android, install the app and use <b>Share → FinanceTracker</b> on the downloaded file instead.</p>`;
    return;
  }
  if (!w) {
    el.innerHTML = `<p>Choose the folder your Capital One downloads are saved to. From then on a new export is imported as soon as you come back to this tab: no choosing files.
      The app only reads CSV files there, and only keeps the ones that are Capital One exports.</p>
      <div class="set-row"><button class="btn" id="watch-pick">Choose a folder to watch</button></div>
      <p style="margin-top:10px">If the browser refuses your Downloads folder itself, make a folder inside it (say <b>Downloads/Bank</b>), watch that, and save exports there.</p>`;
    return;
  }
  const ok = watchState === 'granted';
  const status = ok ? `Watching <b>${esc(w.name)}</b>${w.lastScan ? ` · checked ${new Date(w.lastScan).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`
    : watchState === 'missing' ? `<b>${esc(w.name)}</b> could not be read. It may have been moved or deleted.`
    : `<b>${esc(w.name)}</b> needs your go-ahead again. Browsers ask once per visit unless you choose “Allow on every visit”.`;
  el.innerHTML = `<div class="watch-on${ok ? '' : ' wait'}"><i></i><span>${status}</span></div>
    <div class="set-row">
      <button class="btn${ok ? '' : ' primary'}" id="watch-check">${ok ? 'Check now' : 'Reconnect folder'}</button>
      <button class="btn" id="watch-pick">Change folder</button>
      <button class="btn" id="watch-stop">Stop watching</button>
    </div>`;
}

let scanning = false;
async function watchScan({ ask = false, loud = false } = {}) {
  if (!watch.current() || scanning || demo && !ask) return;
  scanning = true;
  try {
    watchState = await watch.permission(ask);
    if (watchState === 'granted') {
      let files;
      try { files = await watch.scan(); } catch { watchState = 'missing'; files = []; }
      const n = files.length ? await ingest(files, { auto: true }) : 0;
      if (loud && !n && watchState === 'granted') toast(`No new exports in ${watch.current().name}.`);
    }
  } catch {
    watchState = 'prompt';
  } finally {
    scanning = false;
  }
  updateWatchChip();
  if (refreshOverlay.classList.contains('open')) renderWatch();
}
// The topbar button doubles as the reconnect button when the folder is asleep.
function updateWatchChip() {
  const asleep = watch.current() && watchState !== 'granted';
  $('refresh-open').querySelector('span').textContent = asleep ? 'Reconnect folder' : 'Refresh data';
  $('refresh-open').dataset.asleep = asleep ? '1' : '';
}

$('rf-watch').addEventListener('click', async ev => {
  if (ev.target.closest('#watch-pick')) {
    try { await watch.pick(); }
    catch (e) { if (e.name !== 'AbortError') toast('That folder could not be opened. Try a folder inside it.', true); return; }
    await watchScan({ ask: true, loud: true });
  } else if (ev.target.closest('#watch-check')) {
    await watchScan({ ask: true, loud: true });
  } else if (ev.target.closest('#watch-stop')) {
    await watch.stop();
    watchState = 'none';
    updateWatchChip();
    renderWatch();
  }
});

function openRefresh() { renderRefresh(); refreshOverlay.classList.add('open'); }
function closeRefresh() { refreshOverlay.classList.remove('open'); linkEdit = null; }
$('refresh-open').addEventListener('click', async () => {
  // One click wakes the folder and imports; the sheet only opens if that found nothing to do.
  if ($('refresh-open').dataset.asleep) { await watchScan({ ask: true }); if (watchState === 'granted') return; }
  openRefresh();
});
$('asof').addEventListener('click', openRefresh);
$('welcome-refresh').addEventListener('click', openRefresh);
$('close-refresh').addEventListener('click', closeRefresh);
refreshOverlay.addEventListener('click', ev => { if (ev.target === refreshOverlay) closeRefresh(); });

// Look in the folder whenever the app is looked at.
let lastWatch = 0;
function watchTick() {
  if (document.visibilityState !== 'visible' || Date.now() - lastWatch < 3000) return;
  lastWatch = Date.now();
  watchScan();
}
window.addEventListener('focus', watchTick);
document.addEventListener('visibilitychange', watchTick);
setInterval(watchTick, 20000);

// Files handed over by the system: "Open with" on a computer, Share on Android.
let booted;
const ready = new Promise(r => { booted = r; });
window.launchQueue?.setConsumer(async params => {
  if (!params.files?.length) return;
  await ready;
  importFiles(await Promise.all(params.files.map(h => h.getFile())));
});
async function drainInbox() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('ft-inbox');
    const items = [];
    for (const req of await cache.keys()) {
      items.push(...await (await cache.match(req)).json());
      await cache.delete(req);
    }
    if (items.length) await ingest(items);
  } catch {}
}

// ── Settings ─────────────────────────────────────────────────────────────────
const settingsOverlay = $('settings-overlay');
function openSettings() {
  renderSettings();
  settingsOverlay.classList.add('open');
}
function closeSettings() { settingsOverlay.classList.remove('open'); }
$('open-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', ev => { if (ev.target === settingsOverlay) closeSettings(); });
$('welcome-sync').addEventListener('click', openSettings);

document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  streamOverlay.classList.remove('open');
  closeCmd();
  closeDrawer();
  closeSettings();
  closeRefresh();
  closeInstall();
  closePicker();
});

function renderSettings() {
  $('cc-start').value = state.settings.cc_start || '';
  const m = Object.entries(state.rules.merchant);
  const a = state.rules.amount_rules;
  $('rule-count').textContent = m.length + a.length ? `(${m.length + a.length})` : '';
  $('rule-list').innerHTML = (m.length + a.length) ? [
    ...a.map((r, i) => `<div class="rule-item"><span class="rm" title="${esc(r.merchant)}">${esc(r.merchant)} <span class="dim">at $${fmt(r.amount)}${r.tolerance_pct ? ` ±${r.tolerance_pct}%` : ''}</span></span><span class="rc">${esc(r.category)}</span><button data-amt="${i}" aria-label="Remove rule">✕</button></div>`),
    ...m.sort((x, y) => x[0].localeCompare(y[0])).map(([k, c]) => `<div class="rule-item"><span class="rm" title="${esc(k)}">${esc(k)}</span><span class="rc">${esc(c)}</span><button data-merchant="${esc(k)}" aria-label="Remove rule">✕</button></div>`),
  ].join('') : '<div class="set-status">No rules yet. Tap a category in the transactions table to create one.</div>';

  const accts = new Set(state.transactions.map(t => t.account)).size;
  $('data-summary').textContent = state.transactions.length
    ? `${state.transactions.length.toLocaleString()} transactions across ${accts} account${accts === 1 ? '' : 's'}, stored in this browser.`
    : 'Nothing stored yet.';
  $('app-version').textContent = BUILD.startsWith('__')
    ? 'Development copy (not deployed)'
    : `Version ${BUILD.split('-')[0]}, deployed ${BUILD.split('-')[1].replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3 $4:$5 UTC')}`;
  renderSyncStatus();
}

$('rule-list').addEventListener('click', async ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.amt != null) {
    state.rules.amount_rules.splice(Number(b.dataset.amt), 1);
  } else {
    const merchant = b.dataset.merchant;
    delete state.rules.merchant[merchant];
    // The correction also taught the auto-categorizer; forget that too.
    state.training = state.training.filter(t => t.text !== merchant);
  }
  await commit({ rules: true });
  if (state.transactions.length) rebuild(true);
  renderSettings();
});

$('cc-save').addEventListener('click', async () => {
  const v = parseFloat($('cc-start').value);
  state.settings.cc_start = isNaN(v) ? 0 : v;
  await commit();
  if (state.transactions.length) rebuild(true);
  toast('Starting balance saved.');
});

// custom_rules.json and training_data.json from the original Flask app.
$('import-rules').addEventListener('change', async e => {
  let rulesN = 0, trainN = 0;
  try {
    for (const f of e.target.files) {
      const data = JSON.parse(await f.text());
      if (Array.isArray(data)) {
        for (const ex of data) if (ex && ex.text && ex.category) { addTrainingExample(ex.text, ex.category); trainN++; }
      } else if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data.merchant || {})) { state.rules.merchant[k] = v; rulesN++; }
        for (const r of data.amount_rules || []) {
          state.rules.amount_rules = state.rules.amount_rules.filter(x => !(x.merchant === r.merchant && Math.abs(x.amount - r.amount) < 0.01));
          state.rules.amount_rules.push({ merchant: r.merchant, amount: Number(r.amount), tolerance_pct: Number(r.tolerance_pct) || 0, category: r.category });
          rulesN++;
        }
      }
    }
  } catch {
    toast('That file is not valid JSON.', true);
    e.target.value = '';
    return;
  }
  e.target.value = '';
  await commit({ rules: true });
  if (state.transactions.length) rebuild(true);
  renderSettings();
  toast(`Imported ${rulesN} rule${rulesN === 1 ? '' : 's'} and ${trainN} training example${trainN === 1 ? '' : 's'}.`);
});

function snapshot() {
  return { transactions: state.transactions, rules: state.rules, training: state.training, settings: state.settings, meta: state.meta };
}

$('export-backup').addEventListener('click', () => {
  if (demo) { toast('This is demo data. Exit the demo to back up your own.'); return; }
  download(new Blob([JSON.stringify({ app: 'financetracker', version: 1, exportedAt: new Date().toISOString(), ...snapshot() })], { type: 'application/json' }),
    `financetracker-backup-${isoLocal(Date.now())}.json`);
});

async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!data || data.app !== 'financetracker' || !Array.isArray(data.transactions)) {
    toast('That is not a FinanceTracker backup file.', true);
    return;
  }
  if (demo) { demo = false; state = await store.loadAll(); rangePreset = null; }
  const before = state.transactions.length;
  Object.assign(state, sync.merge(state, data));
  state.transactions = A.repairStored(state.transactions);
  await commit();
  store.requestPersistence();
  closeSettings();
  showView();
  toast(`Backup restored: ${(state.transactions.length - before).toLocaleString()} transactions added.`);
}
$('import-backup').addEventListener('change', e => { if (e.target.files[0]) restoreBackup(e.target.files[0]); e.target.value = ''; });
$('welcome-restore').addEventListener('change', e => { if (e.target.files[0]) restoreBackup(e.target.files[0]); e.target.value = ''; });

$('clear-all').addEventListener('click', async () => {
  if (demo) { closeSettings(); exitDemo(); return; }
  if (!confirm('Delete every transaction, rule and setting stored on this device?')) return;
  if (state.sync?.gistId && confirm('Also delete the encrypted copy synced to GitHub? Cancel keeps it, so other devices are unaffected and this one re-downloads it on the next sync.')) {
    try { await sync.deleteGist(state.sync.token, state.sync.gistId); } catch (e) { toast(e.message, true); }
    await disconnectSync();
  }
  await store.clearData();
  state = await store.loadAll();
  closeSettings();
  showView();
  toast('All data deleted from this device.');
});

// ── Sync ─────────────────────────────────────────────────────────────────────
let syncing = false, syncAgain = false, syncTimer = null, lastAutoSync = 0;

function setDot(cls) { $('sync-dot').className = 'sync-dot' + (cls ? ' ' + cls : ''); renderStatus(); }

function renderSyncStatus(msg) {
  const on = !!state.sync;
  $('sync-setup').hidden = on;
  $('sync-on').hidden = !on;
  if (on) {
    $('sync-status').textContent = msg || (state.sync.lastSync
      ? `Connected. Last synced ${new Date(state.sync.lastSync).toLocaleString()}.`
      : 'Connected.');
  }
}

function scheduleSync() {
  if (!state.sync) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow({ quiet: true }), 1500);
}

async function syncNow({ quiet = false } = {}) {
  if (!state.sync || demo) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setDot('busy');
  try {
    const { token, passphrase } = state.sync;
    let gistId = state.sync.gistId;
    let remote = null;
    if (gistId) {
      try { remote = await sync.pull(token, gistId, passphrase); }
      catch (e) { if (!/answered 404/.test(e.message)) throw e; gistId = null; }
    }
    const beforeCount = state.transactions.length;
    const beforeRules = state.meta.rulesUpdatedAt;
    const beforeSettings = JSON.stringify(state.settings);
    if (remote) { Object.assign(state, sync.merge(state, remote)); state.transactions = A.repairStored(state.transactions); }
    const changedLocally = state.transactions.length !== beforeCount
      || state.meta.rulesUpdatedAt !== beforeRules
      || JSON.stringify(state.settings) !== beforeSettings;

    const remoteUpToDate = remote
      && remote.transactions.length === state.transactions.length
      && (remote.meta?.rulesUpdatedAt || 0) === state.meta.rulesUpdatedAt
      && (remote.meta?.updatedAt || 0) === state.meta.updatedAt;
    if (!remoteUpToDate) gistId = await sync.push(token, gistId, passphrase, snapshot());

    state.sync = { ...state.sync, gistId, lastSync: Date.now() };
    await store.set('sync', state.sync);
    if (changedLocally) {
      await store.saveData(state);
      showView();
      if (!quiet || state.transactions.length !== beforeCount) {
        const n = state.transactions.length - beforeCount;
        toast(n > 0 ? `Synced: ${n.toLocaleString()} transactions from your other device.` : 'Synced changes from your other device.');
      }
    } else if (!quiet) {
      toast('Everything is in sync.');
    }
    setDot('ok');
    renderSyncStatus();
  } catch (e) {
    setDot('err');
    renderSyncStatus(`Sync failed: ${e.message}`);
    if (!quiet) toast(`Sync failed: ${e.message}`, true);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; syncNow({ quiet: true }); }
  }
}

$('sync-connect').addEventListener('click', async () => {
  const token = $('sync-token').value.trim();
  const passphrase = $('sync-pass').value;
  const status = $('sync-setup-status');
  if (demo) { status.textContent = 'Exit the demo first; sync works on your own data.'; return; }
  if (!token || passphrase.length < 8) { status.textContent = 'Enter a token and a passphrase of at least 8 characters.'; return; }
  status.textContent = 'Connecting…';
  $('sync-connect').disabled = true;
  try {
    const gistId = await sync.findGist(token);
    if (gistId) await sync.pull(token, gistId, passphrase); // fails here on a wrong passphrase
    state.sync = { token, passphrase, gistId, lastSync: 0 };
    await store.set('sync', state.sync);
    $('sync-token').value = ''; $('sync-pass').value = ''; status.textContent = '';
    renderSyncStatus('Connected. Syncing…');
    await syncNow();
    store.requestPersistence();
  } catch (e) {
    status.textContent = e.message;
  } finally {
    $('sync-connect').disabled = false;
  }
});
$('sync-now').addEventListener('click', () => syncNow());

async function disconnectSync() {
  state.sync = null;
  await store.del('sync');
  setDot('');
}
$('sync-off').addEventListener('click', async () => {
  await disconnectSync();
  renderSyncStatus();
  toast('This device is no longer syncing. Its data stays here.');
});

// Pick up the other device's changes when the app comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state?.sync && Date.now() - lastAutoSync > 60000) {
    lastAutoSync = Date.now();
    syncNow({ quiet: true });
  }
});

// ── Install ──────────────────────────────────────────────────────────────────
// Chrome, Edge and Android hand over a real install prompt (beforeinstallprompt).
// iOS has no such API in any browser, so there the sheet shows the Share steps.
let installPrompt = null;
const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const SHARE_GLYPH = '<span class="glyph" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg></span>';

function renderInstall() {
  const body = $('install-body');
  if (isStandalone()) {
    body.innerHTML = '<p class="install-note">You are already using the installed app.</p>';
  } else if (installPrompt) {
    body.innerHTML = '<button class="btn primary block" id="install-go">Install app</button>'
      + '<p class="install-note">Adds FinanceTracker to your ' + (isAndroid ? 'home screen and app drawer' : 'Start menu / Dock and desktop') + '.</p>';
  } else if (isIOS) {
    body.innerHTML = `<ol class="install-steps">
        <li><span>Tap the Share button ${SHARE_GLYPH} in the toolbar</span></li>
        <li><span>Scroll down and tap <b>Add to Home Screen</b></span></li>
        <li><span>Tap <b>Add</b> in the top corner</span></li>
      </ol>
      <p class="install-note">Installed apps keep their data. Safari can clear storage for websites you have not opened in a while, but not for apps on the Home Screen.</p>`;
  } else if (isAndroid) {
    body.innerHTML = `<ol class="install-steps">
        <li><span>Open the browser menu <b>⋮</b></span></li>
        <li><span>Tap <b>Install app</b> or <b>Add to Home screen</b></span></li>
      </ol>`;
  } else if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) {
    body.innerHTML = `<ol class="install-steps">
        <li><span>In the menu bar, choose <b>File → Add to Dock…</b></span></li>
        <li><span>Click <b>Add</b></span></li>
      </ol>`;
  } else if (/Chrome|Chromium|Edg/.test(ua)) {
    // Chrome/Edge before (or without) its install prompt: point at its own menus.
    body.innerHTML = `<ol class="install-steps">
        <li><span>Click the install icon at the right end of the address bar</span></li>
        <li><span>Or open the menu <b>⋮</b> → <b>Cast, save and share</b> → <b>Install page as app</b></span></li>
      </ol>
      <p class="install-note">An <b>Install app</b> button appears here once the browser is ready, usually within a second or two.</p>`;
  } else {
    body.innerHTML = `<ol class="install-steps">
        <li><span>Open this page in <b>Chrome</b> or <b>Edge</b></span></li>
        <li><span>Click the install icon at the right end of the address bar</span></li>
      </ol>
      <p class="install-note">This browser cannot install web apps, but the site still works here and keeps your data.</p>`;
  }
}

function openInstall() {
  renderInstall();
  $('install-overlay').classList.add('open');
}
function closeInstall() {
  $('install-overlay').classList.remove('open');
  if (location.hash === '#install') history.replaceState(null, '', location.pathname + location.search);
}
function updateInstallButtons() {
  const show = !isStandalone() && (!!installPrompt || isIOS);
  $('install-btn').hidden = !show;
  $('welcome-install-row').hidden = isStandalone();
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); // keep it for our own button rather than the browser's mini-bar
  installPrompt = e;
  updateInstallButtons();
  if ($('install-overlay').classList.contains('open')) renderInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  updateInstallButtons();
  closeInstall();
  toast('Installed. You can open FinanceTracker from your apps now.');
});

$('install-body').addEventListener('click', async ev => {
  if (!ev.target.closest('#install-go') || !installPrompt) return;
  const p = installPrompt;
  installPrompt = null; // a prompt can only be shown once
  p.prompt();
  const { outcome } = await p.userChoice;
  if (outcome !== 'accepted') renderInstall();
  updateInstallButtons();
});
$('install-btn').addEventListener('click', openInstall);
$('welcome-install').addEventListener('click', openInstall);
$('close-install').addEventListener('click', closeInstall);
$('install-overlay').addEventListener('click', ev => { if (ev.target === $('install-overlay')) closeInstall(); });
window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (h === 'install') openInstall(); else if (VIEWS[h]) setView(h, { push: false });
});

// ── Auto-update ──────────────────────────────────────────────────────────────
// Each deploy changes sw.js (the workflow stamps the commit into it). The browser
// installs the new worker, which takes over at once; 'controllerchange' then
// tells this page, and it reloads onto the new files at a moment that cannot
// interrupt anything. Stored data is in IndexedDB and is untouched by a reload.
const UPDATE_CHECK_MS = 30 * 60 * 1000;
let swReg = null;
let updatePending = false;

function busy() {
  const a = document.activeElement;
  return syncing
    || picker.classList.contains('open')
    || settingsOverlay.classList.contains('open')
    || scanning
    || $('install-overlay').classList.contains('open')
    || !!document.querySelector('.overlay.open')
    || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'file');
}

function applyUpdate() {
  try { sessionStorage.setItem('ft-updated', '1'); } catch {}
  location.reload();
}

function onUpdateReady() {
  if (updatePending) return;
  updatePending = true;
  if (document.hidden || !busy()) { applyUpdate(); return; }
  // In the middle of something: offer it, and take it the next time the app is
  // put away.
  const el = $('toast');
  el.innerHTML = 'Update ready. <button class="link-btn" id="update-now">Reload</button>';
  el.classList.remove('err');
  el.classList.add('show');
  clearTimeout(toastTimer);
  $('update-now').addEventListener('click', applyUpdate);
}

function checkForUpdate() {
  if (swReg && navigator.onLine !== false) swReg.update().catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && updatePending) applyUpdate();
  if (document.visibilityState === 'visible') checkForUpdate();
});

$('check-update').addEventListener('click', async () => {
  if (!swReg) { toast('Updates only apply to the deployed site.'); return; }
  try { await swReg.update(); }
  catch { toast("Couldn't reach the server. Check your connection.", true); return; }
  if (swReg.installing || swReg.waiting) {
    closeSettings(); // so the reload is not held back for an open sheet
    toast('Downloading the update…');
  } else {
    toast("You're on the latest version.");
  }
});

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // Only a worker *replacing* one counts as an update; the very first install
  // also fires controllerchange and must not reload the page. Tracked per change,
  // not once at load, or a first visit would never pick up a later deploy.
  let controller = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const replaced = !!controller;
    controller = navigator.serviceWorker.controller;
    if (replaced) onUpdateReady();
  });
  try {
    swReg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    checkForUpdate();
    setInterval(checkForUpdate, UPDATE_CHECK_MS);
  } catch {}
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  state = await store.loadAll();
  const healed = A.repairStored(state.transactions);
  if (healed !== state.transactions) { state.transactions = healed; await store.set('transactions', healed); }
  await watch.load().catch(() => null);
  if (VIEWS[location.hash.slice(1)]) view = location.hash.slice(1);
  showView();
  updateInstallButtons();
  if (location.hash === '#install') openInstall();
  if (state.sync) { setDot('ok'); lastAutoSync = Date.now(); syncNow({ quiet: true }); }
  registerServiceWorker();
  booted();
  drainInbox();
  watchScan();
  // Charts measure their text, so draw them again once the bundled faces are in.
  document.fonts?.ready.then(() => renderActive());
  try {
    if (sessionStorage.getItem('ft-updated')) {
      sessionStorage.removeItem('ft-updated');
      toast(`Updated to the latest version${BUILD.startsWith('__') ? '' : ` (${BUILD.split('-')[0]})`}.`);
    }
  } catch {}
}

boot().catch(e => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<p style="position:relative;z-index:5;padding:2rem;color:#fa999c">Could not open local storage: ${esc(e.message)}. Private browsing modes can block it.</p>`);
});
