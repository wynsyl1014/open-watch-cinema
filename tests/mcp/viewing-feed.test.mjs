import assert from 'node:assert/strict';
import test from 'node:test';
import { assertViewingPlayback, buildViewingFeed, selectInlineStoryboards } from '../../mcp/viewing/viewing-feed.mjs';
import { collectViewingCatchup } from '../../mcp/viewing/catchup-feed.mjs';

const image = (atMs) => ({
  id: 'private-image-' + atMs, type: 'image', fromMs: atMs, toMs: atMs,
  availableAtMs: atMs, mediaTimeMs: atMs, storyboardRef: 'private/path-' + atMs + '.jpg'
});
function fixture() {
  const pictures = [2000, 5000, 12000, 19000].map(image);
  return { tick: {
    packageVersion: 3, viewingIntervalMs: 10000,
    playback: { timeMs: 20000, state: 'playing', seekVersion: 3 },
    range: { fromMs: 0, toMs: 20000, bootstrap: true, seekDetected: false },
    storyboards: pictures,
    dialogueDelta: [], audioDescriptions: [], motionEvents: [],
    newMessages: [{ content: '你看！', mediaTimeMs: 11000 }, { content: '你看！', mediaTimeMs: 15000 }],
    segments: [
      { id: 'section-0', fromMs: 0, toMs: 10000, entries: [
        { id: 'cue-1', type: 'dialogue', fromMs: 1000, toMs: 13000, availableAtMs: 1000, text: '完整的一句话。', speaker: '甲' },
        pictures[0], pictures[1],
        { id: 'sound-1', type: 'sound', fromMs: 8000, toMs: 20000, availableAtMs: 20000, text: '连续脚步声。' }
      ] },
      { id: 'section-10000', fromMs: 10000, toMs: 20000, entries: [
        pictures[2],
        { id: 'cue-2', type: 'dialogue', fromMs: 15000, toMs: 22000, availableAtMs: 15000, text: '后一句完整保留。' },
        { id: 'motion-1', type: 'motion', fromMs: 17000, toMs: 17000, availableAtMs: 17000, text: '镜头切换。' },
        pictures[3]
      ] }
    ]
  } };
}
const jpeg = data => ({ type: 'image', mimeType: 'image/jpeg', data: Buffer.from(data).toString('base64') });
const fetchFrame = async frame => ({
  image: jpeg(String(frame.mediaTimeMs)),
  metadata: {
    panelTimesMs: [frame.mediaTimeMs - 1000, frame.mediaTimeMs - 500, frame.mediaTimeMs],
    storyboardRef: 'private-metadata-path', roomId: 'private-room'
  }
});
const texts = (result) => result.mcpContent.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
const imageTimes = (result) => result.mcpContent.filter((part) => part.type === 'image')
  .map((part) => Number(Buffer.from(part.data, 'base64').toString()));

test('all prepared pictures appear in chronological movie sections with full text', async () => {
  const result = await buildViewingFeed(fixture(), { fetchFrame });
  assert.deepEqual(imageTimes(result), [2000, 5000, 12000, 19000]);
  assert.deepEqual(result.frameSelections.map((frame) => frame.atMs), [2000, 5000, 12000, 19000]);
  assert.equal(result.remainingTick, null);
  const content = texts(result);
  assert.ok(content.includes('0:00–0:10'));
  assert.ok(content.includes('0:10–0:20'));
  assert.ok(content.includes('完整的一句话。'));
  assert.ok(content.includes('后一句完整保留。'));
  assert.ok(content.includes('0:08–0:20 · 声音：连续脚步声。'));
  assert.ok(content.includes('画面动态：镜头切换。'));
  assert.equal(content.match(/你看！/g).length, 2);
  assert.deepEqual(result.deliveredAudioIds, ['sound-1']);
  assert.ok(result.mcpContent.some((part, index) => part.type === 'image'
    && result.mcpContent[index + 1]?.type === 'text'));
  for (const noise of ['private-', 'storyboardRef', 'sourceChunkId', 'availableAtMs', 'seekVersion', 'RGB']) {
    assert.ok(!content.includes(noise), noise);
  }
});

