import * as store from './storage.js';
import * as A from './analyzer.js';
import * as sync from './sync.js';

const { ALL_CATS, TRANSFER_CATEGORIES: TRANSFER_CATS } = A;

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmt(n) { return Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const isoLocal = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isPhone = () => matchMedia('(max-width: 640px)').matches;

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isErr ? 6000 : 3500);
}

const PAL = [
  '#8b5cf6', '#60a5fa', '#34d399', '#fbbf24', '#f87171',
  '#a78bfa', '#38bdf8', '#6ee7b7', '#fcd34d', '#fca5a5',
  '#c4b5fd', '#7dd3fc', '#86efac', '#fdba74', '#f9a8d4',
];
const CAT_COLORS = {};
ALL_CATS.forEach((c, i) => { CAT_COLORS[c] = PAL[i % PAL.length]; });
function catColor(name) {
  if (CAT_COLORS[name]) return CAT_COLORS[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PAL[h % PAL.length];
}

const _animFrames = {};
function animNum(el, target, isCount = false) {
  const key = el.id;
  if (_animFrames[key]) cancelAnimationFrame(_animFrames[key]);
  const neg = target < 0, abs = Math.abs(target), dur = 900, start = performance.now();
  function tick(now) {
    const p = Math.min((now - start) / dur, 1);
    const cur = abs * (1 - Math.pow(1 - p, 3));
    el.textContent = isCount ? Math.round(cur).toLocaleString()
      : (neg ? '-$' : '$') + cur.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p < 1) _animFrames[key] = requestAnimationFrame(tick);
  }
  _animFrames[key] = requestAnimationFrame(tick);
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

// ── State ─────────────────────────────────────────────────────────────────────
let state;            // what storage.js holds
let ALL_TXN = [];     // derived: categorized, newest first
let STREAMS = [];
let BALANCE = [];
let DATA_MIN = 0, DATA_MAX = 0;

let activeCat = 'all';
let showTransfers = false;
let txnDir = '';
let txnLimit = 200;
let cpIncomeOverride = null;
const cpExcluded = new Set();
let cpChart = null;

// Saves the state, and queues a sync. `rules` marks the rule set as changed, which
// is what lets the newer rule set win when two devices merge.
async function commit({ rules = false } = {}) {
  const now = Date.now();
  state.meta.updatedAt = now;
  if (rules) state.meta.rulesUpdatedAt = now;
  await store.saveData(state);
  scheduleSync();
}

// ── Charts ────────────────────────────────────────────────────────────────────
let donutChart, monthlyChart, balanceChart;

function initCharts() {
  if (donutChart) return;
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";

  donutChart = new Chart($('donut-chart').getContext('2d'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderColor: '#080c14', borderWidth: 3, hoverOffset: 6 }] },
    options: {
      cutout: '68%',
      animation: { animateRotate: true, duration: 900, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
          return ` $${fmt(ctx.parsed)}  (${(ctx.parsed / total * 100).toFixed(1)}%)`;
        } } },
      },
    },
  });

  const mctx = $('monthly-chart').getContext('2d');
  const incGrad = mctx.createLinearGradient(0, 0, 0, 300);
  incGrad.addColorStop(0, 'rgba(52,211,153,0.8)'); incGrad.addColorStop(1, 'rgba(52,211,153,0.2)');
  const expGrad = mctx.createLinearGradient(0, 0, 0, 300);
  expGrad.addColorStop(0, 'rgba(248,113,113,0.8)'); expGrad.addColorStop(1, 'rgba(248,113,113,0.2)');
  monthlyChart = new Chart(mctx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: 'Income', data: [], backgroundColor: incGrad, borderColor: '#34d399', borderWidth: 1, borderRadius: 5, borderSkipped: false },
        { label: 'Spending', data: [], backgroundColor: expGrad, borderColor: '#f87171', borderWidth: 1, borderRadius: 5, borderSkipped: false },
        { label: 'Net', data: [], type: 'line', borderColor: '#fbbf24', backgroundColor: 'rgba(251,191,36,0.08)',
          borderWidth: 2, pointRadius: 4, pointBackgroundColor: '#fbbf24', tension: 0.4, fill: true },
      ],
    },
    options: {
      animation: { duration: 800, easing: 'easeOutQuart' },
      plugins: {
        legend: { labels: { boxWidth: 12, padding: 14 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: $${fmt(ctx.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { ticks: { callback: v => '$' + v.toLocaleString() }, grid: { color: 'rgba(255,255,255,0.04)' } },
      },
    },
  });

  const bctx = $('balance-chart').getContext('2d');
  const netGrad = bctx.createLinearGradient(0, 0, 0, 260);
  netGrad.addColorStop(0, 'rgba(52,211,153,0.25)'); netGrad.addColorStop(1, 'rgba(52,211,153,0.01)');
  balanceChart = new Chart(bctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Bank Balance (Checking + Savings)', data: [], borderColor: '#60a5fa', backgroundColor: 'transparent',
          borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, tension: 0.3, borderDash: [4, 3] },
        { label: 'CC Outstanding', data: [], borderColor: '#f87171', backgroundColor: 'transparent',
          borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, tension: 0.3, borderDash: [4, 3] },
        { label: 'Net Assets', data: [], borderColor: '#34d399', backgroundColor: netGrad,
          borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, tension: 0.3, fill: true },
      ],
    },
    options: {
      animation: { duration: 1000, easing: 'easeOutQuart' },
      plugins: {
        legend: { labels: { boxWidth: 12, padding: 14 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: $${fmt(ctx.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
        y: { ticks: { callback: v => '$' + v.toLocaleString() }, grid: { color: 'rgba(255,255,255,0.04)' } },
      },
    },
  });
}

function updateBalanceChart(startMs, endMs) {
  const filtered = BALANCE.filter(d => { const ts = A.localTs(d.date); return ts >= startMs && ts <= endMs; });
  balanceChart.data.labels = filtered.map(d => d.date);
  balanceChart.data.datasets[0].data = filtered.map(d => d.total_bank);
  balanceChart.data.datasets[1].data = filtered.map(d => d.cc_outstanding);
  balanceChart.data.datasets[2].data = filtered.map(d => d.net);
  balanceChart.update('active');
}

// ── Views ─────────────────────────────────────────────────────────────────────
function showView() {
  const has = state.transactions.length > 0;
  $('welcome').hidden = has;
  $('dashboard').hidden = !has;
  if (has) rebuild(false);
}

// Re-derives everything from storage. keepRange holds the date filter where it was
// (after a recategorize); otherwise the range resets to all the data.
function rebuild(keepRange) {
  initCharts();
  ALL_TXN = A.categorize(state.transactions, state.rules, state.training);
  STREAMS = A.findRecurringStreams(ALL_TXN);
  BALANCE = A.buildAssetSeries(ALL_TXN, Number(state.settings.cc_start) || 0);

  const tss = ALL_TXN.map(t => t.ts);
  DATA_MIN = Math.min(...tss);
  DATA_MAX = Math.max(...tss) + 86399999;
  for (const id of ['date-start', 'date-end']) { $(id).min = isoLocal(DATA_MIN); $(id).max = isoLocal(DATA_MAX); }

  $('acct-badges').innerHTML = [...new Set(ALL_TXN.map(t => t.account))].sort()
    .map(a => `<span class="acct-badge">${esc(a)}</span>`).join('');
  $('balance-card').hidden = BALANCE.length <= 1;

  let [s, e] = getInputMs();
  if (!keepRange || isNaN(s) || isNaN(e)) {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.days === '0'));
    [s, e] = [DATA_MIN, DATA_MAX];
    setDateInputs(s, e);
  }
  streamsPage = Math.min(streamsPage, Math.max(0, Math.ceil(STREAMS.length / STREAMS_PER_PAGE) - 1));
  recompute(s, e);
  renderStreams();
}

