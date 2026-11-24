const baseUrl = process.argv[2] || 'http://127.0.0.1:4182';

const healthResponse = await fetch(`${baseUrl}/api/health`);
if (!healthResponse.ok) throw new Error(`Health endpoint returned ${healthResponse.status}`);
const health = await healthResponse.json();
if (health.ok !== true) throw new Error('Health endpoint did not report ok=true');

const mediaResponse = await fetch(`${baseUrl}/api/media`);
if (!mediaResponse.ok) throw new Error(`Media endpoint returned ${mediaResponse.status}`);
const media = await mediaResponse.json();
if (!Array.isArray(media.items)) throw new Error('Media endpoint did not return an items array');

const pageResponse = await fetch(baseUrl);
if (!pageResponse.ok) throw new Error(`Cinema page returned ${pageResponse.status}`);
const page = await pageResponse.text();
if (!page.includes('Open Watch Cinema')) throw new Error('Cinema page title was not found');

if (media.items.length > 0) {
  const item = media.items[0];
  const rangeResponse = await fetch(`${baseUrl}${item.streamUrl}`, {
    headers: { Range: 'bytes=0-1023' }
  });
  if (rangeResponse.status !== 206) {
    throw new Error(`Range request returned ${rangeResponse.status} instead of 206`);
  }
  if (!String(rangeResponse.headers.get('content-range') || '').startsWith('bytes 0-1023/')) {
    throw new Error('Range response did not contain the expected content-range header');
  }
  const bytes = new Uint8Array(await rangeResponse.arrayBuffer());
  if (bytes.byteLength !== 1024) throw new Error(`Expected 1024 bytes, received ${bytes.byteLength}`);
}

console.log(`smoke: PASS (${media.items.length} indexed film${media.items.length === 1 ? '' : 's'})`);
