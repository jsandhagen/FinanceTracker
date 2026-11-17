// A ruled track with a handle to drag: the instrument the What if views are
// driven by. Marks sit on the track at values worth stopping at, and the handle
// catches on them as it passes. Zones colour the stretches between marks.
// It holds no figures of its own: the view sets them and hears back.
//
//   const r = rail(el, { onInput, onChange, onReset });
//   r.set({ min, max, step, value, marks, zones, readout, tone, label });
//     marks    [{ v, label, sub, snap }]   snap: the value the handle lands on
//     zones    [{ from, to, tone }]        tone: 'ok' | 'near' | 'over'
//     readout  html shown above the handle
//
// onInput(value) fires while it moves, onChange(value) when it is let go, and
// onReset() on a double click. Arrow keys move it a step, with Shift ten.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function rail(el, { onInput = () => {}, onChange = () => {}, onReset = null } = {}) {
  el.classList.add('rail');
  el.innerHTML = `<div class="rail-marks"></div>
    <div class="rail-track"><div class="rail-zones"></div><i class="rail-fill"></i></div>
    <span class="rail-read"></span>
    <div class="rail-handle" role="slider" tabindex="0"><i class="rail-knob"></i></div>
    <div class="rail-scale"><span></span><span></span></div>`;
  const track = el.querySelector('.rail-track'), handle = el.querySelector('.rail-handle');
  const read = el.querySelector('.rail-read'), fill = el.querySelector('.rail-fill');
  const marksEl = el.querySelector('.rail-marks'), zonesEl = el.querySelector('.rail-zones');
  const [lo, hi] = el.querySelectorAll('.rail-scale span');
  let s = { min: 0, max: 1, step: 1, value: 0, marks: [] }, dragging = false, caught = null;

  const at = v => clamp((v - s.min) / (s.max - s.min || 1), 0, 1) * 100;
  const place = () => {
    const x = at(s.value);
    handle.style.left = fill.style.width = `${x}%`;
    // The readout follows the handle and stays inside the track at either end.
    const W = el.clientWidth, w = read.offsetWidth;
    read.style.left = `${W > w ? clamp(x / 100 * W, w / 2, W - w / 2) : W / 2}px`;
    handle.setAttribute('aria-valuenow', s.value);
  };

  // Marks whose words would print over each other take turns above and below,
  // by the room their words take on screen. A mark near the right end reads
  // leftward from its line. Measured once the rail has a width (it may be
  // drawn while its view is hidden) and again whenever that width changes.
  function lay() {
    const W = el.clientWidth;
    if (!W) return;
    const ends = [-Infinity, -Infinity], GAP = 8;
    for (const m of marksEl.children) {
      m.classList.remove('low', 'end');
      const x = parseFloat(m.style.left) / 100 * W;
      const w = Math.max(m.querySelector('b').offsetWidth, m.querySelector('small').offsetWidth) + 9;
      const end = x + w > W;
      const [from, to] = end ? [x - w, x] : [x, x + w];
      const row = from >= ends[0] + GAP ? 0 : from >= ends[1] + GAP ? 1 : ends[0] <= ends[1] ? 0 : 1;
      ends[row] = to;
      m.classList.toggle('low', row === 1);
      m.classList.toggle('end', end);
    }
  }
  new ResizeObserver(() => { lay(); place(); }).observe(el);

  function set(next) {
    s = { ...s, ...next };
    {
      zonesEl.innerHTML = (s.zones || []).map(z => `<i class="${z.tone}" style="left:${at(z.from)}%;width:${Math.max(0, at(z.to) - at(z.from))}%"></i>`).join('');
      marksEl.innerHTML = [...(s.marks || [])].sort((a, b) => a.v - b.v).map(m => {
        const x = at(m.v), off = m.v > s.max;
        return `<span class="rail-mark${x > 82 ? ' end' : ''}${off ? ' off' : ''}" style="left:${x}%"><i></i><b>${m.label}${off ? ' ›' : ''}</b><small>${m.sub || ''}</small></span>`;
      }).join('');
      lay();
    }
    lo.textContent = s.scale?.[0] ?? ''; hi.textContent = s.scale?.[1] ?? '';
    read.innerHTML = s.readout || '';
    el.dataset.tone = s.tone || '';
    handle.setAttribute('aria-valuemin', s.min); handle.setAttribute('aria-valuemax', s.max);
    if (s.label) handle.setAttribute('aria-label', s.label);
    if (s.text) handle.setAttribute('aria-valuetext', s.text);
    place();
  }

  const round = v => clamp(Math.round(v / s.step) * s.step, s.min, s.max);
  function moveTo(clientX) {
    const r = track.getBoundingClientRect();
    let v = round(s.min + clamp((clientX - r.left) / r.width, 0, 1) * (s.max - s.min));
    // Within a few pixels of a mark, the handle lands on it.
    const near = (s.marks || []).find(m => m.v <= s.max && Math.abs(at(m.v) - at(v)) * r.width / 100 < 7);
    if (near) v = round(near.snap ?? near.v);
    if (near && caught !== near.label) navigator.vibrate?.(8);
    caught = near ? near.label : null;
    el.classList.toggle('caught', !!near);
    if (v === s.value) return;
    s.value = v; place(); onInput(v);
  }

  // A mouse takes hold at once. A finger may only be scrolling the page past,
  // so it takes hold only once it has moved sideways more than it has moved
  // down (or lifts without moving, a tap). Until then nothing changes, and if
  // the page takes the gesture for a scroll the value is left as it was.
  const SLOP = 8;
  let pending = null;
  const grab = ev => {
    pending = null;
    dragging = true;
    el.classList.add('dragging');
    try { el.setPointerCapture(ev.pointerId); } catch {}
    handle.focus({ preventScroll: true });
    moveTo(ev.clientX);
  };
  el.addEventListener('pointerdown', ev => {
    if (ev.button > 0) return;
    if (ev.pointerType === 'mouse') { grab(ev); ev.preventDefault(); return; }
    pending = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
  });
  el.addEventListener('pointermove', ev => {
    if (dragging) { moveTo(ev.clientX); return; }
    if (!pending || ev.pointerId !== pending.id) return;
    const dx = Math.abs(ev.clientX - pending.x), dy = Math.abs(ev.clientY - pending.y);
    if (dy > SLOP && dy >= dx) pending = null;          // a scroll: let it go by
    else if (dx > SLOP && dx > dy) grab(ev);
  });
  const drop = () => {
    if (!dragging) return;
    dragging = false; caught = null;
    el.classList.remove('dragging', 'caught');
    onChange(s.value);
  };
  el.addEventListener('pointerup', ev => {
    if (pending && ev.pointerId === pending.id) { grab(ev); }   // a tap
    drop();
  });
  el.addEventListener('pointercancel', () => { pending = null; drop(); });
  if (onReset) el.addEventListener('dblclick', () => onReset());

  let keyTimer;
  handle.addEventListener('keydown', ev => {
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[ev.key];
    let v;
    if (dir) v = round(s.value + dir * s.step * (ev.shiftKey ? 10 : 1));
    else if (ev.key === 'Home') v = s.min;
    else if (ev.key === 'End') v = s.max;
    else if ((ev.key === 'Escape' || ev.key === 'Backspace') && onReset) { ev.preventDefault(); onReset(); return; }
    else return;
    ev.preventDefault(); ev.stopPropagation();
    if (v === s.value) return;
    s.value = v; place(); onInput(v);
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => onChange(s.value), 500);
  });

  return { set };
}