// ── Cashflow predictor ───────────────────────────────────────────────────────
function updateCashflowPredictor(startMs, endMs, ops) {
  const days = Math.max(1, (endMs - startMs) / 86400000);
  const months = days / 30.44;
  const actualMonthly = ops.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0) / months;
  const monthlyIncome = cpIncomeOverride != null ? cpIncomeOverride : actualMonthly;

  if (cpIncomeOverride == null) { $('cp-income').value = ''; $('cp-income').placeholder = fmt(actualMonthly); }

  const periodStr = days < 32 ? `${Math.round(days)} days` : `${months.toFixed(1)} months`;
  $('cp-period-note').textContent = `Averages over ${periodStr}` +
    (cpIncomeOverride != null ? ' · income manually set' : ' · income from data') +
    (cpExcluded.size ? ` · ${cpExcluded.size} categor${cpExcluded.size > 1 ? 'ies' : 'y'} excluded` : '');

  const catMap = {};
  ops.filter(t => t.amount < 0).forEach(t => { catMap[t.category] = (catMap[t.category] || 0) + Math.abs(t.amount); });
  const allCatRows = Object.entries(catMap).map(([name, total]) => ({ name, avg: total / months })).sort((a, b) => b.avg - a.avg);
  const activeCats = allCatRows.filter(c => !cpExcluded.has(c.name));
  const totalSpend = activeCats.reduce((s, c) => s + c.avg, 0);
  const remaining = monthlyIncome - totalSpend;

  $('cp-list').innerHTML = allCatRows.map(c => {
    const excl = cpExcluded.has(c.name);
    const pct = monthlyIncome > 0 ? Math.min(c.avg / monthlyIncome * 100, 100) : 0;
    const col = catColor(c.name);
    return `<div class="cp-row${excl ? ' cp-row-excluded' : ''}">
      <button class="cp-toggle" data-cat="${esc(c.name)}" title="${excl ? 'Include' : 'Exclude'} ${esc(c.name)}" style="color:${col}">${excl ? '○' : '●'}</button>
      <div class="cp-cat-name" title="${esc(c.name)}">${esc(c.name)}</div>
      <div class="cp-bar-wrap"><div class="cp-bar" style="width:${pct.toFixed(1)}%;background:${col}"></div></div>
      <div class="cp-amt">-$${fmt(c.avg)}<span style="font-weight:400;color:var(--dim)">/mo</span></div>
      <div class="cp-pct" style="color:${col}">${pct.toFixed(1)}%</div>
    </div>`;
  }).join('');

  const pos = remaining >= 0;
  $('cp-summary').innerHTML = `
    <div class="cp-foot-row">
      <span class="cp-foot-label">Active Spending</span>
      <span style="color:var(--red);font-weight:700;font-variant-numeric:tabular-nums">-$${fmt(totalSpend)}/mo</span>
    </div>
    <div class="cp-foot-row" style="margin-top:0.4rem">
      <span class="cp-foot-label">Remaining</span>
      <span class="cp-remaining ${pos ? 'pos' : 'neg'}">${pos ? '+' : '-'}$${fmt(remaining)}/mo</span>
    </div>`;

  const datasets = activeCats.map(c => ({ label: c.name, data: [c.avg], backgroundColor: catColor(c.name), borderWidth: 0 }));
  datasets.push(remaining > 0
    ? { label: 'Remaining', data: [remaining], backgroundColor: 'rgba(52,211,153,0.18)', borderColor: '#34d399', borderWidth: 1 }
    : { label: 'Over budget', data: [Math.abs(remaining)], backgroundColor: 'rgba(248,113,113,0.25)', borderColor: '#f87171', borderWidth: 1 });

  if (cpChart) { cpChart.destroy(); cpChart = null; }
  cpChart = new Chart($('cp-chart').getContext('2d'), {
    type: 'bar',
    data: { labels: ['Monthly avg'], datasets },
    options: {
      maintainAspectRatio: false,
      animation: { duration: 500, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => {
          const pct = monthlyIncome > 0 ? (c.parsed.y / monthlyIncome * 100).toFixed(1) : '0.0';
          return ` ${c.dataset.label}: $${fmt(c.parsed.y)}  (${pct}%)`;
        } } },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } },
        y: { stacked: true, suggestedMax: monthlyIncome * 1.05,
          ticks: { callback: v => '$' + v.toLocaleString(), color: '#94a3b8', font: { size: 11 } },
          grid: { color: 'rgba(255,255,255,0.04)' } },
      },
    },
  });
}