test('parallel image requests retain original order, with bounded in-flight work', async () => {
  const gates = new Map([2000, 5000, 12000, 19000].map((at) => [at, Promise.withResolvers()]));
  const started = [];
  const pending = buildViewingFeed(fixture(), {
    fetchFrame: async (frame) => {
      started.push(frame.mediaTimeMs);
      await gates.get(frame.mediaTimeMs).promise;
      return fetchFrame(frame);
    }
  });
  try {
    assert.deepEqual(started, [2000, 5000]);
    gates.get(5000).resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [2000, 5000]);
    for (const gate of gates.values()) gate.resolve();
    assert.deepEqual(imageTimes(await pending), [2000, 5000, 12000, 19000]);
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await pending;
  }
});

test('one missing image retains every other picture and all dialogue and sound', async () => {
  const result = await buildViewingFeed(fixture(), {
    fetchFrame: (frame) => {
      if (frame.mediaTimeMs === 5000) throw new Error('private missing path');
      return fetchFrame(frame);
    }
  });
  assert.deepEqual(imageTimes(result), [2000, 12000, 19000]);
  assert.ok(texts(result).includes('完整的一句话。'));
  assert.ok(texts(result).includes('连续脚步声。'));
  assert.doesNotMatch(texts(result), /^0:04 · 0:04\.5 · 0:05$/m);
});

test('no available picture still returns complete text without claiming to have seen it', async () => {
  const result = await buildViewingFeed(fixture(), { fetchFrame: async () => { throw new Error('missing'); } });
  assert.deepEqual(imageTimes(result), []);
  assert.equal(result.frameSelections.length, 0);
  assert.ok(texts(result).includes('后一句完整保留。'));
  assert.ok(!texts(result).includes('Storyboard'));
});

test('explicit total image budget retains unsent entries and drains without losing text', async () => {
  let tick = fixture().tick;
  tick.skipPrompt = '正在播放片尾（已设置跳过，未准备画面与声音）';
  const allImages = [];
  let dialogueCount = 0;
  let soundCount = 0;
  let skipPromptCount = 0;
  let calls = 0;
  const progress = [];
  while (tick) {
    const result = await buildViewingFeed({ tick }, { fetchFrame, imageBudgetBytes: 5 });
    allImages.push(...imageTimes(result));
    progress.push(result.deliveredThroughMs);
    dialogueCount += (texts(result).match(/完整的一句话。/g) || []).length;
    soundCount += (texts(result).match(/连续脚步声。/g) || []).length;
    skipPromptCount += (texts(result).match(/正在播放片尾/g) || []).length;
    tick = result.remainingTick;
    calls += 1;
    assert.ok(calls <= 4);
  }
  assert.equal(calls, 4);
  assert.deepEqual(progress, [2000, 11000, 17000, 20000]);
  assert.deepEqual(allImages, [2000, 5000, 12000, 19000]);
  assert.equal(dialogueCount, 1);
  assert.equal(soundCount, 1);
  assert.equal(skipPromptCount, 1);
});

test('a soft total budget smaller than one permitted image still makes progress', async () => {
  const result = await buildViewingFeed(fixture(), { fetchFrame, imageBudgetBytes: 1 });
  assert.deepEqual(imageTimes(result), [2000]);
  assert.ok(result.remainingTick);
});

test('per-image byte limits stay independent from a whole-packet continuation', async () => {
  const result = await buildViewingFeed(fixture(), {
    maxImageBytes: 3,
    fetchFrame
  });
  assert.deepEqual(imageTimes(result), []);
  assert.equal(result.remainingTick, null);
  assert.ok(texts(result).includes('完整的一句话。'));
});

