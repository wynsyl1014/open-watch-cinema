// Relationship graph layout for the notebook "人物关系" page.
// Pure geometry: deterministic force-directed placement, node sizing that follows
// the available width, edge routing that bends around other people, and label
// placement that avoids nodes and other labels. No DOM access.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function graphScale(width) {
  return Math.round(clamp(width / 560, 0.72, 1) * 1000) / 1000;
}

// Node box relative to the avatar centre (the anchor point of each person).
export function nodeMetrics(scale) {
  const avatar = Math.round(54 * scale);
  const nameFont = Math.max(10.5, 12 * scale);
  const nameH = Math.round(nameFont * 1.3 + 6);
  return {
    avatar,
    nameFont,
    width: Math.round(104 * scale),
    halfW: Math.round(46 * scale),
    top: -avatar / 2 - 2,
    bottom: avatar / 2 + 5 + nameH
  };
}

export function labelSize(text) {
  let w = 20;
  for (const ch of String(text)) w += /[\u0000-\u00ff]/.test(ch) ? 6.6 : 11.8;
  return { w: Math.min(126, Math.ceil(w)), h: 21 };
}

function hash(str) {
  let h = 2166136261;
  for (const ch of String(str)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return (h >>> 0) / 4294967296;
}

function overlapArea(a, b) {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  return w > 0 && h > 0 ? w * h : 0;
}

function quad(a, c, b, t) {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

// Point where the ray from the node anchor toward `toward` leaves the node box.
function clipToBox(p, toward, m, pad) {
  const dx = toward.x - p.x,
    dy = toward.y - p.y;
  const halfW = m.halfW + pad,
    top = m.top - pad,
    bottom = m.bottom + pad;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, halfW / dx);
  if (dx < 0) t = Math.min(t, -halfW / dx);
  if (dy > 0) t = Math.min(t, bottom / dy);
  if (dy < 0) t = Math.min(t, top / dy);
  if (!Number.isFinite(t)) t = 0;
  t = Math.min(t, 0.45);
  return { x: p.x + dx * t, y: p.y + dy * t };
}

function segmentDistance(p, a, b) {
  const vx = b.x - a.x,
    vy = b.y - a.y;
  const len2 = vx * vx + vy * vy || 1;
  const t = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / len2, 0, 1);
  const qx = a.x + vx * t,
    qy = a.y + vy * t;
  return { d: Math.hypot(p.x - qx, p.y - qy), qx, qy, t };
}

