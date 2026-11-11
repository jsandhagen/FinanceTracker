import * as store from './storage.js';
import * as A from './analyzer.js';
import * as I from './insights.js';
import * as sync from './sync.js';
import * as watch from './watch.js';
import { cleanLink, downloadLink } from './links.js';
import * as T from './tax.js';
import * as N from './income.js';
import * as P from './plaid.js';
import * as native from './native.js';
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
const VIEWS = { overview: 'Overview', cashflow: 'Cash flow', income: 'Income', salary: 'Salary & raises', spending: 'Spending', budgets: 'Budgets', recurring: 'Recurring', transactions: 'Transactions', accounts: 'Accounts' };
const PARENT = { salary: 'income', budgets: 'spending' };   // sub-items in the menu
// The tabs across the top of a section with sub-items.
const SUBS = { income: [['income', 'Sources'], ['salary', 'Salary & raises']], spending: [['spending', 'Breakdown'], ['budgets', 'Budgets']] };
const NAV_KEYS = Object.keys(VIEWS).filter(v => !PARENT[v]); // what the number keys 1-7 open
const RANGE_FREE = new Set(['salary', 'budgets', 'recurring', 'accounts']); // these keep their own clock

function showView() {
  const has = state.transactions.length > 0;
  $('welcome').hidden = has;
  $('dashboard').hidden = !has;
  $('demo-banner').hidden = !demo;
  placeRefresh();
  if (has) rebuild(false);
}

function setView(v, { push = true } = {}) {
  if (!VIEWS[v]) return;
  view = v;
  incDraft = null;
  const top = PARENT[v] || v;
  document.querySelectorAll('.view').forEach(s => { s.hidden = s.dataset.view !== v; });
  // In the side rail the sub-item lights up under its parent; the phone's tab
  // bar has no sub-items, so there the parent stands for both.
  document.querySelectorAll('.nav-item').forEach(b => {
    const sub = b.classList.contains('nav-sub');
    b.classList.toggle('active', b.dataset.view === v || (b.dataset.view === top && !b.closest('.nav')));
    b.classList.toggle('open', !sub && b.dataset.view === top && top !== v);
  });
  $('subnav').hidden = !SUBS[top];
  $('subnav-seg').innerHTML = (SUBS[top] || []).map(([k, label]) => `<button data-goto="${k}"${k === v ? ' class="active"' : ''}>${esc(label)}</button>`).join('');
  $('view-title').textContent = PARENT[v] ? `${VIEWS[top]} / ${VIEWS[v]}` : VIEWS[v];
  $('filter-bar').hidden = RANGE_FREE.has(v);
  if (push && location.hash !== '#' + v) {
    if (history.state?.layer) history.replaceState({ view: v }, '', '#' + v);
    else history.pushState({ view: v }, '', '#' + v);
  }
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
  ALL_TXN = N.markPaidBack(A.categorize(state.transactions, state.rules, state.training), state.settings.incomeSources);
  STREAMS = A.findRecurringStreams(ALL_TXN);
  BALANCE = A.buildAssetSeries(ALL_TXN, P.cardStart(state.transactions, state.settings.plaid?.cards, state.settings.cc_start));

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
  // A linked card reports what is owed on it, shown as a negative.
  for (const [a, c] of Object.entries(state.settings.plaid?.cards || {})) if (accts.has(a) && typeof c.balance === 'number') accts.set(a, -c.balance);
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
    budgets: renderBudgets, income: renderSources, salary: renderIncome, recurring: renderRecurring, transactions: renderTransactions, accounts: renderAccounts })[view](CTX);
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
  const left = fold(I.totalsBy(c.ops, 'merchant', 1).map(x => ({ ...x, name: srcName(x.name) })), 5, 'Other income').map(x => ({ ...x, color: C.in, tip: 'Income' }));
  const right = fold(I.totalsBy(c.ops, 'category'), 9, 'Everything else').map(x => ({ ...x, color: C.out, tip: 'Spending', cat: x.folded ? null : x.name }));
  // Money paid back covers part of the spending on the right, so it flows in
  // from the left beside income without being counted as income.
  const back = paidBack(c.ops);
  if (back > 0.004) left.push({ name: N.PAID_BACK, total: back, color: KIND_COLOR.reimburse, tip: 'Paid back to you' });
  if (net < 0) left.push({ name: 'Drawn from balance', total: -net, color: C.other, tip: 'Shortfall' });
  if (net > 0) right.push({ name: 'Kept', total: net, color: C.kept, tip: 'Not spent' });

  const total = Math.max(income, expense) + Math.max(0, back);
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
  const backMonthly = paidBack(c.ops) / months;
  const totalSpend = Math.max(0, active.reduce((s, x) => s + x.avg, 0) - backMonthly);
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
    ${backMonthly > 0.004 ? `<div class="sum-row"><span>Paid back to you</span><span class="amt">+$${fmt(backMonthly)}</span></div>` : ''}
    <div class="sum-row"><span>Spending counted${backMonthly > 0.004 ? ', after that' : ''}</span><span class="amt">−$${fmt(totalSpend)}</span></div>
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
  const back = paidBack(c.ops), max = cats[0]?.total || 1;
  const total = cats.reduce((s, x) => s + x.total, 0); // before what was paid back
  $('sp-cat-meta').textContent = `${money0(c.cur.expense)} across ${cats.length} categories${back > 0.004 ? `, after ${money0(back)} paid back` : ''}`;
  $('sp-cats').innerHTML = cats.length ? `<thead><tr><th>Category</th><th class="col-bar"></th><th class="num">Amount</th><th class="num">Share</th>${c.hasPrior ? '<th class="num col-hide-sm">vs prior</th>' : ''}<th class="num col-hide-sm">Txns</th></tr></thead>
    <tbody>${cats.map(x => {
      const d = c.hasPrior ? relDelta(x.total, before.get(x.name), false) : null;
      return `<tr class="link" data-txn-cat="${esc(x.name)}">
        <td><span class="swatch" style="background:${CAT_SLOT[x.name] || C.other}"></span>${esc(x.name)}</td>
        <td class="col-bar"><div class="bar-track"><div class="bar-fill" style="width:${(x.total / max * 100).toFixed(1)}%"></div></div></td>
        <td class="num">${money(x.total)}</td><td class="num dim">${pct(x.total / total, 1)}</td>
        ${c.hasPrior ? `<td class="num col-hide-sm">${deltaHtml(d) || '<span class="dim">new</span>'}</td>` : ''}
        <td class="num dim col-hide-sm">${x.count}</td></tr>`;
    }).join('')}${back > 0.004 ? `<tr class="link" data-txn-cat="${N.PAID_BACK}">
        <td><span class="swatch" style="background:${KIND_COLOR.reimburse}"></span>${N.PAID_BACK} <small class="dim">Venmo, Zelle and the like</small></td>
        <td class="col-bar"></td><td class="num pos">−${money(back)}</td><td class="num dim"></td>
        ${c.hasPrior ? '<td class="num col-hide-sm"></td>' : ''}<td class="num dim col-hide-sm">${c.ops.filter(t => t.paid_back).length}</td></tr>` : ''}</tbody>` : `<tbody><tr><td class="empty">No spending in this period.</td></tr></tbody>`;

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

// What was paid back to you in `ops` (see income.js, PAID_BACK).
const paidBack = ops => ops.reduce((s, t) => s + (t.paid_back ? t.amount : 0), 0);

// ── Income: sources ───────────────────────────────────────────────────────────
// Every deposit that counts as income, grouped by who paid it. Each source has
// a type: salary, a side job, people paying you back, interest or other. Types
// are guessed and yours to change; the Salary & raises tab counts only Salary.
const KIND_ORDER = ['salary', 'side', 'reimburse', 'interest', 'other'];
const KIND_COLOR = { salary: C.in, side: '#c98500', reimburse: '#9085e9', interest: '#199e70', other: C.other };
const KIND_NOTE = {
  salary: 'your main job',
  side: 'a second job or gig',
  reimburse: 'people paying you back',
  interest: 'from savings',
  other: 'anything else',
};
const srcSaved = () => state.settings.incomeSources || {};
const srcName = m => srcSaved()[m]?.name || m;

