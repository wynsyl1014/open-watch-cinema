import { createHash } from 'node:crypto';

const readFilters = ['section', 'character', 'fromMs', 'toMs', 'unresolved'];
const instructions = [
  'Read or update the current film notebook. Read returns plain text with #key/vVersion references.',
  'Write a batch in one text string. Use only relevant headings, one entry per line:',
  '[人物] @name | bio | optional appearance; [关系] @A -> @B | label | optional note (or | 推测 | note);',
  '[剧情] @A @B | event; [疑问] question | optional detail; [随记] thought.',
  '[解答] #key/vVersion | answer; [修订] #key/vVersion | field | new value.',
  'Place each [heading] on its own line. Accepted edit fields: 正文、小传、外貌、名字、关系、备注、推测、答案、方向.',
  'Time defaults to the current playhead. Optionally prefix a line with {mm:ss}.',
  'Identical writes by this AI in one room are replayed; supply a distinct requestId only for an intentional repeat.',
  'Legacy save/delete remain available.'
].join(' ');

export function createNotebookTools({ bindSelectedProfile }) {
  return [{
    definition: {
      name: 'cinema_notebook',
      description: instructions,
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['read', 'write', 'save', 'delete'] },
          kind: { type: 'string', enum: ['note', 'character', 'relation'] },
          text: { type: 'string', maxLength: 32000 },
          requestId: { type: 'string', minLength: 1, maxLength: 120 },
          section: { type: 'string' }, character: { type: 'string' },
          fromMs: { type: 'integer', minimum: 0 }, toMs: { type: 'integer', minimum: 0 },
          unresolved: { type: 'boolean' }, name: { type: 'string', maxLength: 80 },
          appearance: { type: 'string', maxLength: 2000 },
          id: { type: 'string' }, expectedVersion: { type: 'integer', minimum: 1 },
          characterIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          eventAtMs: { type: 'integer', minimum: 0 }
        }, required: ['action']
      }
    },
    async handler(args, { request, signal }) {
      if (!['read', 'write', 'save', 'delete'].includes(args.action)) throw new Error('Unknown notebook action.');
      if (args.action === 'read') {
        const query = new URLSearchParams({ format: 'text' });
        for (const key of readFilters) {
          if (args[key] !== undefined) query.set(key, String(args[key]));
        }
        const result = await request('/api/ai/notebook?' + query.toString());
        return { mcpContent: [{ type:'text', text:result.text }] };
      }
      const actorId = await bindSelectedProfile({ signal });
      if (args.action === 'write') {
        if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 32000) {
          throw new TypeError('Write needs between 1 and 32000 characters of notebook text.');
        }
        if (args.requestId !== undefined && (typeof args.requestId !== 'string' || !args.requestId.trim() || args.requestId.length > 120)) {
          throw new TypeError('requestId must be a nonempty string of at most 120 characters.');
        }
        const { roomId } = await request('/api/ai/notebook?format=context');
        const text = args.text.replace(/\r\n/g, '\n').trim();
        const hash = createHash('sha256').update(JSON.stringify([roomId, actorId, args.requestId === undefined ? 'text' : 'request', args.requestId ?? text])).digest('hex');
        const result = await request('/api/ai/notebook', { method: 'POST',
          body: JSON.stringify({action:'write', actorId, expectedRoomId:roomId, requestId:hash, text}) });
        return { mcpContent: [{type:'text', text:result.text}] };
      }
      return request('/api/ai/notebook', { method:'POST', body:JSON.stringify({...args, actorId}) });
    }
  }];
}
