import { createHash } from 'node:crypto';

const IMAGE_LIMIT = 16;
const IMAGE_REFS = 'open-watch-cinema/bridgeFrameRefs';
const BLOCK_TIMES = 'open-watch-cinema/bridgeBlockThroughMs';

function digest(data) {
  return createHash('sha256').update(data, 'base64').digest('hex');
}

export function describeDeliveryBlocks(result, rememberImage) {
  const refs = new Map(result._meta?.[IMAGE_REFS]?.map(ref => [ref.index, ref]));
  return result.content.map((block, index) => {
    if (block.type === 'text') {
      const throughMs = result._meta?.[BLOCK_TIMES]?.[index];
      return Number.isFinite(throughMs) ? { ...block, throughMs } : block;
    }
    const frame = refs.get(index);
    if (block.type !== 'image' || !frame || block.mimeType !== 'image/jpeg') {
      throw new Error('影院无法为待送图文保留分镜引用。');
    }
    const descriptor = { type: 'image', ref: frame.ref, mediaTimeMs: frame.mediaTimeMs,
      throughMs: frame.throughMs, hash: digest(block.data) };
    rememberImage?.(descriptor, block);
    return descriptor;
  });
}

export function nextDeliveryBatch(blocks, visibleThrough = Infinity) {
  let images = 0;
  let end = blocks.length;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const beyondCurrentPlayback = Number.isFinite(block.throughMs) && block.throughMs > visibleThrough;
    const overImageLimit = block.type === 'image' && ++images > IMAGE_LIMIT;
    if (!beyondCurrentPlayback && !overImageLimit) continue;
    // The feed puts the next frame's caption as the last line in its preceding text block.
    end = block.type === 'image' && blocks[index - 1]?.type === 'text' ? index - 1 : index;
    break;
  }
  const chunk = blocks.slice(0, end);
  return { chunk, count: end, done: end === blocks.length };
}

export async function readPendingImage({ cinemaUrl, roomId, seekVersion, frame, signal, feedToken }) {
  const query = new URLSearchParams({
    storyboardRef: frame.ref, mediaTimeMs: String(frame.mediaTimeMs), quality: 'storyboard'
  });
  const response = await fetch(new URL('/api/rooms/' + roomId + '/ai-frame?' + query, cinemaUrl), {
    headers: { 'x-owc-expected-room': roomId, 'x-owc-expected-seek-version': String(seekVersion),
      ...(feedToken && { 'x-owc-chat-feed-token': feedToken }) },
    signal, redirect: 'error'
  });
  const mimeType = response.headers.get('content-type');
  if (!response.ok || mimeType !== 'image/jpeg') {
    await response.body?.cancel();
    throw new Error('影院暂时无法重读待送的分镜。');
  }
  const data = Buffer.from(await response.arrayBuffer()).toString('base64');
  return { type: 'image', mimeType, data };
}

export async function materializeDelivery(blocks, loadImage) {
  const content = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
      continue;
    }
    const image = await loadImage(block);
    if (image?.type !== 'image' || image.mimeType !== 'image/jpeg' || digest(image.data) !== block.hash) {
      throw new Error('待送分镜已发生变化，影院保留这批内容等待处理。');
    }
    content.push(image);
  }
  return content;
}