function refreshPredictor() {
  const [s, e] = getInputMs();
  updateCashflowPredictor(s, e, ALL_TXN.filter(t => t.ts >= s && t.ts <= e && !t.is_transfer));
}

$('cp-list').addEventListener('click', ev => {
  const btn = ev.target.closest('.cp-toggle');
  if (!btn) return;
  const cat = btn.dataset.cat;
  if (cpExcluded.has(cat)) cpExcluded.delete(cat); else cpExcluded.add(cat);
  refreshPredictor();
});

// ── Core recompute ────────────────────────────────────────────────────────────
function recompute(startMs, endMs) {
  const txns = ALL_TXN.filter(t => t.ts >= startMs && t.ts <= endMs);
  const ops = txns.filter(t => !t.is_transfer);
  const income = ops.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const expenses = ops.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  const net = income - expenses;
  const xfrOut = txns.filter(t => t.is_transfer && t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);

  animNum($('v-income'), income);
  animNum($('v-expense'), expenses);
  animNum($('v-net'), net);
  animNum($('v-xfr'), xfrOut);
  animNum($('v-count'), txns.length, true);
  $('txn-sub').textContent = `${txns.length.toLocaleString()} in selected range`;
  $('net-card').classList.toggle('pos', net >= 0);
  $('net-card').classList.toggle('neg', net < 0);

  const catMap = {};
  ops.filter(t => t.amount < 0).forEach(t => { catMap[t.category] = (catMap[t.category] || 0) + Math.abs(t.amount); });
  const cats = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
  donutChart.data.labels = cats.map(c => c[0]);
  donutChart.data.datasets[0].data = cats.map(c => Math.round(c[1] * 100) / 100);
  donutChart.data.datasets[0].backgroundColor = cats.map(c => catColor(c[0]));
  donutChart.update('active');
  updateCatLegend(cats);

  const monthMap = {};
  ops.forEach(t => {
    const key = t.date_iso.slice(0, 7);
    if (!monthMap[key]) monthMap[key] = { inc: 0, exp: 0 };
    if (t.amount > 0) monthMap[key].inc += t.amount; else monthMap[key].exp += Math.abs(t.amount);
  });
  const months = Object.keys(monthMap).sort();
  monthlyChart.data.labels = months.map(monthLabel);
  monthlyChart.data.datasets[0].data = months.map(m => Math.round(monthMap[m].inc * 100) / 100);
  monthlyChart.data.datasets[1].data = months.map(m => Math.round(monthMap[m].exp * 100) / 100);
  monthlyChart.data.datasets[2].data = months.map(m => Math.round((monthMap[m].inc - monthMap[m].exp) * 100) / 100);
  monthlyChart.update('active');

  const mMap = {};
  ops.filter(t => t.amount < 0).forEach(t => { mMap[t.merchant] = (mMap[t.merchant] || 0) + Math.abs(t.amount); });
  updateMerchants(Object.entries(mMap).sort((a, b) => b[1] - a[1]).slice(0, 10));

  if (BALANCE.length > 1) updateBalanceChart(startMs, endMs);
  updateCatPills(ops);
  updateCashflowPredictor(startMs, endMs, ops);
  txnLimit = 200;
  renderTable(txns);
}

