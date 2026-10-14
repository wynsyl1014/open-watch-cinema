import { selectVisualArc } from '../src/storyboard-selection.mjs';

// Attach a small amount of visual evidence to each incremental MCP response.
export function selectInlineStoryboards(tick) {
  const fromMs = tick.range.fromMs;
  const throughMs = Math.min(tick.range.toMs, tick.playback.playheadMs);
  const candidates = (tick.storyboards || []).filter((frame) => (
    frame.mediaTimeMs <= throughMs
    // Track windows exclude their end, so an image exactly at fromMs is new.
    && (tick.range.bootstrap || tick.range.seekDetected || (throughMs > fromMs && frame.mediaTimeMs >= fromMs))
  )).sort((a, b) => a.mediaTimeMs - b.mediaTimeMs);
  return selectVisualArc(candidates, 2);
}

export async function buildViewingFeed(payload, { fetchFrame, readRoom }) {
  const tick = payload.tick;
  const selected = selectInlineStoryboards(tick);
  const attachments = [];
  const images = [];
  for (const frame of selected) {
    try {
      const result = await fetchFrame(frame);
      const image = result.mcpContent.find((block) => block.type === 'image');
      if (!image || image.data.length > 2 * 1024 * 1024) {
        throw new Error('Selected image is missing or exceeds the inline size limit.');
      }
      const metadataText = result.mcpContent.find((block) => block.type === 'text')?.text;
      const metadata = metadataText ? JSON.parse(metadataText) : {};
      const caption = { storyboardRef: frame.storyboardRef, mediaTimeMs: frame.mediaTimeMs,
        panelTimesMs: metadata.panelTimesMs || null };
      images.push({ ...caption, status: 'attached' });
      attachments.push({ type: 'text', text: JSON.stringify({ visualEvidence: caption }) }, image);
    } catch (error) {
      images.push({ storyboardRef: frame.storyboardRef, mediaTimeMs: frame.mediaTimeMs,
        status: 'unavailable', note: error.message });
    }
  }
  // Frames are read asynchronously: do not release the old packet after a seek.
  if (selected.length) {
    const room = await readRoom();
    if (!room || room.status !== 'active' || room.seekVersion !== tick.playback.seekVersion
        || room.lastPositionMs < tick.playback.playheadMs) {
      throw new Error('Playback changed while attaching images. Retry the tick with the same input cursors.');
    }
  }
  const enriched = { ...payload, tick: { ...tick,
    visualEvidence: { images, maxImages: 2, note: 'Inspect attached images alongside dialogue. These are selected moments, not continuous video.' },
    audioEvidence: { kind: 'generated_caption', reliability: 'unverified',
      guidance: 'Audio captions describe possible sounds. They do not establish the visible setting, who is speaking, motives, or emotion. Sounds may come from a game, recording, or soundtrack. Ground scene understanding in images and dialogue; leave conflicts uncertain.' }
  } };
  return { mcpContent: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }, ...attachments] };
}