function renderSources(c) {
  const pay = N.detectPaycheck(SCHED)?.merchant || null;
  const src = N.bySource(c.ops, srcSaved(), pay);
  const { totals, months } = N.byKind(src);
  const prior = c.hasPrior ? N.byKind(N.bySource(c.priorOps, srcSaved(), pay)).totals : {};
  const total = src.reduce((s, x) => s + x.total, 0);
  const kinds = KIND_ORDER.filter(k => totals[k] > 0);
  const vs = c.hasPrior ? `vs prior ${c.days}d` : '';
  const perMonth = c.days / 30.44;

  // Money paid back is listed so its type can be changed, but it is not income.
  const reimb = totals.reimburse || 0, earnedTotal = total - reimb;
  const priorEarned = Object.entries(prior).reduce((a, [k, v]) => a + (k === 'reimburse' ? 0 : v), 0);
  setKpis('src-kpis', [
    kpiTile({ label: 'All income', value: money0(earnedTotal), delta: c.hasPrior ? relDelta(earnedTotal, priorEarned, true) : null,
      sub: reimb > 0 ? `not counting ${money0(reimb)} paid back` : vs }),
    ...kinds.map(k => k === 'reimburse'
      ? kpiTile({ label: 'Paid back to you', value: money0(reimb), delta: c.hasPrior ? relDelta(reimb, prior.reimburse, false) : null,
        sub: 'taken off spending, not income' })
      : kpiTile({ label: N.KINDS[k], value: money0(totals[k]),
        delta: c.hasPrior ? relDelta(totals[k], prior[k], true) : null,
        sub: `${pct(totals[k] / earnedTotal)} · ${money0(totals[k] / perMonth)}/mo`,
        spark: `<div class="meter" aria-hidden="true"><div style="width:${(totals[k] / earnedTotal * 100).toFixed(1)}%;background:${KIND_COLOR[k]}"></div></div>` })),
  ]);

  // Stacked by type, a bar a month.
  $('src-chart-meta').textContent = `${src.length} source${src.length === 1 ? '' : 's'} · ${money0(earnedTotal / perMonth)} a month of income on average`;
  $('src-legend').innerHTML = kinds.map(k => `<span><i style="background:${KIND_COLOR[k]}"></i>${N.KINDS[k]}</span>`).join('');
  chart('src-chart', {
    type: 'bar',
    data: { labels: months.map(m => monthLabel(m.ym)), datasets: kinds.map(k => ({
      label: N.KINDS[k], data: months.map(m => A.round2(m[k] || 0)), backgroundColor: KIND_COLOR[k], borderColor: C.surface, borderWidth: { top: 2 }, maxBarThickness: 28 })) },
    options: { ...hoverLine,
      plugins: { legend: { display: false }, tooltip: { itemSort: (a, b) => b.datasetIndex - a.datasetIndex, filter: x => x.parsed.y > 0,
        callbacks: { label: x => ` ${x.dataset.label}  ${money(x.parsed.y)}`, footer: items => `Total  ${money(items.reduce((s, x) => s + x.parsed.y, 0))}` } } },
      scales: { x: { ...xPlain(), stacked: true }, y: { ...yMoney, stacked: true } } },
  });

  // One row a source, grouped by type.
  const rows = [...src].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.total - a.total);
  const kindSelect = x => `<select class="select src-kind" data-src="${esc(x.merchant)}" aria-label="Type of ${esc(x.name)}">${KIND_ORDER.map(k =>
    `<option value="${k}"${k === x.kind ? ' selected' : ''}>${N.KINDS[k]}</option>`).join('')}</select>`;
  $('src-table').innerHTML = rows.length ? `<thead><tr><th>Source</th><th>Type</th><th class="num">Total</th><th class="num col-hide-sm">Share</th><th class="num col-hide-sm">Per month</th><th class="num col-hide-sm">Deposits</th><th class="col-hide-sm">Last</th></tr></thead>
    <tbody>${rows.map(x => `<tr>
      <td class="src-cell"><span class="swatch" style="background:${KIND_COLOR[x.kind]}"></span><input class="src-name" type="text" data-src="${esc(x.merchant)}" value="${esc(x.name === x.merchant ? '' : x.name)}" placeholder="${esc(x.merchant)}" aria-label="Name for ${esc(x.merchant)}" spellcheck="false" />
        ${x.name !== x.merchant ? `<small>${esc(x.merchant)}</small>` : ''}<button class="link-btn src-see" data-txn-search="${esc(x.merchant)}">deposits →</button></td>
      <td>${kindSelect(x)}${x.set ? '' : '<small class="src-guess">guessed</small>'}</td>
      <td class="num">${money(x.total)}</td>
      <td class="num dim col-hide-sm">${x.kind === 'reimburse' ? 'off spending' : pct(x.total / earnedTotal, 1)}</td>
      <td class="num dim col-hide-sm">${money0(x.total / perMonth)}</td>
      <td class="num dim col-hide-sm">${x.count}</td>
      <td class="dim col-hide-sm">${shortDate(A.localTs(x.last))}</td></tr>`).join('')}</tbody>`
    : `<tbody><tr><td class="empty">No income in this period.</td></tr></tbody>`;

  $('src-foot').innerHTML = `Types: ${KIND_ORDER.map(k => `<b>${N.KINDS[k]}</b> ${KIND_NOTE[k]}`).join(' · ')}. Guessed types: your main paycheck and other deposits from the same employer are Salary, payroll from anyone else is Side income, Venmo, Zelle, Cash App and PayPal are Reimbursements. Change one and it sticks. Only Salary counts toward the <button class="link-btn" data-goto="salary">Salary &amp; raises</button> tracker. <b>Reimbursements are not income</b>: they come off your spending as <button class="link-btn" data-txn-cat="Paid back">Paid back</button>. To take one off a particular category instead, tap its category in the ledger. Selling something or a friend's share of rent you did not front? Type that source Other income.`;
}

async function saveSource(merchant, patch) {
  const all = { ...srcSaved() }, cur = { ...(all[merchant] || {}), ...patch };
  if (!cur.name) delete cur.name;
  if (!cur.kind) delete cur.kind;
  if (Object.keys(cur).length) all[merchant] = cur; else delete all[merchant];
  state.settings.incomeSources = all;
  await commit();
  // A source's type decides whether its deposits are income or money paid back.
  if (patch.kind !== undefined) rebuild(true); else renderActive();
}
$('src-table').addEventListener('change', ev => {
  const k = ev.target.closest('.src-kind'), n = ev.target.closest('.src-name');
  if (k) saveSource(k.dataset.src, { kind: k.value });
  else if (n) saveSource(n.dataset.src, { name: n.value.trim() });
});
$('src-table').addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.matches('.src-name')) ev.target.blur(); });

// ── Income ────────────────────────────────────────────────────────────────────
// A salary tracker and a "what if". The pay you enter is turned into a year of
// take-home with the federal and Virginia rules in tax.js; your real deposits
// then set the two things no table knows: how much leaves before tax, and how
// far your withholding sits from the textbook figure.
const INC = { federal: '#d95926', fica: '#c98500', virginia: '#9085e9', pretax: '#3987e5', net: '#199e70' };
const INC_FIELDS = { salary: 'inc-salary', freq: 'inc-freq', bonus: 'inc-bonus', bonusUnit: 'inc-bonus-unit', bonusMonth: 'inc-bonus-month', filing: 'inc-filing', netPay: 'inc-net' };
const RAISE_IDS = { pct: 'inc-raise-pct', usd: 'inc-raise-usd', salary: 'inc-raise-salary' };
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
$('inc-bonus-month').innerHTML = MONTH_NAMES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');

let incDraft = null; // the form as it is being typed, before it is saved
const incSaved = () => ({ ...N.DEFAULTS, ...(state.settings.income || {}) });
const tidyNum = n => String(Math.round(n * 100) / 100);
const fill = (id, value) => { const el = $(id); if (document.activeElement !== el) el.value = value; };
const stackBar = (parts, total, label) => `<div class="stack-bar" role="img" aria-label="${esc(label)}">${parts.filter(p => p.v > 0.004).map(p =>
  `<i style="width:${(p.v / total * 100).toFixed(2)}%;background:${p.color}" data-tip="${esc(p.name)}|${money(p.v)} · ${pct(p.v / total, 1)}"></i>`).join('')}</div>`;
const stackLegend = (parts, total) => `<div class="legend">${parts.filter(p => p.v > 0.004).map(p =>
  `<span><i style="background:${p.color}"></i>${esc(p.name)} ${money0(p.v)} · ${pct(p.v / total)}</span>`).join('')}</div>`;
const partsOf = y => [
  { name: 'Take-home', v: y.net, color: INC.net },
  { name: 'Before-tax deductions', v: y.pretax, color: INC.pretax },
  { name: 'Federal income tax', v: y.federal, color: INC.federal },
  { name: 'Social Security + Medicare', v: y.ss + y.medicare, color: INC.fica },
  { name: 'Virginia income tax', v: y.virginia, color: INC.virginia },
];