function updateCatLegend(cats) {
  const total = cats.reduce((s, c) => s + c[1], 0);
  $('cat-legend').innerHTML = cats.map(([name, val]) => {
    const pct = total > 0 ? val / total * 100 : 0;
    const col = catColor(name);
    return `<div class="cat-row">
      <div class="cat-dot" style="background:${col}"></div>
      <div class="cat-name" title="${esc(name)}">${esc(name)}</div>
      <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct.toFixed(1)}%;background:${col}"></div></div>
      <div class="cat-amount" style="color:${col}">$${fmt(val)}</div>
    </div>`;
  }).join('');
}

function updateMerchants(merchants) {
  if (!merchants.length) { $('merchant-list').innerHTML = '<div class="empty">No spending data.</div>'; return; }
  const max = merchants[0][1];
  $('merchant-list').innerHTML = merchants.map(([name, amt]) => `
    <div class="merchant-row">
      <div class="merchant-name" title="${esc(name)}">${esc(name)}</div>
      <div class="merchant-bar-wrap"><div class="merchant-bar" style="width:${(amt / max * 100).toFixed(1)}%"></div></div>
      <div class="merchant-amount">-$${fmt(amt)}</div>
    </div>`).join('');
}

function updateCatPills(ops) {
  const inData = new Set(ops.map(t => t.category));
  const extra = [...inData].filter(c => !ALL_CATS.includes(c)).sort();
  $('cat-filters').innerHTML = `<button class="filter-pill${activeCat === 'all' ? ' active' : ''}" data-cat="all">All</button>`
    + [...ALL_CATS, ...extra].map(c => {
      const empty = !inData.has(c);
      return `<button class="filter-pill${c === activeCat ? ' active' : ''}" data-cat="${esc(c)}" style="${empty ? 'opacity:0.4;' : ''}">${esc(c)}</button>`;
    }).join('');
}

