import test from 'node:test';
import assert from 'node:assert/strict';
import { graphScale, labelSize, layoutGraph } from '../../public/notebook-graph.js';

const names = ['帕格斯利', '星期三', '桑希尔老师', '泽维尔', '警长', '伊妮德', '比安卡', '小手', '莫蒂西亚', '高梅兹'];
const pairs = [
  [0, 1, '姐弟'],
  [1, 5, '室友', 'forward'],
  [1, 6, '击剑竞争对手', 'forward'],
  [1, 7, '熟识', 'forward'],
  [1, 2, '师生'],
  [1, 3, '旧识', 'forward'],
  [4, 3, '父子'],
  [8, 9, '夫妻'],
  [8, 1, '母女'],
  [9, 0, '父子'],
  [5, 6, '同学']
];

function fixture(n) {
  const people = names.slice(0, n).map((name, i) => ({ id: 'p' + i, name }));
  const relations = pairs
    .filter(([a, b]) => a < n && b < n)
    .map(([a, b, label, direction], i) => ({ id: 'r' + i, label, direction, characterIds: ['p' + a, 'p' + b] }));
  return { people, relations };
}

const overlaps = (a, b) => Math.min(a.x2, b.x2) > Math.max(a.x1, b.x1) && Math.min(a.y2, b.y2) > Math.max(a.y1, b.y1);

test('relationship graph scales nodes with the available width', () => {
  assert.equal(graphScale(300), 0.72);
  assert.equal(graphScale(560), 1);
  assert.equal(graphScale(900), 1);
  assert.ok(graphScale(440) > 0.72 && graphScale(440) < 1);
});

test('relationship graph layout is deterministic', () => {
  const { people, relations } = fixture(8);
  const a = layoutGraph({ people, relations, width: 440, height: 420 });
  const b = layoutGraph({ people, relations, width: 440, height: 420 });
  assert.deepEqual([...a.nodes], [...b.nodes]);
  assert.deepEqual(a.edges, b.edges);
});

for (const n of [3, 7, 10]) {
  for (const width of [300, 440, 700]) {
    test(`relationship graph keeps ${n} people apart at width ${width}`, () => {
      const { people, relations } = fixture(n);
      const g = layoutGraph({ people, relations, width, height: 420 });
      const m = g.metrics;
      const boxes = [...g.nodes].map(([id, p]) => ({
        id,
        x1: p.x - m.halfW,
        x2: p.x + m.halfW,
        y1: p.y + m.top,
        y2: p.y + m.bottom
      }));
      for (const box of boxes) {
        assert.ok(box.x1 >= 0 && box.x2 <= width, 'person stays inside the width');
        assert.ok(box.y1 >= 0 && box.y2 <= g.height, 'person stays inside the stage');
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), 'people do not overlap');
      assert.equal(g.edges.length, relations.length);
      let labelHits = 0;
      for (const e of g.edges) {
        const s = labelSize(e.text);
        const label = { x1: e.label.x - s.w / 2, x2: e.label.x + s.w / 2, y1: e.label.y - s.h / 2, y2: e.label.y + s.h / 2 };
        labelHits += boxes.filter((b) => overlaps(label, b)).length;
      }
      assert.ok(labelHits <= 1, 'relation labels stay off people (got ' + labelHits + ')');
    });
  }
}
