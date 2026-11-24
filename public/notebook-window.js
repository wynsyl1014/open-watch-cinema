// Position, size and the folded cover are local to this browser.
const key = 'owc-notebook-window-v1';
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const number = (n, fallback) => (Number.isFinite(n) ? n : fallback);

export function createBookWindow(cover, book, onOpen, onClose) {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(key)) || {};
  } catch {}
  const state = {
    x: number(saved.x, innerWidth - 85),
    y: number(saved.y, innerHeight - 114),
    w: number(saved.w, 760),
    h: number(saved.h, 490),
    left: saved.left,
    top: saved.top
  };
  let opened = false,
    available = false,
    dragged = false,
    animation;
  const grip = book.querySelector('#notebookGrip');
  function persist() {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {}
  }
  function position() {
    const w = clamp(state.w, Math.min(310, innerWidth - 10), innerWidth - 10);
    const h = clamp(state.h, Math.min(240, innerHeight - 10), innerHeight - 10);
    const x = clamp(state.x, 5, innerWidth - 59),
      y = clamp(state.y, 5, innerHeight - 65);
    const left = clamp(number(state.left, x > innerWidth / 2 ? x + 54 - w : x), 5, innerWidth - w - 5);
    const top = clamp(number(state.top, y > innerHeight / 2 ? y + 60 - h : y), 5, innerHeight - h - 5);
    Object.assign(cover.style, { left: x + 'px', top: y + 'px' });
    Object.assign(book.style, { left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px' });
    return { x, y, left, top, w, h };
  }
  function flip(open) {
    if (!available || opened === open) return;
    opened = open;
    animation?.cancel();
    const p = position();
    const folded =
      'translate(' + (p.x - p.left) + 'px,' + (p.y - p.top) + 'px) scale(' + 54 / p.w + ',' + 60 / p.h + ')';
    const frames = [
      { transform: folded, opacity: 0.25 },
      { transform: 'none', opacity: 1 }
    ];
    book.hidden = false;
    cover.hidden = open;
    cover.setAttribute('aria-expanded', String(open));
    book.classList.toggle('nb-opening', open);
    if (open) {
      onOpen();
      book.querySelector('[aria-pressed=true]')?.focus({ preventScroll: true });
    } else onClose();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    animation = book.animate(
      reduced ? [{ opacity: 0.8 }, { opacity: 1 }] : open ? frames : frames.reverse(),
      { duration: reduced ? 60 : open ? 320 : 218, easing: 'cubic-bezier(.18,.78,.2,1)' }
    );
    animation.onfinish = () => {
      if (!opened) {
        book.hidden = true;
        cover.focus({ preventScroll: true });
      }
      book.classList.remove('nb-opening');
    };
  }
  function context() {
    const parent = document.fullscreenElement || document.body;
    if (cover.parentElement !== parent) parent.append(cover, book);
    position();
  }
  function down(e, mode) {
    if (e.button !== 0 || !e.isPrimary) return;
    const handle = e.currentTarget,
      start = position(),
      px = e.clientX,
      py = e.clientY;
    let moved = false;
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - px,
        dy = ev.clientY - py;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      if (mode === 'cover' || mode === 'grip') {
        state.x = clamp(start.x + dx, 5, innerWidth - 59);
        state.y = clamp(start.y + dy, 5, innerHeight - 65);
        if (mode === 'cover') state.left = state.top = undefined;
        else {
          state.left = clamp(start.left + dx, 5, innerWidth - start.w - 5);
          state.top = clamp(start.top + dy, 5, innerHeight - start.h - 5);
        }
      } else {
        let { left, top, w, h } = start;
        const minW = Math.min(310, innerWidth - 10),
          minH = Math.min(240, innerHeight - 10);
        if (mode.includes('w')) {
          left = clamp(left + dx, 5, start.left + w - minW);
          w += start.left - left;
        }
        if (mode.includes('n')) {
          top = clamp(top + dy, 5, start.top + h - minH);
          h += start.top - top;
        }
        if (mode.includes('e')) w = clamp(w + dx, minW, innerWidth - left - 5);
        if (mode.includes('s')) h = clamp(h + dy, minH, innerHeight - top - 5);
        Object.assign(state, { left, top, w, h });
      }
      position();
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      if (mode === 'cover' && moved) {
        dragged = true;
        setTimeout(() => {
          dragged = false;
        }, 0);
      }
      if (moved) persist();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('lostpointercapture', end, { once: true });
  }
  for (const side of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const handle = document.createElement('span');
    handle.className = 'nb-resize';
    handle.dataset.resize = side;
    book.append(handle);
    handle.addEventListener('pointerdown', (e) => down(e, side));
  }
  cover.addEventListener('pointerdown', (e) => down(e, 'cover'));
  grip.addEventListener('pointerdown', (e) => down(e, 'grip'));
  cover.addEventListener('click', () => {
    if (!dragged) flip(true);
  });
  book.querySelector('#notebookClose').addEventListener('click', () => flip(false));
  book.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      flip(false);
    }
  });
  grip.addEventListener('keydown', (e) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const p = position(),
      dx = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0,
      dy = e.key === 'ArrowDown' ? 16 : e.key === 'ArrowUp' ? -16 : 0;
    if (e.shiftKey) {
      state.w = p.w + dx;
      state.h = p.h + dy;
    } else {
      state.left = p.left + dx;
      state.top = p.top + dy;
      state.x = p.x + dx;
      state.y = p.y + dy;
    }
    position();
    persist();
  });
  context();
  document.addEventListener('fullscreenchange', context);
  window.addEventListener('resize', position);
  return {
    get open() {
      return opened;
    },
    enable(value) {
      available = value;
      if (!value) {
        opened = false;
        animation?.cancel();
        book.hidden = true;
        cover.setAttribute('aria-expanded', 'false');
      }
      cover.hidden = !available || opened;
    }
  };
}