// ── Transactions table ───────────────────────────────────────────────────────
function getCurrentDateTxns() {
  const [s, e] = getInputMs();
  return ALL_TXN.filter(t => t.ts >= s && t.ts <= e);
}

function renderTable(txns) {
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
    if (!showTransfers && t.is_transfer) return false;
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

  const tbody = $('txn-tbody');
  const more = $('txn-more');
  if (!visible.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No transactions match the current filter.</td></tr>';
    more.hidden = true;
    return;
  }
  // Thousands of rows is slow to lay out on a phone; page them in.
  tbody.innerHTML = visible.slice(0, txnLimit).map(t => `
    <tr class="${t.is_transfer ? 'xfr-row' : ''}">
      <td class="txn-date">${t.date_fmt}</td>
      <td class="txn-desc" title="${esc(t.description)}">${esc(t.description.slice(0, 55))}</td>
      <td><span class="txn-cat${t.is_transfer ? ' xfr' : ''}" data-merchant="${esc(t.merchant)}" data-cat="${esc(t.category)}" data-amount="${Math.abs(t.amount)}">${esc(t.category)}</span></td>
      <td class="txn-account">${esc(t.account)}</td>
      <td class="txn-amount ${t.amount >= 0 ? 'pos' : 'neg'}">${t.amount >= 0 ? '+' : '-'}$${fmt(t.amount)}</td>
    </tr>`).join('');
  if (visible.length > txnLimit) {
    more.hidden = false;
    more.innerHTML = `<button class="stream-page-btn" id="txn-more-btn" style="font-size:.8rem">Show more (${(visible.length - txnLimit).toLocaleString()} left)</button>`;
  } else {
    more.hidden = true;
  }
}

$('txn-more').addEventListener('click', ev => {
  if (!ev.target.closest('#txn-more-btn')) return;
  txnLimit += 500;
  renderTable(getCurrentDateTxns());
});