test('future entries are not delivered, while a visible zero-time picture is allowed', async () => {
  const payload = fixture();
  payload.tick.segments[0].entries.push(image(0), image(21000));
  const result = await buildViewingFeed(payload, {
    fetchFrame: async frame => ({ image: jpeg(String(frame.mediaTimeMs)) })
  });
  assert.deepEqual(imageTimes(result), [0, 2000, 5000, 12000, 19000]);
  assert.doesNotMatch(texts(result), /^0:21$/m);
});

test('host cancellation aborts the image batch instead of returning partial success', async () => {
  const controller = new AbortController();
  const started = [];
  const pending = buildViewingFeed(fixture(), {
    signal: controller.signal,
    fetchFrame: (frame, { signal }) => new Promise((resolve, reject) => {
      started.push(frame.mediaTimeMs);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });
  assert.deepEqual(started, [2000, 5000]);
  controller.abort(new DOMException('Stopped', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
});

test('pre-cancelled assembly does not fetch images', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buildViewingFeed(fixture(), {
    signal: controller.signal,
    fetchFrame: () => assert.fail('No fetch expected')
  }), { name: 'AbortError' });
});

test('one lightweight playback check validates both text-only and image results', () => {
  const { tick } = fixture();
  const room = { id: 'room-1', status: 'active', seekVersion: 3, lastPositionMs: 20000 };
  assert.doesNotThrow(() => assertViewingPlayback(tick, room, 'room-1'));
  for (const changed of [null, { ...room, seekVersion: 4 }, { ...room, id: 'room-2' },
    { ...room, status: 'ended' }, { ...room, lastPositionMs: 19000 }]) {
    assert.throws(() => assertViewingPlayback(tick, changed, 'room-1'), { code: 'PLAYBACK_CHANGED' });
  }
});

test('legacy selections also preserve all candidates instead of limiting the call to two', () => {
  const tick = fixture().tick;
  delete tick.packageVersion;
  assert.equal(selectInlineStoryboards(tick).length, 4);
  tick.range.bootstrap = false;
  tick.range.fromMs = tick.range.toMs;
  assert.deepEqual(selectInlineStoryboards(tick), []);
});

test('an image with one recorded time does not receive a fixed three-panel caption', async () => {
  const result = await buildViewingFeed(fixture(), { fetchFrame: async frame => ({
    image: jpeg(String(frame.mediaTimeMs)), metadata: { panelTimesMs: [frame.mediaTimeMs] }
  }) });
  assert.match(texts(result), /^0:02$/m);
});

test('sound is delivered at its start with a future end, without releasing later pictures', async () => {
  const payload = fixture();
  payload.tick.playback.timeMs = 8000;
  payload.tick.newMessages = [];
  const result = await buildViewingFeed(payload, { fetchFrame });
  assert.ok(texts(result).includes('0:08–0:20 · 声音：连续脚步声。'));
  assert.deepEqual(result.deliveredAudioIds, ['sound-1']);
  assert.deepEqual(imageTimes(result), [2000, 5000]);
});


test('live motion beside unified sections is retained without duplicating prepared motion', async () => {
  const payload = fixture();
  payload.tick.motionEvents = [
    { fromMs: 17000, toMs: 17000, text: '镜头切换。' },
    { fromMs: 18000, toMs: 18000, kind: 'motion_peak', direction: 'right' }
  ];
  const result = await buildViewingFeed(payload, { fetchFrame });
  assert.equal((texts(result).match(/镜头切换。/g) || []).length, 1);
  assert.ok(texts(result).includes('0:18 · 画面动态：画面运动向右'));
});


test('Chat human room messages keep arrival order and their literal bodies ahead of film material', async () => {
  const payload = fixture();
  const body = '第一行 *原文*\n\n> 第二行';
  payload.tick.newMessages = [
    { senderKind: 'user', senderName: 'S*[y]', content: body, mediaTimeMs: 15000 },
    { senderKind: 'user', senderName: 'S*[y]', content: body, mediaTimeMs: 11000 },
    { senderKind: 'ai', senderName: '另一个同伴', content: '普通消息', mediaTimeMs: 12000 },
    { senderKind: 'user', senderName: 'S*[y]', interaction: 'popcorn', content: '爆米花', mediaTimeMs: 19000 }
  ];
  const formatted = await buildViewingFeed(payload, { fetchFrame, formatViewerMessages: true, trackImageRefs: true });
  const label = 'S\\*\\[y\\]的房间留言 · ';
  assert.deepEqual(formatted.mcpContent.slice(0, 2).map(block => block.text), [
    '**' + label + '0:15**\n\n' + body, '**' + label + '0:11**\n\n' + body
  ]);
  assert.deepEqual(formatted.blockThroughMs.slice(0, 2), [null, null]);
  assert.equal((texts(formatted).match(/第一行/g) || []).length, 2);
  assert.match(texts(formatted), /0:12 · 另一个同伴：普通消息/);
  assert.match(texts(formatted), /房间互动\n0:19 · S\*\[y\]：爆米花/);
  const ordinary = await buildViewingFeed(payload, { fetchFrame });
  assert.doesNotMatch(texts(ordinary), /的房间留言/);
  assert.match(texts(ordinary), /0:11 · S\*\[y\]：第一行/);
});

test('interactions lead with original times while named chat stays on the movie timeline', async () => {
  const payload = fixture();
  payload.tick.newMessages = [
    { senderName: '鹿鹿', content: '这一幕好可爱', mediaTimeMs: 11000 },
    { senderName: '鹿鹿', content: '递来一桶爆米花 🍿', interaction: 'popcorn', mediaTimeMs: 19000 },
    { content: '没有名字的消息', mediaTimeMs: 15000 }
  ];
  const first = await buildViewingFeed(payload, { fetchFrame, imageBudgetBytes: 1 });
  assert.equal(first.mcpContent[0].text, '房间互动\n0:19 · 鹿鹿：递来一桶爆米花 🍿');
  let combined = texts(first);
  let rest = first.remainingTick;
  while (rest) {
    const next = await buildViewingFeed({ tick: rest }, { fetchFrame, imageBudgetBytes: 1 });
    assert.ok(!texts(next).includes('爆米花'));
    combined += texts(next);
    rest = next.remainingTick;
  }
  assert.equal(combined.match(/爆米花/g).length, 1);
  assert.ok(combined.includes('0:11 · 鹿鹿：这一幕好可爱'));
  assert.ok(combined.includes('0:15 · user：没有名字的消息'));
  assert.ok(combined.indexOf('这一幕好可爱') < combined.indexOf('没有名字的消息'));
});

const imageBytes = result => result.mcpContent.filter(block => block.type === 'image')
  .map(block => Buffer.from(block.data, 'base64'));

test('prepared images at the same release time retain package order across catch-up pages', async () => {
  const base = fixture().tick;
  const packets = ['z-full', 'a-detail'].map((id, index) => {
    const entry = { ...image(1000), id, storyboardRef: id + '.jpg' };
    return {
      tick: { ...base, range: { fromMs: index * 1000, toMs: (index + 1) * 1000 },
        more: index === 0, newMessages: [], storyboards: undefined,
        segments: [{ id: 'section', fromMs: 0, toMs: 2000, entries: [entry] }] },
      state: { roomId: 'room-1', cursors: { mediaMs: (index + 1) * 1000, seekVersion: 3 } }
    };
  });
  const result = await collectViewingCatchup({ requestTick: async () => packets.shift() });
  assert.deepEqual(result.tick.storyboards.map(entry => entry.storyboardRef), ['z-full.jpg', 'a-detail.jpg']);
  const feed = await buildViewingFeed(result, { fetchFrame: async frame => ({
    image: jpeg(frame.storyboardRef)
  }) });
  assert.deepEqual(imageBytes(feed).map(bytes => bytes.toString()), ['z-full.jpg', 'a-detail.jpg']);
});

test('JPEG file budgeting continues inside each group and preserves packaged order, bytes and captions', async () => {
  const payload = fixture();
  const groups = payload.tick.storyboards;
  const files = new Map();
  for (const group of groups) {
    group.parts = [1, 2].map(index => {
      const ref = group.storyboardRef + '-' + index;
      files.set(ref, Buffer.from([0xff, 0xd8, index, 0xff, 0xd9]));
      return { ref, mediaTimeMs: group.mediaTimeMs - 2 + index };
    });
  }
  const read = async frame => ({
    image: jpeg(files.get(frame.storyboardRef)),
    metadata: { panelTimesMs: [frame.mediaTimeMs], views: [
      { type: 'full', sourceIndex: 0, mediaTimeMs: 1000, box: [0, 0, 100, 80] },
      { type: 'crop', sourceIndex: 0, mediaTimeMs: 1100, anchorTimeMs: 1000, box: [22, 35, 12, 10],
        sourceBox: [.39, .34, .56, .54] }
    ] }
  });
  const expected = [...files.values()];
  const catchUp = await buildViewingFeed(payload, { fetchFrame: read });
  assert.deepEqual(imageBytes(catchUp), expected);
  const first = await buildViewingFeed(payload, { imageBudgetBytes: 3, fetchFrame: read });
  assert.deepEqual(first.remainingTick.segments[0].entries[0].parts, [groups[0].parts[1]]);
  assert.match(texts(first), /^0:01 → 0:01\.1$/m);
  const paged = imageBytes(first);
  assert.equal(paged.length, 1);
  let remaining = first.remainingTick;
  for (let page = 1; remaining; page++) {
    assert.ok(page < expected.length);
    const next = await buildViewingFeed({ tick: remaining }, { imageBudgetBytes: 3, fetchFrame: read });
    const bytes = imageBytes(next);
    assert.equal(bytes.length, 1);
    paged.push(...bytes);
    remaining = next.remainingTick;
  }
  assert.deepEqual(paged, expected);
});

test('a missing prepared file leaves the other prepared files and their original captions deliverable', async () => {
  const payload = fixture();
  const group = payload.tick.storyboards[0];
  const detail = Buffer.from('already prepared detail');
  group.parts = [{ ref: group.storyboardRef, mediaTimeMs: 1000 }, { ref: 'detail.jpg', mediaTimeMs: 1500 }];
  const result = await buildViewingFeed(payload, { fetchFrame: async frame => {
    if (frame.storyboardRef === group.storyboardRef) throw new Error('picture missing');
    if (frame.storyboardRef !== 'detail.jpg') return fetchFrame(frame);
    return {
      image: jpeg(detail),
      metadata: { panelTimesMs: [2000], views: [
        { type: 'crop', sourceIndex: 0, mediaTimeMs: 1500, anchorTimeMs: 1000, box: [0, 0, 12, 10],
          sourceBox: [.39, .34, .56, .54] }
      ] }
    };
  } });
  assert.deepEqual(imageBytes(result)[0], detail);
  assert.match(texts(result), /^0:01 → 0:01\.5$/m);
  assert.deepEqual(result.frameSelections[0].parts, [{ ref: 'detail.jpg', times: [1500], text: '0:01 → 0:01.5' }]);
});

test('HD hint appears once and only for a frame attached to this reply', async () => {
  async function read(frame) {
    if (frame.mediaTimeMs === 19000) throw new Error('frame unavailable');
    const result = await fetchFrame(frame);
    result.metadata.hdAvailable = frame.mediaTimeMs > 2000;
    return result;
  }
  const first = await buildViewingFeed(fixture(), { fetchFrame: read, imageBudgetBytes: 1 });
  assert.doesNotMatch(texts(first), /cinema_inspect_frame/);
  const later = await buildViewingFeed({ tick: first.remainingTick }, { fetchFrame: read });
  assert.equal(texts(later).match(/cinema_inspect_frame/g)?.length, 1);
  assert.match(texts(later), /0:12 可看高清单帧：cinema_inspect_frame\(\{atMs:12000, quality:"hd"\}\)/);
  const unavailable = await buildViewingFeed(fixture(), { fetchFrame: async () => { throw Error(); } });
  assert.doesNotMatch(texts(unavailable), /cinema_inspect_frame/);
});
