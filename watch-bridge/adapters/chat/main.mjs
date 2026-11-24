import { readFile } from 'node:fs/promises';
import { startStdio } from '../../../mcp/runtime/protocol.mjs';
import { createChatProtocol, createChatTransport } from './server.mjs';

const [template, activityScript, activityStyle] = await Promise.all(
  ['./card.html', '../../../public/ai-activity.js', '../../../public/ai-activity.css']
    .map(path => readFile(new URL(path, import.meta.url), 'utf8'))
);
const html = template
  .replace('<style data-activity></style>', () => `<style>
${activityStyle}
</style>`)
  .replace('<script type="module" data-activity></script>', () => `<script type="module">
${activityScript}
window.createCinemaAiActivity = createAiActivity;
window.dispatchEvent(new Event('cinema-activity-ready'));
</script>`);
startStdio(createChatProtocol({ html, transport: createChatTransport() }));