// ── Date range ───────────────────────────────────────────────────────────────
function setDateInputs(startMs, endMs) {
  $('date-start').value = isoLocal(startMs);
  $('date-end').value = isoLocal(endMs);
  updateRangeDisp(startMs, endMs);
}
function updateRangeDisp(startMs, endMs) {
  $('range-disp').textContent = `${Math.round((endMs - startMs) / 86400000)} days`;
}
function getInputMs() {
  const sv = $('date-start').value, ev = $('date-end').value;
  if (!sv || !ev) return [NaN, NaN];
  return [A.localTs(sv), A.localTs(ev) + 86399999];
}

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const days = parseInt(btn.dataset.days, 10);
    const startMs = days === 0 ? DATA_MIN : Math.max(DATA_MIN, DATA_MAX - days * 86400000);
    setDateInputs(startMs, DATA_MAX);
    recompute(startMs, DATA_MAX);
  });
});

['date-start', 'date-end'].forEach(id => {
  $(id).addEventListener('change', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    const [s, e] = getInputMs();
    if (!isNaN(s) && !isNaN(e) && s <= e) { updateRangeDisp(s, e); recompute(s, e); }
  });
});

$('cat-filters').addEventListener('click', ev => {
  const btn = ev.target.closest('.filter-pill');
  if (!btn) return;
  document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeCat = btn.dataset.cat;
  txnLimit = 200;
  renderTable(getCurrentDateTxns());
});

$('show-xfr').addEventListener('change', e => { showTransfers = e.target.checked; renderTable(getCurrentDateTxns()); });
$('txn-search').addEventListener('input', () => renderTable(getCurrentDateTxns()));
$('txn-amt-op').addEventListener('change', () => renderTable(getCurrentDateTxns()));
$('txn-amt-val').addEventListener('input', () => renderTable(getCurrentDateTxns()));
document.querySelectorAll('.txn-dir-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.txn-dir-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    txnDir = btn.dataset.dir;
    renderTable(getCurrentDateTxns());
  });
});

$('cp-income').addEventListener('input', () => {
  const v = parseFloat($('cp-income').value);
  cpIncomeOverride = (!isNaN(v) && v > 0) ? v : null;
  refreshPredictor();
});
$('cp-income-reset').addEventListener('click', () => { cpIncomeOverride = null; $('cp-income').value = ''; refreshPredictor(); });

// ── Recurring streams ────────────────────────────────────────────────────────
const STREAMS_PER_PAGE = 5;
let streamsPage = 0;
const streamOverlay = $('stream-overlay');
let streamChart = null;

function renderStreams() {
  const list = $('streams-list'), pgDiv = $('streams-pagination');
  if (!STREAMS.length) {
    list.innerHTML = '<div class="empty">No recurring streams detected.</div>';
    pgDiv.innerHTML = '';
    return;
  }
  const start = streamsPage * STREAMS_PER_PAGE;
  const total = Math.ceil(STREAMS.length / STREAMS_PER_PAGE);
  list.innerHTML = STREAMS.slice(start, start + STREAMS_PER_PAGE).map((s, i) => `
    <div class="stream-item" data-idx="${start + i}">
      <div class="stream-icon ${s.direction}">${s.direction === 'expense' ? '💸' : '💰'}</div>
      <div class="stream-info">
        <div class="stream-name">${esc(s.merchant)}</div>
        <div class="stream-meta">${esc(s.category)} · ${s.occurrences}× · last ${s.last_date}</div>
      </div>
      <div class="stream-right">
        <div class="stream-amount ${s.direction}">$${fmt(s.avg_amount)}</div>
        <div class="stream-freq">${s.frequency}</div>
      </div>
    </div>`).join('');
  pgDiv.innerHTML = total <= 1 ? '' : `
    <button class="stream-page-btn" data-step="-1" ${streamsPage === 0 ? 'disabled' : ''}>‹</button>
    <span class="stream-page-info">${streamsPage + 1} / ${total}</span>
    <button class="stream-page-btn" data-step="1" ${streamsPage >= total - 1 ? 'disabled' : ''}>›</button>`;
}

$('streams-list').addEventListener('click', ev => {
  const el = ev.target.closest('.stream-item');
  if (el) openStreamModal(STREAMS[parseInt(el.dataset.idx, 10)]);
});
$('streams-pagination').addEventListener('click', ev => {
  const b = ev.target.closest('[data-step]');
  if (!b || b.disabled) return;
  streamsPage += Number(b.dataset.step);
  renderStreams();
});