function placeNodes(people, links, width, availHeight, m, linkGaps) {
  const n = people.length;
  const pos = people.map(() => ({ x: 0, y: 0 }));
  const boxW = m.halfW * 2,
    boxH = m.bottom - m.top;
  const padX = m.halfW + 10,
    padTop = -m.top + 12,
    padBottom = m.bottom + 12;
  const usableW = Math.max(boxW, width - padX * 2);

  if (n === 1) {
    const height = Math.max(availHeight, boxH + 60);
    pos[0] = { x: width / 2, y: (padTop + height - padBottom) / 2 };
    return { pos, height };
  }

  const cellArea = (boxW + 48) * (boxH + 40);
  const needH = Math.ceil((n * cellArea * 1.6) / usableW) + padTop + padBottom;
  let height = Math.max(availHeight, needH, boxH * 2 + 40);
  const usableH = () => Math.max(1, height - padTop - padBottom);
  const cx = width / 2,
    cy = () => padTop + usableH() / 2;

  // Deterministic start: best-connected people near the middle, spiralling out.
  const degree = people.map(() => 0);
  for (const [i, j] of links) degree[i]++, degree[j]++;
  const order = people
    .map((p, i) => i)
    .sort((a, b) => degree[b] - degree[a] || hash(people[a].id) - hash(people[b].id));
  const golden = Math.PI * (3 - Math.sqrt(5));
  order.forEach((idx, rank) => {
    const r = Math.sqrt((rank + 0.5) / n);
    const ang = rank * golden + hash(people[idx].id) * 0.4;
    pos[idx] = { x: cx + Math.cos(ang) * r * usableW * 0.45, y: cy() + Math.sin(ang) * r * usableH() * 0.45 };
  });

  const k = Math.sqrt((usableW * usableH()) / n);
  const iterations = 360;
  for (let it = 0; it < iterations; it++) {
    const temp = Math.max(1.5, k * 0.18 * (1 - it / iterations));
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x,
          dy = (pos[i].y - pos[j].y) * (boxW / boxH);
        let d = Math.hypot(dx, dy);
        if (d < 0.01) (dx = hash(i + ':' + j) - 0.5), (dy = 0.5), (d = 0.5);
        const f = (k * k) / d;
        disp[i].x += (dx / d) * f;
        disp[i].y += (dy / d) * f;
        disp[j].x -= (dx / d) * f;
        disp[j].y -= (dy / d) * f;
      }
    }
    for (const [i, j] of links) {
      const dx = pos[i].x - pos[j].x,
        dy = pos[i].y - pos[j].y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d * d) / k;
      disp[i].x -= (dx / d) * f;
      disp[i].y -= (dy / d) * f;
      disp[j].x += (dx / d) * f;
      disp[j].y += (dy / d) * f;
    }
    // Keep lines from running through bystanders once the shape has settled.
    if (it > iterations * 0.35) {
      for (const [i, j] of links) {
        for (let c = 0; c < n; c++) {
          if (c === i || c === j) continue;
          const s = segmentDistance(pos[c], pos[i], pos[j]);
          const clear = m.halfW + 16;
          if (s.d < clear && s.t > 0.02 && s.t < 0.98) {
            let nx = pos[c].x - s.qx,
              ny = pos[c].y - s.qy;
            const nd = Math.hypot(nx, ny);
            if (nd < 0.01) (nx = -(pos[j].y - pos[i].y)), (ny = pos[j].x - pos[i].x);
            const nl = Math.hypot(nx, ny) || 1;
            const push = (clear - s.d) * 2.2;
            disp[c].x += (nx / nl) * push * 4;
            disp[c].y += (ny / nl) * push * 4;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      disp[i].x += (cx - pos[i].x) * 0.02 * k;
      disp[i].y += (cy() - pos[i].y) * 0.02 * k;
      const dl = Math.hypot(disp[i].x, disp[i].y) || 1;
      const step = Math.min(dl, temp);
      pos[i].x = clamp(pos[i].x + (disp[i].x / dl) * step, padX, width - padX);
      pos[i].y = clamp(pos[i].y + (disp[i].y / dl) * step, padTop, height - padBottom);
    }
  }

  // Hard separation so avatars and name tags never touch.
  const gapX = 18,
    gapY = 16;
  const linked = new Map(links.map(([i, j], li) => [i < j ? i + '/' + j : j + '/' + i, linkGaps[li]]));
  for (let round = 0; round < 6; round++) {
    let crowded = false;
    for (let pass = 0; pass < 80; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          // Linked people keep enough room between them for the relation label.
          const lg = linked.get(i + '/' + j);
          const needX = boxW + (lg ? lg.x : gapX);
          const ox = needX - Math.abs(pos[i].x - pos[j].x);
          const oy = boxH + (lg ? lg.y : gapY) - Math.abs(pos[i].y - pos[j].y);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          // On narrow stages a side-by-side gap may not fit; stack those pairs instead.
          const horizontal = ox / boxW < oy / boxH && needX <= (width - padX * 2) * 0.8;
          if (horizontal) {
            const s = pos[i].x < pos[j].x || (pos[i].x === pos[j].x && i < j) ? -1 : 1;
            pos[i].x += (s * ox) / 2;
            pos[j].x -= (s * ox) / 2;
          } else {
            const s = pos[i].y < pos[j].y || (pos[i].y === pos[j].y && i < j) ? -1 : 1;
            pos[i].y += (s * oy) / 2;
            pos[j].y -= (s * oy) / 2;
          }
        }
      }
      for (const p of pos) {
        p.x = clamp(p.x, padX, width - padX);
        p.y = clamp(p.y, padTop, height - padBottom);
      }
      if (!moved) break;
      if (pass === 79) crowded = true;
    }
    if (!crowded) break;
    height += boxH + gapY;
  }

  // Trim empty space at top/bottom when the stage is taller than the view.
  const minY = Math.min(...pos.map((p) => p.y)),
    maxY = Math.max(...pos.map((p) => p.y));
  const contentH = maxY - minY + padTop + padBottom;
  const finalH = Math.max(availHeight, Math.ceil(contentH));
  const shift = (finalH - contentH) / 2 + padTop - minY;
  for (const p of pos) p.y += shift;
  return { pos, height: finalH };
}

