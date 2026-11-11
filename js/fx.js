// Presentation only: the motion and light laid over the views. Nothing here
// reads the data or changes what the app shows, so it can all be taken out.
// It stands down when the system asks for reduced motion.

const still = matchMedia('(prefers-reduced-motion: reduce)');

// ── Figures count to their value ─────────────────────────────────────────────
// A figure moves only when it changes: from zero the first time it is shown,
// and from what it read before when the period or an input changes it.
const shown = new Map();   // key -> the number on screen now
const frames = new Map();  // key -> the running animation
const NUM = /\d[\d,]*(?:\.\d+)?/;

export function countUp(root, id) {
  if (!root) return;
  root.querySelectorAll('.kpi-val, .pace-val').forEach((el, i) => {
    const node = [...el.childNodes].find(n => n.nodeType === 3 && NUM.test(n.nodeValue));
    const label = el.closest('.kpi')?.querySelector('.kpi-label')?.textContent || i;
    const key = `${id}:${label}`;
    cancelAnimationFrame(frames.get(key));
    if (!node) { shown.delete(key); return; }
    const text = node.nodeValue, m = NUM.exec(text);
    const to = parseFloat(m[0].replace(/,/g, '')), from = shown.get(key) ?? 0;
    const digits = (m[0].split('.')[1] || '').length;
    const write = v => {
      shown.set(key, v);
      node.nodeValue = text.slice(0, m.index) + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + text.slice(m.index + m[0].length);
    };
    if (still.matches || from === to || !isFinite(to)) { shown.set(key, to); return; }
    const t0 = performance.now(), ms = shown.has(key) ? 480 : 820;
    const step = now => {
      const p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 4);
      write(p < 1 ? from + (to - from) * e : to);
      if (p < 1) frames.set(key, requestAnimationFrame(step));
    };
    write(from);
    frames.set(key, requestAnimationFrame(step));
  });
}

// ── A light under the pointer ────────────────────────────────────────────────
// Panels and stat tiles are lit where the mouse is, and their hairlines glow
// near it. The styles read --mx / --my and fade in on .lit. Mouse and pen
// only: a finger has no resting position to light.
export function spotlight() {
  let lit = [], pending = null;
  const clear = () => { lit.forEach(el => el.classList.remove('lit')); lit = []; };
  const apply = () => {
    const ev = pending; pending = null;
    const t = ev.target instanceof Element ? ev.target : null;
    const now = t ? ['.kpi', '.kpi-row', '.panel'].map(s => t.closest(s)).filter(Boolean) : [];
    lit.filter(el => !now.includes(el)).forEach(el => el.classList.remove('lit'));
    for (const el of now) {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${Math.round(ev.clientX - r.left)}px`);
      el.style.setProperty('--my', `${Math.round(ev.clientY - r.top)}px`);
      el.classList.add('lit');
    }
    lit = now;
  };
  document.addEventListener('pointermove', ev => {
    if (ev.pointerType === 'touch') return;
    if (!pending) requestAnimationFrame(apply);
    pending = ev;
  }, { passive: true });
  document.addEventListener('pointerdown', ev => { if (ev.pointerType === 'touch') clear(); }, { passive: true });
  document.documentElement.addEventListener('pointerleave', clear);
}

// ── The menu's marker slides to the open view ────────────────────────────────
// One bar that travels between items, in place of each item lighting by
// itself. Returns the function that moves it; call it when the view changes.
export function navMarker(list) {
  const bar = document.createElement('i');
  bar.className = 'nav-ind';
  bar.setAttribute('aria-hidden', 'true');
  list.prepend(bar);
  list.classList.add('has-ind');
  let placed = false;
  const move = () => {
    const a = list.querySelector('.nav-item.active');
    if (!a || !a.offsetParent) { bar.style.opacity = 0; placed = false; return; }
    if (!placed || still.matches) bar.style.transition = 'none';   // arrives in place the first time
    bar.style.transform = `translateY(${a.offsetTop}px)`;
    bar.style.height = `${a.offsetHeight}px`;
    bar.style.opacity = 1;
    if (!placed) { void bar.offsetHeight; bar.style.transition = ''; placed = true; }
  };
  // The rail, a resized window and a finger-sized layout all shift the items.
  new ResizeObserver(move).observe(list);
  return move;
}