function openStreamModal(s) {
  if (!s) return;
  $('stream-modal-title').textContent = s.merchant;
  $('stream-modal-meta').textContent = `${s.category} · ${s.frequency} · ${s.occurrences} occurrences`;
  const txns = s.transactions || [];
  const isIncome = s.direction === 'income';
  const color = isIncome ? '#34d399' : '#f87171';
  streamOverlay.classList.add('open');

  if (streamChart) { streamChart.destroy(); streamChart = null; }
  const ctx = $('stream-chart').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 180);
  grad.addColorStop(0, isIncome ? 'rgba(52,211,153,0.22)' : 'rgba(248,113,113,0.22)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  streamChart = new Chart(ctx, {
    type: 'line',
    data: { labels: txns.map(t => t.date), datasets: [{
      data: txns.map(t => Math.abs(t.amount)), borderColor: color, backgroundColor: grad, borderWidth: 2,
      pointRadius: 4, pointBackgroundColor: color, pointHoverRadius: 6, tension: 0.3, fill: true }] },
    options: {
      animation: { duration: 500, easing: 'easeOutQuart' },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` $${fmt(c.parsed.y)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 7, maxRotation: 0, color: '#94a3b8', font: { size: 11 } } },
        y: { beginAtZero: false, ticks: { callback: v => '$' + v.toLocaleString(), color: '#94a3b8', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
      },
    },
  });

  $('stream-timeline').innerHTML = [...txns].reverse().map(t => {
    const pos = t.amount >= 0;
    return `<div class="tl-row"><span class="tl-date">${t.date}</span><span class="tl-amt ${pos ? 'pos' : 'neg'}">${pos ? '+' : '-'}$${fmt(t.amount)}</span></div>`;
  }).join('');
  const total = txns.reduce((sum, t) => sum + t.amount, 0);
  $('stream-total-label').textContent = `Total across ${txns.length} transactions`;
  $('stream-total-val').textContent = (total >= 0 ? '+$' : '-$') + fmt(total);
  $('stream-total-val').style.color = total >= 0 ? 'var(--green)' : 'var(--red)';
}

$('stream-modal-close').addEventListener('click', () => streamOverlay.classList.remove('open'));
streamOverlay.addEventListener('click', ev => { if (ev.target === streamOverlay) streamOverlay.classList.remove('open'); });

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
    `<button class="picker-opt${c === currentCat ? ' current' : ''}" data-pick="${esc(c)}">${esc(c)}${TRANSFER_CATS.has(c) ? ' <span style="color:var(--yellow);font-size:.7em">transfer</span>' : ''}</button>`).join('');
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

$('txn-tbody').addEventListener('click', ev => {
  const pill = ev.target.closest('.txn-cat');
  if (!pill) return;
  ev.stopPropagation();
  if (pickerMerchant === pill.dataset.merchant && picker.classList.contains('open')) { closePicker(); return; }
  openPicker(pill, pill.dataset.merchant, pill.dataset.cat, pill.dataset.amount);
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
document.addEventListener('click', ev => { if (!picker.contains(ev.target)) closePicker(); });

// ── Importing CSVs ───────────────────────────────────────────────────────────
async function importFiles(fileList) {
  const files = [...fileList].filter(f => /\.csv$/i.test(f.name) || f.type === 'text/csv');
  if (!files.length) { toast('Choose one or more .csv files.', true); return; }
  const unknown = [];
  let incoming = [];
  for (const f of files) {
    try {
      const { format, transactions } = A.parseFile(await f.text());
      if (format === 'unknown' || !transactions.length) unknown.push(f.name);
      else incoming = incoming.concat(transactions);
    } catch (e) {
      unknown.push(f.name);
    }
  }
  if (!incoming.length) {
    toast(`No recognisable transactions in ${unknown.join(', ')}. Expected a Capital One checking, savings or credit card export.`, true);
    return;
  }
  const { merged, added, skipped } = A.mergeTransactions(state.transactions, incoming);
  state.transactions = merged;
  await commit();
  store.requestPersistence();
  showView();
  let msg = `Added ${added.toLocaleString()} new transaction${added === 1 ? '' : 's'}`;
  if (skipped) msg += `, skipped ${skipped.toLocaleString()} already saved`;
  if (unknown.length) msg += `. Not recognised: ${unknown.join(', ')}`;
  toast(msg + '.', unknown.length > 0);
}

const dropZone = $('drop-zone');
$('file-input').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
$('add-input').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); importFiles(e.dataTransfer.files); });
// The dashboard accepts a drop anywhere too.
document.addEventListener('dragover', e => { if (!$('dashboard').hidden) e.preventDefault(); });
document.addEventListener('drop', e => {
  if ($('dashboard').hidden || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  importFiles(e.dataTransfer.files);
});

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
  closeSettings();
  closePicker();
});

function renderSettings() {
  $('cc-start').value = state.settings.cc_start || '';
  const m = Object.entries(state.rules.merchant);
  const a = state.rules.amount_rules;
  $('rule-count').textContent = m.length + a.length ? `(${m.length + a.length})` : '';
  $('rule-list').innerHTML = (m.length + a.length) ? [
    ...a.map((r, i) => `<div class="rule-item"><span class="rm" title="${esc(r.merchant)}">${esc(r.merchant)} <span style="color:var(--dim)">at $${fmt(r.amount)}${r.tolerance_pct ? ` ±${r.tolerance_pct}%` : ''}</span></span><span class="rc">${esc(r.category)}</span><button data-amt="${i}" aria-label="Remove rule">✕</button></div>`),
    ...m.sort((x, y) => x[0].localeCompare(y[0])).map(([k, c]) => `<div class="rule-item"><span class="rm" title="${esc(k)}">${esc(k)}</span><span class="rc">${esc(c)}</span><button data-merchant="${esc(k)}" aria-label="Remove rule">✕</button></div>`),
  ].join('') : '<div class="set-status">No rules yet. Tap a category in the transactions table to create one.</div>';

  const accts = new Set(state.transactions.map(t => t.account)).size;
  $('data-summary').textContent = state.transactions.length
    ? `${state.transactions.length.toLocaleString()} transactions across ${accts} account${accts === 1 ? '' : 's'}, stored in this browser.`
    : 'Nothing stored yet.';
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
  const blob = new Blob([JSON.stringify({ app: 'financetracker', version: 1, exportedAt: new Date().toISOString(), ...snapshot() })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `financetracker-backup-${isoLocal(Date.now())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!data || data.app !== 'financetracker' || !Array.isArray(data.transactions)) {
    toast('That is not a FinanceTracker backup file.', true);
    return;
  }
  const before = state.transactions.length;
  Object.assign(state, sync.merge(state, data));
  await commit();
  store.requestPersistence();
  closeSettings();
  showView();
  toast(`Backup restored: ${(state.transactions.length - before).toLocaleString()} transactions added.`);
}
$('import-backup').addEventListener('change', e => { if (e.target.files[0]) restoreBackup(e.target.files[0]); e.target.value = ''; });
$('welcome-restore').addEventListener('change', e => { if (e.target.files[0]) restoreBackup(e.target.files[0]); e.target.value = ''; });

$('clear-all').addEventListener('click', async () => {
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

function setDot(cls) { $('sync-dot').className = 'sync-dot' + (cls ? ' ' + cls : ''); }

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
  if (!state.sync) return;
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
    if (remote) Object.assign(state, sync.merge(state, remote));
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

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  state = await store.loadAll();
  showView();
  if (state.sync) { setDot('ok'); lastAutoSync = Date.now(); syncNow({ quiet: true }); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot().catch(e => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<p style="position:relative;z-index:5;padding:2rem;color:#f87171">Could not open local storage: ${esc(e.message)}. Private browsing modes can block it.</p>`);
});