export function layoutGraph({ people, relations, width, height: availHeight }) {
  const scale = graphScale(width);
  const m = nodeMetrics(scale);
  const index = new Map(people.map((p, i) => [p.id, i]));
  const pairs = new Set();
  const links = [];
  const linkGaps = [];
  for (const edge of relations) {
    const [from, to] = edge.characterIds || [];
    const i = index.get(from),
      j = index.get(to);
    if (i === undefined || j === undefined || i === j) continue;
    const key = i < j ? i + '/' + j : j + '/' + i;
    const size = labelSize(edge.label || edge.text || '关系');
    if (!pairs.has(key)) {
      pairs.add(key);
      links.push([i, j]);
      linkGaps.push({ x: size.w + 20, y: size.h + 22 });
    } else {
      const g = linkGaps[links.findIndex(([a, b]) => (a < b ? a + '/' + b : b + '/' + a) === key)];
      g.x += size.w + 10;
      g.y += size.h + 8;
    }
  }
  const { pos, height } = placeNodes(people, links, width, availHeight, m, linkGaps);
  const nodes = new Map(people.map((p, i) => [p.id, { x: Math.round(pos[i].x), y: Math.round(pos[i].y) }]));
  const nodeBoxes = people.map((p, i) => ({
    id: p.id,
    x1: pos[i].x - m.halfW - 4,
    x2: pos[i].x + m.halfW + 4,
    y1: pos[i].y + m.top - 4,
    y2: pos[i].y + m.bottom + 4
  }));

  const edges = [];
  const labels = [];
  const lanes = new Map();
  for (const edge of relations) {
    const [from, to] = edge.characterIds || [];
    const a = nodes.get(from),
      b = nodes.get(to);
    if (!a || !b || from === to) continue;
    const key = [from, to].sort().join('/'),
      lane = lanes.get(key) || 0;
    lanes.set(key, lane + 1);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len,
      ny = (b.x - a.x) / len;
    const sign = from < to ? 1 : -1; // same physical side for both directions of a pair
    const base = lane === 0 ? 0 : (lane % 2 ? 1 : -1) * (16 + Math.floor((lane - 1) / 2) * 24);
    const others = nodeBoxes.filter((box) => box.id !== from && box.id !== to);
    let best = null;
    for (const extra of [0, 22, -22, 42, -42, 66, -66, 96, -96]) {
      const bend = (base + extra) * sign;
      const c = { x: (a.x + b.x) / 2 + nx * bend * 2, y: (a.y + b.y) / 2 + ny * bend * 2 };
      let hits = 0;
      for (let s = 1; s < 16; s++) {
        const p = quad(a, c, b, s / 16);
        for (const box of others) if (p.x > box.x1 && p.x < box.x2 && p.y > box.y1 && p.y < box.y2) hits++;
      }
      const score = hits * 1000 + Math.abs(extra);
      if (!best || score < best.score) best = { score, c };
      if (hits === 0) break;
    }
    const c = best.c;
    const start = clipToBox(a, c, m, 3),
      end = clipToBox(b, c, m, edge.direction === 'forward' ? 5 : 3);

    const text = edge.label || edge.text || '关系';
    const size = labelSize(text);
    let spot = null;
    for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.27, 0.73, 0.2, 0.8, 0.14, 0.86]) {
      const p = quad(start, c, end, t);
      for (const off of [0, 13, -13, 24, -24]) {
        const x = p.x + nx * off,
          y = p.y + ny * off;
        const box = { x1: x - size.w / 2, x2: x + size.w / 2, y1: y - size.h / 2, y2: y + size.h / 2 };
        let cost = Math.abs(t - 0.5) * 40 + Math.abs(off) * 1.5;
        for (const nb of nodeBoxes) cost += overlapArea(box, nb) * 4;
        for (const lb of labels) cost += overlapArea(box, lb) * 3;
        if (box.x1 < 2 || box.x2 > width - 2 || box.y1 < 2 || box.y2 > height - 2) cost += 400;
        if (!spot || cost < spot.cost) spot = { cost, x, y, box };
      }
      if (spot.cost < 20) break;
    }
    labels.push(spot.box);
    edges.push({
      id: edge.id,
      text,
      direction: edge.direction,
      uncertain: edge.uncertain,
      start: { x: +start.x.toFixed(1), y: +start.y.toFixed(1) },
      control: { x: +c.x.toFixed(1), y: +c.y.toFixed(1) },
      end: { x: +end.x.toFixed(1), y: +end.y.toFixed(1) },
      label: { x: Math.round(spot.x), y: Math.round(spot.y) }
    });
  }
  return { scale, metrics: m, height, nodes, edges };
}