function renderIncome(c) {
  const cfg = incDraft || incSaved();
  const salary = Number(cfg.salary) || 0;
  const pay = N.detectPaycheck(SCHED);
  const netPay = Number(cfg.netPay) > 0 ? Number(cfg.netPay) : pay?.amount || null;
  const eff = { ...cfg, netPay };
  const freq = N.FREQ[cfg.freq] || N.FREQ.biweekly;

  for (const [k, id] of Object.entries(INC_FIELDS)) fill(id, typeof N.DEFAULTS[k] === 'string' || k === 'bonusMonth' ? cfg[k] : cfg[k] || '');
  $('inc-net').placeholder = pay ? fmt(pay.amount) : 'optional';
  fill('inc-save-share', cfg.saveShare ?? 100);
  $('inc-net-note').innerHTML = Number(cfg.netPay) > 0
    ? `Entered by hand.${pay ? ` Your deposits from ${esc(pay.merchant)} are running at ${money(pay.amount)}. <button class="link-btn" id="inc-net-auto">Use those instead</button>` : ''}`
    : pay ? `Read from your deposits: ${esc(srcName(pay.merchant))}, ${money(pay.amount)} ${N.FREQ[pay.freq].label.toLowerCase()}. Type a figure to override it.`
      + (pay.freq !== cfg.freq ? ` Those deposits look ${N.FREQ[pay.freq].label.toLowerCase()}, not ${freq.label.toLowerCase()}. <button class="link-btn" id="inc-freq-fix" data-freq="${pay.freq}">Switch</button>` : '')
    : 'Enter what one paycheck deposits and your tax and deduction rates are backed out of it. Without it, the figures are a plain estimate.';
  $('inc-foot').textContent = `Estimates for tax year ${T.TAX_YEAR}: federal brackets and standard deduction, Social Security and Medicare, and Virginia's rates, standard deduction and personal exemption. Credits, itemized deductions and other income are not modelled. A bonus is usually withheld at a flat rate on the day and squared up when you file; the figures here are what it adds to the year. Not tax advice.`;

  if (!(salary > 0)) {
    setKpis('inc-kpis', [kpiTile({ label: 'Gross per year', value: '—', sub: 'enter your salary below' }), kpiTile({ label: 'Take-home per paycheck', value: pay ? money(pay.amount) : '—', sub: pay ? `from ${esc(pay.merchant)}` : '' }),
      kpiTile({ label: 'Take-home per year', value: '—' }), kpiTile({ label: 'Kept of gross', value: '—' })]);
    for (const id of ['inc-split', 'inc-va', 'inc-year-sum', 'inc-raise-bar']) $(id).innerHTML = id === 'inc-raise-bar' ? '' : empty('Enter your salary to see this.');
    $('inc-raise-table').innerHTML = ''; $('inc-raise-note').textContent = ''; $('inc-year-legend').innerHTML = '';
    for (const id of ['inc-split-meta', 'inc-raise-meta', 'inc-year-meta', 'inc-va-meta']) $(id).textContent = '';
    for (const id of Object.values(RAISE_IDS)) fill(id, '');
    charts['inc-year-chart']?.destroy(); delete charts['inc-year-chart'];
    return;
  }

  const rates = N.ratesFor(eff);
  const now = N.project(eff, rates);
  const newSalary = N.raisedSalary(salary, cfg.raise);
  const hasRaise = !!cfg.raise && newSalary > 0 && Math.abs(newSalary - salary) >= 0.5;
  const then = N.project(eff, rates, hasRaise ? newSalary : salary);
  const d = T.difference(now.full, then.full);
  const month = MONTH_NAMES[(cfg.bonusMonth || 3) - 1];

  // Deposits against the plan, for the year the data ends in.
  const through = isoLocal(DATA_LAST), year = Number(through.slice(0, 4));
  const dates = N.payDates(cfg.freq, year, pay?.lastIso);
  const salarySrc = N.bySource(c.allOps, state.settings.incomeSources, pay?.merchant).filter(x => x.kind === 'salary');
  const isPay = new Set(salarySrc.map(x => x.merchant));
  const tr = N.tracker({ year, dates, netPay: now.per.net, bonusNet: now.bonus.net, bonusMonth: cfg.bonusMonth || 3, txns: c.allOps, through, isSalary: t => isPay.has(t.merchant) });
  const gap = tr.actual - tr.expectedToDate;

  const y = now.full;
  setKpis('inc-kpis', [
    kpiTile({ label: 'Gross per year', value: money0(y.gross), sub: now.bonusGross > 0 ? `${money0(salary)} salary + ${money0(now.bonusGross)} bonus` : 'salary, no bonus' }),
    kpiTile({ label: 'Take-home per paycheck', value: money(now.per.net), sub: `of ${money(now.per.gross)} gross · ${freq.n} a year` }),
    kpiTile({ label: 'Take-home per year', value: money0(y.net), sub: now.bonusGross > 0 ? `incl. ${money0(now.bonus.net)} from the ${month} bonus` : `${money0(y.net / 12)} a month` }),
    kpiTile({ label: 'Kept of gross', value: pct(y.net / y.gross, 1), sub: `${pct(y.taxes / y.gross, 1)} tax · ${pct(y.pretax / y.gross, 1)} before tax`,
      spark: `<div class="meter" aria-hidden="true"><div style="width:${(y.net / y.gross * 100).toFixed(1)}%"></div></div>` }),
    kpiTile({ label: `Received in ${year}`, value: money0(tr.actual), sub: 'vs plan to date',
      delta: tr.expectedToDate > 0 ? { v: gap, text: money0(Math.abs(gap)), good: Math.abs(gap) < 1 ? null : gap > 0 } : null }),
  ]);

  // ── Where a paycheck goes ──
  const line = (name, k, color) => {
    const per = k === 'fica' ? now.per.ss + now.per.medicare : now.per[k], yr = k === 'fica' ? y.ss + y.medicare : y[k];
    return `<tr><td>${color ? `<span class="swatch" style="background:${color}"></span>` : ''}${name}</td><td class="num">${money(per)}</td><td class="num">${money0(yr)}</td><td class="num dim">${pct(yr / y.gross, 1)}</td></tr>`;
  };
  const cal = !rates.calibrated
    ? 'A plain estimate: nothing is assumed to come out before tax. Enter your take-home per paycheck and the rates are backed out of it.'
    : !rates.fit ? `<b class="neg">That take-home is more than a ${money0(salary)} salary can leave after Social Security and Medicare.</b> Check the salary, the pay frequency and the take-home figure.`
    : rates.pretaxRate > 0.0005
      ? `Backed out of your ${money(netPay)} take-home: after the tax a ${money0(salary)} salary owes, ${money(now.per.pretax)} a paycheck (${pct(rates.pretaxRate, 1)} of gross) is left unexplained, so it is treated as taken out before tax: a 401(k), health premiums and the like. The same share is applied to the bonus and to a raise.`
      : rates.taxScale < 0.9995
        ? `Backed out of your ${money(netPay)} take-home: it is higher than the standard estimate (${money(rates.plainNet / freq.n)}), so nothing is assumed to come out before tax and your income tax is taken as ${pct(rates.taxScale)} of the standard figure. The same holds for the bonus and a raise.`
        : `Your ${money(netPay)} take-home matches the standard estimate, so nothing is assumed to come out before tax.`;
  $('inc-split-meta').textContent = rates.calibrated && rates.fit ? 'rates backed out of your take-home' : 'estimate';
  $('inc-split').innerHTML = `<div class="inc-pad">${stackBar(partsOf(y), y.gross, 'Where a year of gross pay goes')}${stackLegend(partsOf(y), y.gross)}</div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Per</th><th class="num">Paycheck</th><th class="num">Year${now.bonusGross > 0 ? ' + bonus' : ''}</th><th class="num">Of gross</th></tr></thead>
    <tbody>${line('Gross pay', 'gross')}${line('Federal income tax', 'federal', INC.federal)}${line('Social Security + Medicare', 'fica', INC.fica)}${line('Virginia income tax', 'virginia', INC.virginia)}${y.pretax > 0.004 ? line('Before-tax deductions', 'pretax', INC.pretax) : ''}</tbody>
    <tfoot>${line('Take-home', 'net', INC.net)}</tfoot></table></div>
    <p class="inc-note">${cal}</p>`;

  // ── What if: a raise ──
  for (const [mode, id] of Object.entries(RAISE_IDS)) {
    fill(id, hasRaise ? tidyNum(mode === 'pct' ? (newSalary / salary - 1) * 100 : mode === 'usd' ? newSalary - salary : newSalary) : '');
  }
  $('inc-raise-salary').placeholder = fmt0(salary);
  $('inc-raise-meta').textContent = hasRaise ? `${money0(salary)} → ${money0(newSalary)}` : 'type a raise, or a new salary';

  const spend = N.monthlySpending(c.allOps, through), spendYr = spend.monthly * 12;
  const share = Math.max(0, Math.min(100, Number(cfg.saveShare ?? 100))) / 100;
  const spendThen = spendYr + (d.net > 0 ? d.net * (1 - share) : 0);
  const sNow = N.savings(now.full, spendYr), sThen = N.savings(then.full, spendThen);

  const up = d.gross >= 0;
  $('inc-raise-bar').innerHTML = hasRaise ? (() => {
    const parts = [
      { name: up ? 'You keep' : 'Take-home lost', v: Math.abs(d.net), color: INC.net },
      { name: 'Before tax', v: Math.abs(d.pretax), color: INC.pretax },
      { name: 'Federal', v: Math.abs(d.federal), color: INC.federal },
      { name: 'Social Security + Medicare', v: Math.abs(d.ss + d.medicare), color: INC.fica },
      { name: 'Virginia', v: Math.abs(d.virginia), color: INC.virginia },
    ];
    const total = Math.abs(d.gross), bonusToo = Math.abs(then.bonusGross - now.bonusGross) > 0.5;
    return `<div class="inc-headline">${up
      ? `Of ${money0(total)} more a year${bonusToo ? ' (the bonus rises with it)' : ''}, you keep <b class="pos">${money0(d.net)}</b>: ${pct(d.net / total)} of it, or <b>${money(then.per.net - now.per.net)}</b> more per paycheck.`
      : `Of ${money0(total)} less a year, take-home falls by <b class="neg">${money0(-d.net)}</b>: ${money(now.per.net - then.per.net)} less per paycheck.`}</div>
      ${stackBar(parts, total, 'Where the change in pay goes')}${stackLegend(parts, total)}`;
  })() : '';

  const chg = (a, b, { rate = false, good = 1 } = {}) => {
    if (!hasRaise) return '<td class="num dim">—</td>';
    const v = b - a;
    if (Math.abs(v) < (rate ? 0.00005 : 0.005)) return '<td class="num dim">=</td>';
    const txt = rate ? `${v > 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)} pts` : (v > 0 ? '+' : '−') + '$' + fmt0(v);
    return `<td class="num ${good ? ((v > 0) === (good > 0) ? 'pos' : 'neg') : ''}">${txt}</td>`;
  };
  const row = (name, a, b, opt = {}) => {
    const f = opt.rate ? v => (v == null ? '—' : pct(v, 1)) : opt.cents ? money : money0;
    return `<tr${opt.cls ? ` class="${opt.cls}"` : ''}><td>${name}</td><td class="num">${f(a)}</td><td class="num${hasRaise ? '' : ' dim'}">${hasRaise ? f(b) : '—'}</td>${a == null || b == null ? '<td class="num dim">—</td>' : chg(a, b, opt)}</tr>`;
  };
  const t = then.full;
  $('inc-raise-table').innerHTML = `<thead><tr><th></th><th class="num">Now</th><th class="num">With the raise</th><th class="num">Change</th></tr></thead><tbody>
    ${row('Salary', salary, then.salary)}
    ${now.bonusGross > 0 || then.bonusGross > 0 ? row(`Bonus, ${month}`, now.bonusGross, then.bonusGross) : ''}
    ${row('Federal income tax', y.federal, t.federal, { good: 0 })}
    ${row('Social Security + Medicare', y.ss + y.medicare, t.ss + t.medicare, { good: 0 })}
    ${row('Virginia income tax', y.virginia, t.virginia, { good: 0 })}
    ${y.pretax > 0.004 ? row('Before-tax deductions', y.pretax, t.pretax, { good: 0 }) : ''}
    ${row('Take-home per year', y.net, t.net, { cls: 'strong' })}
    ${row('Take-home per paycheck', now.per.net, then.per.net, { cents: true })}
    ${now.bonusGross > 0 || then.bonusGross > 0 ? row(`${month} bonus after tax`, now.bonus.net, then.bonus.net) : ''}
    ${row('Kept of gross', y.net / y.gross, t.net / t.gross, { rate: true })}
    ${spend.months ? `
    ${row('Spending per year', spendYr, spendThen, { good: -1, cls: 'sep' })}
    ${row('Left over per year', sNow.left, sThen.left)}
    ${row('Savings rate, of take-home', sNow.ofTakeHome, sThen.ofTakeHome, { rate: true, cls: 'strong' })}
    ${y.pretax > 0.004 ? row('Savings rate, counting before-tax money, of gross', sNow.withPretax, sThen.withPretax, { rate: true }) : ''}` : ''}
  </tbody>`;
  const band = v => pct(v, v * 1000 % 10 ? 2 : 0);
  $('inc-raise-note').innerHTML = (hasRaise
    ? `Federal: ${y.fedMarginal === t.fedMarginal ? `the whole change is taxed in the ${band(t.fedMarginal)} band` : `the change crosses from the ${band(y.fedMarginal)} band into the ${band(t.fedMarginal)} band, and only the part above the line is taxed at the new rate`}. Virginia: ${band(t.vaMarginal)} on every dollar of it. `
    : `Your next dollar of pay is taxed ${band(y.fedMarginal)} by the federal government, ${band(y.vaMarginal)} by Virginia and 7.65% for Social Security and Medicare. `)
    + (spend.months ? `Spending is your average over the last ${spend.months} full month${spend.months === 1 ? '' : 's'} (${money0(spend.monthly)} a month). “Save” is the share of the extra take-home you would keep rather than spend.` : '');

  // ── This year ──
  const lastMonth = Number(through.slice(5, 7));
  $('inc-year-meta').textContent = `${year} · through ${shortDate(DATA_LAST)}`;
  $('inc-year-legend').innerHTML = `<span><i style="background:${C.ink3}"></i>Plan</span><span><i style="background:${C.in}"></i>Received</span>`;
  chart('inc-year-chart', {
    type: 'bar',
    data: { labels: tr.months.map(m => monthName(m.ym)), datasets: [
      { label: 'Plan', data: tr.months.map(m => A.round2(m.expected)), backgroundColor: 'rgba(122,122,122,0.45)', borderColor: C.ink3, borderWidth: 1, maxBarThickness: 22 },
      { label: 'Received', data: tr.months.map((m, i) => (i < lastMonth ? A.round2(m.actual) : null)), backgroundColor: C.in, maxBarThickness: 22 },
    ] },
    options: { ...hoverLine,
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        title: x => MONTH_NAMES[x[0].dataIndex],
        label: x => ` ${x.dataset.label}  ${money(x.parsed.y)}`,
        footer: x => { const m = tr.months[x[0].dataIndex]; return `${m.paychecks} payday${m.paychecks === 1 ? '' : 's'}${m.bonus ? ' + bonus' : ''}`; } } } },
      scales: { x: xPlain(), y: { ...yMoney, beginAtZero: true } }, datasets: { bar: { categoryPercentage: 0.7, barPercentage: 0.85 } } },
  });
  const bm = tr.months[(cfg.bonusMonth || 3) - 1];
  const extra = bm ? bm.actual - bm.paychecks * now.per.net : 0;
  $('inc-year-sum').innerHTML = `
    <div class="sum-row"><span>Plan through ${shortDate(DATA_LAST)}</span><span class="amt">${money(tr.expectedToDate)}</span></div>
    <div class="sum-row"><span>Received from ${salarySrc.length ? esc(salarySrc.slice(0, 2).map(x => x.name).join(', ')) + (salarySrc.length > 2 ? ` +${salarySrc.length - 2}` : '') : 'salary sources'}</span><span class="amt">${money(tr.actual)}</span></div>
    <div class="sum-row total"><span>${gap >= 0 ? 'Ahead of plan' : 'Behind plan'}</span><span class="amt ${gap >= 0 ? 'pos' : 'neg'}">${signed(gap)}</span></div>
    <div class="sum-row"><span>Next payday</span><span class="amt">${tr.next ? shortDate(A.localTs(tr.next)) : `${year + 1}`}</span></div>
    ${now.bonusGross > 0 ? `<div class="sum-row"><span>${month} bonus</span><span class="amt">${money0(now.bonus.net)} planned${lastMonth >= (cfg.bonusMonth || 3) ? ` · ${extra > 1 ? `${money0(extra)} arrived beyond paychecks` : 'none seen in deposits'}` : ''}</span></div>` : ''}
    <div class="sum-row"><span>Plan for all of ${year}</span><span class="amt">${money(tr.expected)}</span></div>
    <p class="note" style="margin:10px 0 0">The plan is today's take-home on every payday of ${year}. If your pay changed during the year, the months before the change will sit above or below it. Received counts only sources marked Salary on the <button class="link-btn" data-goto="income">Sources</button> tab; side income and reimbursements are left out.</p>`;

  // ── Virginia ──
  const va = T.virginiaBands(y.vaTaxable), vaThen = T.virginiaBands(t.vaTaxable);
  const bandName = b => (b.from === 0 ? `First ${money0(b.to)}` : b.to === Infinity ? `Over ${money0(b.from)}` : `${money0(b.from)} – ${money0(b.to)}`);
  const vaDed = T.VIRGINIA.deduction[cfg.filing] + T.VIRGINIA.exemption * T.VIRGINIA.exemptions[cfg.filing];
  $('inc-va-meta').textContent = `${pct(y.virginia / y.gross, 2)} of gross`;
  $('inc-va').innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>Taxable income</th><th class="num">Rate</th><th class="num">Tax now</th>${hasRaise ? '<th class="num">With the raise</th>' : ''}</tr></thead>
    <tbody>${va.map((b, i) => `<tr><td>${bandName(b)}</td><td class="num">${band(b.rate)}</td><td class="num">${money(b.tax * rates.taxScale)}</td>${hasRaise ? `<td class="num">${money(vaThen[i].tax * rates.taxScale)}</td>` : ''}</tr>`).join('')}</tbody>
    <tfoot><tr><td>Virginia tax</td><td></td><td class="num">${money(y.virginia)}</td>${hasRaise ? `<td class="num">${money(t.virginia)}</td>` : ''}</tr></tfoot></table></div>
    <p class="inc-note">Virginia taxes ${money0(y.vaTaxable)} of your ${money0(y.gross)}: gross pay${y.pretax > 0.004 ? `, less ${money0(y.pretax)} taken out before tax,` : ''} less the ${money0(T.VIRGINIA.deduction[cfg.filing])} standard deduction and ${money0(vaDed - T.VIRGINIA.deduction[cfg.filing])} in personal exemptions.
    ${y.vaTaxable > 17000 ? `Everything past ${money0(17000)} is in the top band, so ${hasRaise ? `the raise adds <b>${money0(t.virginia - y.virginia)}</b> of Virginia tax, ${band(0.0575)} of its taxable part` : `a raise is taxed ${band(0.0575)} by Virginia on every taxable dollar`}.` : ''}
    ${rates.calibrated && rates.fit && rates.taxScale < 0.9995 ? `Scaled to ${pct(rates.taxScale)} of the schedule, to match your take-home.` : ''}</p>`;
}

// Reads the form into a config. `raiseMode` is whichever raise box was typed in last.
let raiseMode = null;
function readIncome() {
  const num = id => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
  const cfg = { ...incSaved(), ...(incDraft || {}) };
  cfg.salary = Math.max(0, num('inc-salary') || 0);
  cfg.freq = $('inc-freq').value;
  cfg.bonus = Math.max(0, num('inc-bonus') || 0);
  cfg.bonusUnit = $('inc-bonus-unit').value;
  cfg.bonusMonth = Number($('inc-bonus-month').value) || 3;
  cfg.filing = $('inc-filing').value;
  cfg.netPay = num('inc-net') > 0 ? num('inc-net') : null;
  cfg.saveShare = Math.max(0, Math.min(100, num('inc-save-share') ?? 100));
  if (raiseMode) {
    const v = num(RAISE_IDS[raiseMode]);
    cfg.raise = v == null || (raiseMode !== 'salary' && v === 0) ? null : { mode: raiseMode, value: v };
  }
  return cfg;
}
async function saveIncome(cfg) {
  incDraft = null;
  state.settings.income = cfg;
  await commit();
  renderIncome(CTX);
}
const incomeView = document.querySelector('.view[data-view="salary"]');
incomeView.addEventListener('input', ev => {
  if (!ev.target.matches('input, select')) return;
  if (ev.target.dataset.raise) raiseMode = ev.target.dataset.raise;
  incDraft = readIncome();
  renderIncome(CTX);
});
incomeView.addEventListener('change', ev => { if (ev.target.matches('input, select')) saveIncome(readIncome()); });
incomeView.addEventListener('submit', ev => ev.preventDefault());
incomeView.addEventListener('click', ev => {
  if (ev.target.closest('#inc-raise-clear')) { raiseMode = null; saveIncome({ ...incSaved(), raise: null }); }
  else if (ev.target.closest('#inc-net-auto')) saveIncome({ ...incSaved(), netPay: null });
  else if (ev.target.closest('#inc-freq-fix')) saveIncome({ ...incSaved(), freq: ev.target.closest('#inc-freq-fix').dataset.freq });
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
  // An embedded web view ignores download links; Android's own save screen is
  // shown instead.
  if (native.isNative()) {
    blob.text().then(text => native.saveFile(name, blob.type || 'application/octet-stream', text))
      .then(saved => { if (saved) toast(`Saved ${name}.`); }, e => toast(e.message, true));
    return;
  }
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
      ${t.paid_back ? `<dt>Counted</dt><dd>Paid back to you: taken off total spending, not counted as income. If you know what it was for, change its category (just this amount) and it comes off that category instead. If it really is income, type its source on the <button class="link-btn" data-goto="income">Income</button> tab.</dd>`
        : t.refund ? `<dt>Counted</dt><dd>Refund: taken off ${esc(t.category)} spending, not counted as income.</dd>` : ''}
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
    ...Object.entries(VIEWS).map(([k, label]) => ({ kind: 'View', label: PARENT[k] ? `${VIEWS[PARENT[k]]}: ${label}` : label, run: () => setView(k) })),
    ...[['30', 'Last month'], ['90', 'Last 3 months'], ['180', 'Last 6 months'], ['ytd', 'Year to date'], ['365', 'Last year'], ['0', 'All time']]
      .map(([k, label]) => ({ kind: 'Period', label, run: () => applyPreset(k) })),
    { kind: 'Action', label: 'Refresh data (add CSV files)', run: () => setView('accounts') },
    ...(state.plaid && plaidItems().length && !demo ? [{ kind: 'Action', label: 'Sync bank connections', run: () => plaidSync() }] : []),
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
  const v = NAV_KEYS[Number(ev.key) - 1];
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
    settings: { cc_start: 0, budgets: { Groceries: 650, Dining: 320, Shopping: 300, Subscriptions: 45, Transportation: 160, Entertainment: 120, 'Utilities & Bills': 200 },
      income: { salary: 112000, freq: 'biweekly', bonus: 8500, bonusUnit: 'usd', bonusMonth: 3, filing: 'single', netPay: null, raise: { mode: 'pct', value: 5 }, saveShare: 100 } },
    sync: null, plaid: null, meta: { updatedAt: 0, rulesUpdatedAt: 0 },
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
    state.transactions = settle(merged);
    await commit();
    store.requestPersistence();
    showView();
  } else if (wasDemo) showView();
  if ($('refresh-overlay').classList.contains('open') || view === 'accounts') renderRefresh();
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
  // Every file is read and judged by its contents: a phone's file app may hand
  // over a CSV with no extension or a generic type. Anything that is not a
  // Capital One export is named in the message and left out.
  const files = [...fileList].filter(f => f.size <= 25 * 1024 * 1024);
  if (!files.length) { toast('Choose one or more Capital One .csv exports.', true); return; }
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

// Per account: newest and oldest day, row count, and the latest balance
// (bank accounts; ALL_TXN is newest first, so the first balance seen is it).
function accountFacts() {
  const facts = new Map();
  for (const t of state.transactions) {
    let f = facts.get(t.account);
    if (!f) facts.set(t.account, f = { last: t.date, first: t.date, n: 0, balance: null, kind: t.kind });
    if (t.date > f.last) f.last = t.date;
    if (t.date < f.first) f.first = t.date;
    f.n++;
  }
  for (const t of ALL_TXN) { const f = facts.get(t.account); if (f && f.balance == null && t.balance != null) f.balance = t.balance; }
  return facts;
}

function renderRefresh() {
  renderPlaid();
  const facts = accountFacts();
  $('rf-accounts-sec').hidden = !facts.size;
  let oldest = null;
  $('rf-accounts').innerHTML = [...facts].sort((a, b) => a[0].localeCompare(b[0])).map(([acct, f]) => {
    const ts = A.localTs(f.last), age = dataAge(ts), from = addDays(ts, -OVERLAP);
    if (oldest == null || from < oldest) oldest = from;
    const url = acctLink(acct);
    const action = demo ? '<span></span>' : linkEdit === acct
      ? `<form class="rf-link-form" data-acct="${esc(acct)}"><input class="set-input" type="text" inputmode="url" placeholder="Paste any page address of this account from Capital One" value="${esc(url || '')}" aria-label="Capital One page for ${esc(acct)}" /><button class="btn small primary">Save</button><button type="button" class="btn small" data-link-cancel>Cancel</button></form>`
      : url ? `<span class="rf-go"><a class="btn small primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Download ↗</a><button class="link-btn" data-link-edit="${esc(acct)}">edit</button></span>`
      : `<button class="btn small" data-link-edit="${esc(acct)}">Add link</button>`;
    const since = new Date(A.localTs(f.first)).toLocaleString('en-US', { month: 'short', year: 'numeric' });
    const owed = state.settings.plaid?.cards?.[acct]?.balance;
    return `<div class="rf-acct"><span class="rf-name"><b>${esc(acct)}</b><small>${f.balance != null ? `${money(f.balance)} · ` : typeof owed === 'number' ? `${money(owed)} owed · ` : ''}${f.n.toLocaleString()} transaction${f.n === 1 ? '' : 's'} since ${since}</small></span>
      <span>through ${shortDate(ts)}<small>${periodAdvice(age, from)}</small></span>
      <span class="tag ${age >= 21 ? 'over' : age >= 7 ? 'near' : 'ok'}">${age === 0 ? 'TODAY' : `${age}D BEHIND`}</span>${action}</div>`;
  }).join('');
  const linked = demo ? [] : [...facts.keys()].filter(acctLink);
  $('rf-open-all').hidden = linked.length < 2;
  $('rf-open-all').textContent = `Open all ${linked.length} ↗`;
  $('rf-open-home').classList.toggle('primary', !linked.length);
  $('rf-link-note').hidden = demo || !facts.size || linked.length === facts.size;
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
  $('rf-watch-title').textContent = native.isNative() ? 'On this phone: pick the download' : isAndroid ? 'On this phone: share the download to the app' : 'Or skip step 2: watch a folder';
  if (native.isNative()) {
    el.innerHTML = '<p>Chrome keeps its downloads where other apps cannot look, so after pressing <b>Download</b> on Capital One, come back here, tap <b>Drop CSV files here, or tap to choose</b> above and find the CSV under <b>Downloads</b>. With a bank connected, none of this is needed.</p>';
    return;
  }
  if (isAndroid) {
    const installed = isStandalone();
    el.innerHTML = `<p>Chrome on Android keeps downloads in its own private folder, which other apps cannot look into, so the app cannot pick them up by itself, and the file chooser above may not show them. Chrome can hand them over:</p>
      <ol class="phone-steps">
        ${installed ? '' : '<li><span><b>Install this app</b> first (button below). Only an installed app appears in the Share menu.</span></li>'}
        <li><span>After pressing <b>Download</b> on Capital One, open Chrome's menu <b>⋮ → Downloads</b>.</span></li>
        <li><span>Press and hold the CSV (tap any others to select them too), then tap <b>Share</b>.</span></li>
        <li><span>Choose <b>FinanceTracker</b>. The app opens and imports them.</span></li>
      </ol>
      ${installed ? '' : '<div class="set-row"><button class="btn" id="rf-install">Install app</button></div>'}`;
    return;
  }
  if (!watch.supported) {
    el.innerHTML = `<p>In Chrome or Edge on a computer, this app can watch the folder your downloads land in and import new exports by itself. This browser does not offer that.</p>`;
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

// One block of controls, two homes: the Accounts view, or the sheet when
// there is no data yet and so no dashboard to show it in.
function placeRefresh() {
  const home = $('dashboard').hidden ? $('refresh-sheet-body') : $('acct-slot');
  if ($('refresh-block').parentElement === home) return;
  home.appendChild($('refresh-block'));
  if (home === $('acct-slot')) closeRefresh(); // its contents just left the sheet
}

function renderAccounts() {
  const facts = accountFacts();
  const bank = [...facts.values()].filter(f => f.balance != null).reduce((s, f) => s + f.balance, 0);
  const behind = Math.max(0, ...[...facts.values()].map(f => dataAge(A.localTs(f.last))));
  const owed = BALANCE.length ? BALANCE[BALANCE.length - 1].cc_outstanding : null;
  const hasCard = [...facts.values()].some(f => f.kind === 'credit_card');
  setKpis('acct-kpis', [
    kpiTile({ label: 'In the bank', value: money0(bank), sub: 'checking + savings, latest balances' }),
    ...(hasCard && owed != null ? [kpiTile({ label: 'Card balance', value: money0(owed), sub: [...facts].every(([a, f]) => f.kind !== 'credit_card' || typeof state.settings.plaid?.cards?.[a]?.balance === 'number') ? 'from your bank connection' : 'estimated; set the start in Settings' })] : []),
    kpiTile({ label: 'Furthest behind', value: `${behind}<small> days</small>`, tone: behind >= 21 ? 'neg' : '', sub: behind > DEFAULT_PERIOD - OVERLAP ? 'needs a longer Time Period' : 'Last 30 Days covers it' }),
    kpiTile({ label: 'Saved', value: state.transactions.length.toLocaleString(), sub: `transactions in ${facts.size} account${facts.size === 1 ? '' : 's'}` }),
  ]);
  $('acct-meta').textContent = demo ? 'demo accounts' : 'stored on this device';
  renderRefresh();
}

function openRefresh() {
  if (!$('dashboard').hidden) { setView('accounts'); return; }
  renderRefresh(); refreshOverlay.classList.add('open');
}
function closeRefresh() { refreshOverlay.classList.remove('open'); linkEdit = null; }
$('refresh-open').addEventListener('click', async () => {
  // One click wakes the folder and imports; the sheet only opens if that found nothing to do.
  if ($('refresh-open').dataset.asleep) { await watchScan({ ask: true }); if (watchState === 'granted') return; }
  openRefresh();
});
$('asof').addEventListener('click', openRefresh);
document.addEventListener('click', ev => { if (ev.target.closest('#rf-install')) openInstall(); });
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

// ── Bank connection (Plaid) ──────────────────────────────────────────────────
// How Plaid is reached (your Plaid keys, or a relay's address and key) is kept
// on this device only (state.plaid). The linked banks live in settings, so
// they sync: a second device needs only the same keys to fetch from them.
const PLAID_GUIDE = 'https://github.com/jsandhagen/FinanceTracker/blob/main/server/README.md';
const ANDROID_GUIDE = 'https://github.com/jsandhagen/FinanceTracker/blob/main/android/README.md';
let appId = ''; // the Android package name, in the Android app
const PLAID_EVERY = 3 * 60 * 60 * 1000; // banks post new transactions a few times a day
let plaidBusy = false;
let plaidMode = 'direct'; // which set-up form is showing
const plaidItems = () => state.settings.plaid?.items || [];
// What every merge of transactions goes through before it is saved.
const settle = list => P.tidy(A.repairStored(list), state.settings.plaid);
const ago = ts => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 2 ? 'just now' : m < 90 ? `${m} min ago` : m < 36 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

function renderPlaid(status = '') {
  const el = $('plaid-body'), items = plaidItems();
  if (demo) { el.innerHTML = '<p>Bank connections are switched off in the demo.</p>'; return; }
  if (!state.plaid && state.plaidError) {
    el.innerHTML = `<p>${esc(state.plaidError.message)} This can happen just after the phone restarts. Nothing has been deleted.</p>
      <div class="set-row"><button class="btn primary" id="plaid-retry">Try again</button></div>
      <div class="set-status" id="plaid-status">${esc(status)}</div>`;
    return;
  }
  if (!state.plaid) {
    const onDevice = native.isNative();
    const again = items.length ? `${items.length === 1 ? 'A bank connection was' : `${items.length} bank connections were`} set up on another device${onDevice ? '' : ', and what it fetches arrives here through sync'}. Enter the same details here to fetch from ${items.length === 1 ? 'it' : 'them'} too${onDevice ? '' : ' (from a web page that needs a relay)'}. ` : '';
    el.innerHTML = plaidMode === 'direct' || onDevice
      ? `<p>${again}With a Plaid account the app fetches new transactions from your bank by itself: nothing to download. Enter your Plaid keys (Plaid dashboard → Developers → Keys). They are ${onDevice ? 'encrypted with a key held in the Android Keystore and kept through every update; with sync on, they are also in your encrypted sync copy, so a reinstall gets them back. They are never in a backup file' : 'kept on this device only, never synced and never in a backup'}, and are sent to Plaid and nowhere else.</p>
      <form class="plaid-form" id="plaid-form">
        <input class="set-input" id="plaid-client" type="text" placeholder="Plaid client_id" autocomplete="off" spellcheck="false" />
        <input class="set-input" id="plaid-secret" type="password" placeholder="Plaid secret" autocomplete="off" />
        <select class="select" id="plaid-env" aria-label="Plaid environment"><option value="production">Production</option><option value="sandbox">Sandbox</option></select>
        <button class="btn primary">Save</button>
      </form>
      <div class="set-status" id="plaid-status">${esc(status)}</div>
      <p style="margin-top:10px">${onDevice
    ? `Save tests the keys. Before connecting a bank, register this app's package name, <b>${esc(appId || 'shown here once the app has loaded')}</b>, in the Plaid dashboard under Developers → API → Allowed Android package names. <a href="${ANDROID_GUIDE}" target="_blank" rel="noopener">Set-up steps</a>.`
    : `Save tests the connection. If the browser is not allowed to reach Plaid from a web page, it says so. The ways in are then <a href="${ANDROID_GUIDE}" target="_blank" rel="noopener">the Android app</a>, which calls Plaid itself and passes what it fetches to this device through sync, or <button class="link-btn" data-plaid-mode="relay">a relay</button>.`}</p>`
      : `<p>${again}A relay is a small program you host (free on Cloudflare) that holds your Plaid keys and calls Plaid for the app. It is only needed if the direct connection is refused. <a href="${PLAID_GUIDE}" target="_blank" rel="noopener">Set-up steps</a>.</p>
      <form class="plaid-form" id="plaid-form">
        <input class="set-input" id="plaid-url" type="text" inputmode="url" placeholder="Relay address (https://….workers.dev)" autocomplete="off" spellcheck="false" />
        <input class="set-input" id="plaid-key" type="password" placeholder="Access key (the APP_KEY you chose)" autocomplete="off" />
        <button class="btn primary">Save</button>
      </form>
      <div class="set-status" id="plaid-status">${esc(status)}</div>
      <p style="margin-top:10px"><button class="link-btn" data-plaid-mode="direct">Back to connecting directly</button></p>`;
    return;
  }
  const rows = items.map(it => {
    const broken = it.error?.code === 'ITEM_LOGIN_REQUIRED' || it.error?.code === 'BAD_ITEM';
    const accts = (it.accounts || []).map(a => a.account.replace(' ...', ' ')).join(', ');
    return `<div class="rf-acct"><span class="rf-name"><b>${esc(it.name)}</b><small>${esc(accts || 'accounts appear after the first sync')}</small></span>
      <span>${it.lastSync ? `synced ${ago(it.lastSync)}` : 'not synced yet'}<small>${it.error ? esc(it.error.code === 'ITEM_LOGIN_REQUIRED' ? 'The bank wants you to sign in again.' : it.error.message) : 'checked when the app opens'}</small></span>
      <span class="tag ${it.error ? 'over' : 'ok'}">${it.error ? (broken ? 'RECONNECT' : 'FAILED') : 'LINKED'}</span>
      <span class="rf-go">${it.error?.code === 'ITEM_LOGIN_REQUIRED' ? `<button class="btn small primary" data-plaid-fix="${esc(it.id)}">Sign in</button>` : ''}<button class="link-btn" data-plaid-remove="${esc(it.id)}">remove</button></span></div>`;
  }).join('');
  el.innerHTML = `${rows ? `<div class="rf-accounts">${rows}</div>` : `<p>${state.plaid.mode === 'direct' ? 'Connected to Plaid directly.' : 'The relay is set up.'} Connect a bank and its transactions arrive here, then keep arriving.</p>`}
    <div class="set-row">
      ${items.length ? `<button class="btn primary" id="plaid-sync"${plaidBusy ? ' disabled' : ''}>${plaidBusy ? 'Syncing…' : 'Sync now'}</button>` : ''}
      <button class="btn${items.length ? '' : ' primary'}" id="plaid-add"${plaidBusy ? ' disabled' : ''}>Connect ${items.length ? 'another' : 'a'} bank</button>
      <button class="btn" id="plaid-forget">Forget the ${state.plaid.mode === 'direct' ? 'Plaid keys' : 'relay'} on this device</button>
      <span class="set-status" id="plaid-status">${esc(status)}</span>
    </div>
    ${items.length ? '<p style="margin-top:10px">CSV exports still work alongside this. A transaction that arrives both ways is kept once.</p>' : ''}`;
}

// Fetches what is new from every linked bank and folds it in.
async function plaidSync({ quiet = false } = {}) {
  const ps = state.settings.plaid;
  if (!state.plaid || demo || plaidBusy || !ps?.items.length) return 0;
  plaidBusy = true;
  renderPlaid();
  const before = new Set(state.transactions.map(t => t.id));
  let list = state.transactions, failed = null, got = false;
  for (const item of ps.items) {
    try {
      list = P.applySync(list, ps, item, await P.call(state.plaid, 'sync', { item: item.sealed, cursor: item.cursor }));
      got = true;
    } catch (e) {
      item.error = { code: e.code, message: e.message };
      failed = item;
    }
  }
  plaidBusy = false;
  if (demo) return 0; // the demo was opened while this was in flight
  const settled = settle(list);
  const added = settled.filter(t => !before.has(t.id)).length;
  const changed = settled !== state.transactions;
  state.transactions = settled;
  if (got || failed) await commit();
  if (changed) { store.requestPersistence(); showView(); }
  if (refreshOverlay.classList.contains('open') || view === 'accounts') renderRefresh();
  if (failed && !quiet) toast(`${failed.name}: ${failed.error.code === 'ITEM_LOGIN_REQUIRED' ? 'the bank wants you to sign in again. Open Accounts to do it.' : failed.error.message}`, true);
  else if (added) toast(`Bank sync: ${added.toLocaleString()} new transaction${added === 1 ? '' : 's'}.`);
  else if (!quiet && got) toast('Bank sync: nothing new.');
  return added;
}
function plaidAuto() {
  const items = plaidItems();
  if (!state?.plaid || demo || !items.length || document.visibilityState !== 'visible') return;
  if (Date.now() - Math.min(...items.map(it => it.lastSync || 0)) > PLAID_EVERY) plaidSync({ quiet: true });
}
document.addEventListener('visibilitychange', plaidAuto);

// Opens Plaid's sign-in window. `item` repairs that connection; without it a
// new bank is added. Banks that sign in on their own site send the browser
// away and back, so the token is set aside for the return trip (resumeLink).
const LINK_KEY = 'ft-plaid-link';
async function plaidLink(item = null) {
  if (!state.plaid || plaidBusy) return;
  const here = location.origin + location.pathname;
  const ask = body => P.call(state.plaid, 'link-token', { ...body, ...(item ? { item: item.sealed } : {}) });
  try {
    let token;
    // In the Android app the bank comes back by package name, and Plaid's SDK
    // sees the whole sign-in through: there is no return trip to resume.
    if (native.isNative()) {
      token = (await ask({ android_package_name: await native.packageName() })).link_token;
      await finishLink(await P.openLink(token), item);
      return;
    }
    try { token = (await ask({ redirect_uri: here })).link_token; }
    catch (e) {
      // The return address has to be listed in the Plaid dashboard. Until it
      // is, Link still works for banks that sign in inside its own window.
      if (!/redirect/i.test(e.message)) throw e;
      token = (await ask({})).link_token;
    }
    try { localStorage.setItem(LINK_KEY, JSON.stringify({ token, item: item?.id || null, at: Date.now() })); } catch {}
    await finishLink(await P.openLink(token), item);
  } catch (e) {
    toast(e.message, true);
  }
}
async function finishLink(done, item) {
  try { localStorage.removeItem(LINK_KEY); } catch {}
  if (!done) return;
  if (item) item.error = null;
  else {
    const r = await P.call(state.plaid, 'exchange', { public_token: done.public_token });
    const ps = state.settings.plaid || (state.settings.plaid = P.emptyState());
    ps.items = ps.items.filter(it => it.id !== r.item_id).concat({ id: r.item_id, sealed: r.item, name: done.institution, cursor: null, accounts: [], lastSync: 0, error: null });
  }
  await commit();
  const n = await plaidSync({ quiet: true });
  if (!n && !item) {
    // A bank takes a minute or two to hand its history to Plaid.
    toast(`${done.institution} is connected. Its history is still on the way and will appear here by itself.`);
    for (const wait of [20000, 60000, 180000]) setTimeout(() => { if (!plaidItems().some(it => it.accounts?.length && state.transactions.some(P.isPlaid))) plaidSync({ quiet: true }); }, wait);
  }
  renderRefresh();
}
// Back from signing in on the bank's own site.
async function resumeLink() {
  if (!new URLSearchParams(location.search).has('oauth_state_id')) return;
  const back = location.href;
  history.replaceState(history.state, '', location.pathname + location.hash);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LINK_KEY)); } catch {}
  if (!saved || !state.plaid || Date.now() - saved.at > 30 * 60 * 1000) return;
  try { await finishLink(await P.openLink(saved.token, back), plaidItems().find(it => it.id === saved.item) || null); }
  catch (e) { toast(e.message, true); }
}

$('plaid-body').addEventListener('submit', async ev => {
  ev.preventDefault();
  const say = msg => { $('plaid-status').textContent = msg; };
  let conn;
  if (plaidMode === 'direct') {
    conn = { mode: 'direct', clientId: $('plaid-client').value.trim(), secret: $('plaid-secret').value.trim(), env: $('plaid-env').value };
    if (!conn.clientId || !conn.secret) { say('Enter both the client_id and the secret from the Plaid dashboard.'); return; }
  } else {
    conn = { url: P.cleanRelay($('plaid-url').value), key: $('plaid-key').value.trim() };
    if (!conn.url) { say('Enter the relay address, starting with https://'); return; }
    if (conn.key.length < 16) { say('Enter the access key: the APP_KEY set on the relay, at least 16 characters.'); return; }
  }
  say('Checking…');
  try { await P.call(conn, 'link-token', {}); }
  catch (e) { say(e.message); return; }
  try { await store.setPlaid(conn); }
  catch (e) { say(e.message); return; }
  state.plaid = conn;
  renderPlaid();
  if (plaidItems().length) plaidSync();
});
$('plaid-body').addEventListener('click', async ev => {
  const fix = ev.target.closest('[data-plaid-fix]'), rm = ev.target.closest('[data-plaid-remove]'), mode = ev.target.closest('[data-plaid-mode]');
  if (mode) { plaidMode = mode.dataset.plaidMode; renderPlaid(); }
  else if (ev.target.closest('#plaid-sync')) plaidSync();
  else if (ev.target.closest('#plaid-retry')) {
    try { state.plaid = await store.getPlaid(); state.plaidError = null; }
    catch (e) { state.plaidError = e; renderPlaid('Still could not read them. Close the app completely and open it again.'); return; }
    renderPlaid();
    if (state.plaid && plaidItems().length) plaidSync();
  }
  else if (ev.target.closest('#plaid-add')) plaidLink();
  else if (fix) plaidLink(plaidItems().find(it => it.id === fix.dataset.plaidFix));
  else if (rm) {
    const item = plaidItems().find(it => it.id === rm.dataset.plaidRemove);
    if (!item || !confirm(`Disconnect ${item.name}? This ends the connection at Plaid for every device. Transactions already here are kept.`)) return;
    try { await P.call(state.plaid, 'remove', { item: item.sealed }); }
    catch (e) { if (e.code !== 'BAD_ITEM' && !confirm(`${e.message}\n\nRemove it from the app anyway? If the connection is still live at Plaid you can end it in the Plaid dashboard.`)) return; }
    state.settings.plaid.items = plaidItems().filter(it => it !== item);
    await commit();
    renderRefresh();
  } else if (ev.target.closest('#plaid-forget')) {
    if (!confirm('Forget these connection details on this device? Linked banks stay linked; enter the details again to resume.')) return;
    state.plaid = null;
    await store.delPlaid();
    renderPlaid();
  }
});
$('welcome-bank').addEventListener('click', () => { openRefresh(); $('plaid-sec').scrollIntoView({ block: 'start' }); });

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
  $('app-version').innerHTML = esc(BUILD.startsWith('__')
    ? 'Development copy (not deployed)'
    : `Version ${BUILD.split('-')[0]}, ${native.isNative() ? 'built' : 'deployed'} ${BUILD.split('-')[1].replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3 $4:$5 UTC')}`)
    + (appNewer ? ` · <b>a newer build is ready</b> (${esc(appNewer.versionName.split('-')[0])}) <button class="btn small primary" data-app-update>Update</button>` : '');
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
// What sync carries beyond a backup: the Android app's Plaid keys, so that a
// reinstall (which loses the Keystore) gets them back. Only inside the
// passphrase-encrypted sync copy, never in a backup file, and only taken up by
// the Android app; a browser leaves them where they are.
const syncSecrets = () => (native.isNative() && state.plaid ? { secrets: { plaid: state.plaid } } : {});

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
  state.transactions = settle(state.transactions);
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
  if (state.plaid && plaidItems().length && confirm('Also end your bank connections at Plaid? Cancel keeps them, so your other devices keep fetching.')) {
    for (const it of plaidItems()) { try { await P.call(state.plaid, 'remove', { item: it.sealed }); } catch (e) { toast(e.message, true); } }
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
    if (remote) { Object.assign(state, sync.merge(state, remote)); state.transactions = settle(state.transactions); }
    const changedLocally = state.transactions.length !== beforeCount
      || state.meta.rulesUpdatedAt !== beforeRules
      || JSON.stringify(state.settings) !== beforeSettings;

    const remoteUpToDate = remote
      && remote.transactions.length === state.transactions.length
      && (remote.meta?.rulesUpdatedAt || 0) === state.meta.rulesUpdatedAt
      && (remote.meta?.updatedAt || 0) === state.meta.updatedAt;
    // Keys from another install of the app fill in missing ones here; they
    // never replace keys this device has, nor ones it cannot read right now.
    const theirs = remote?.secrets?.plaid;
    if (native.isNative() && theirs && !state.plaid && !state.plaidError) {
      await store.setPlaid(theirs);
      state.plaid = theirs;
      renderPlaid();
    }
    const secretsSynced = !native.isNative() || !state.plaid || JSON.stringify(theirs) === JSON.stringify(state.plaid);
    if (!remoteUpToDate || !secretsSynced) gistId = await sync.push(token, gistId, passphrase, { ...snapshot(), ...(native.isNative() ? syncSecrets() : remote?.secrets ? { secrets: remote.secrets } : {}) });

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
const isStandalone = () => native.isNative() || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
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
  if (location.hash === '#install') history.replaceState(history.state, '', location.pathname + location.search);
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
  if (h === 'install') openInstall(); else if (VIEWS[h] && h !== view) setView(h, { push: false });
});

// ── Back button ──────────────────────────────────────────────────────────────
// Back closes whatever is open (a sheet, the drawer, a menu, the palette), then
// steps back through the views that were visited, and only leaves the app
// from the first one. An open layer is one history entry, added when the first
// layer opens and taken back when the last one closes, however it was closed.
const layerOpen = () => !!document.querySelector('.overlay.open') || picker.classList.contains('open');
function closeLayers() {
  for (const el of document.querySelectorAll('.overlay.open')) el.classList.remove('open');
  closePicker();
  linkEdit = null;
  if (location.hash === '#install') history.replaceState(history.state, '', location.pathname + location.search);
}
new MutationObserver(() => {
  const open = layerOpen();
  if (open && !history.state?.layer) history.pushState({ view, layer: true }, '', location.href);
  else if (!open && history.state?.layer) history.back();
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });

window.addEventListener('popstate', ev => {
  if (layerOpen()) { closeLayers(); return; }
  const v = ev.state?.view || location.hash.slice(1);
  if (VIEWS[v] && v !== view && !$('dashboard').hidden) setView(v, { push: false });
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
  return syncing || plaidBusy
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

// ── Updating the Android app ─────────────────────────────────────────────────
// The app looks at its GitHub release when it opens and every few hours. A
// newer build is offered, never forced: Update downloads it and Android's own
// installer asks to confirm. It installs only over an app signed with the same
// key, and keeps the data.
const APP_CHECK_MS = 6 * 60 * 60 * 1000;
let appNewer = null, appChecked = 0;
async function checkAppUpdate({ quiet = true } = {}) {
  if (!native.isNative()) return;
  appChecked = Date.now();
  let res;
  try { res = await native.update.check(); }
  catch (e) { if (!quiet) toast(`Couldn't check for updates: ${e.message}`, true); return; }
  appNewer = res.newer;
  if (settingsOverlay.classList.contains('open')) renderSettings();
  if (appNewer) offerAppUpdate();
  else if (!quiet) toast("You're on the latest version.");
}
function offerAppUpdate() {
  const el = $('toast');
  el.innerHTML = `A new version of the app is ready. <button class="link-btn" data-app-update>Update</button>`;
  el.classList.remove('err');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 15000);
}
async function installAppUpdate() {
  if (!appNewer) return;
  try {
    const info = await native.update.info();
    if (!info.canInstall) {
      // Asked once: Android lists FinanceTracker under "Install unknown apps".
      if (!confirm('Android needs your go-ahead, once, for FinanceTracker to install its own updates. Open that setting now? Turn on "Allow from this source", come back and tap Update again.')) return;
      await native.update.allowInstalls();
      return;
    }
    // Updates keep everything; a fresh sync copy first all the same.
    if (state.sync) await syncNow({ quiet: true });
    toast('Downloading the update…');
    await native.update.install(appNewer.url);
  } catch (e) {
    toast(e.message, true);
  }
}
document.addEventListener('click', ev => { if (ev.target.closest('[data-app-update]')) installAppUpdate(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - appChecked > APP_CHECK_MS) checkAppUpdate();
});

$('check-update').addEventListener('click', async () => {
  if (native.isNative()) { checkAppUpdate({ quiet: false }); return; }
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
  // The Android app carries its files inside the APK: nothing to cache or update.
  if (native.isNative() || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
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
  // Chrome on Android lists only the apps that declare the requested file type,
  // and Samsung My Files (among others) does not declare CSV. Asking for any
  // file lets every file app offer itself; importFiles sorts out the rest.
  if (isAndroid) for (const id of ['file-input', 'add-input']) $(id).removeAttribute('accept');
  state = await store.loadAll();
  if (native.isNative()) { appId = await native.packageName().catch(() => ''); checkAppUpdate(); }
  const healed = settle(state.transactions);
  if (healed !== state.transactions) { state.transactions = healed; await store.set('transactions', healed); }
  await watch.load().catch(() => null);
  if (VIEWS[location.hash.slice(1)]) view = location.hash.slice(1);
  showView();
  history.replaceState({ view }, '', location.href);
  updateInstallButtons();
  if (location.hash === '#install') openInstall();
  if (state.sync) { setDot('ok'); lastAutoSync = Date.now(); syncNow({ quiet: true }); }
  registerServiceWorker();
  booted();
  drainInbox();
  watchScan();
  resumeLink().then(plaidAuto);
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
