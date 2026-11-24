import { createManagementTools } from '../../../mcp/tools/management.mjs';
import { createControlTools } from '../../../mcp/tools/control.mjs';
import { createHistoryTools } from '../../../mcp/tools/history.mjs';
import { createNotebookTools } from '../../../mcp/tools/notebook.mjs';
import { createViewingTools } from '../../../mcp/tools/viewing.mjs';
import { createCinemaClient } from '../../../mcp/runtime/cinema-client.mjs';
import { createActivityReporter } from '../../../mcp/runtime/activity.mjs';
import { textResult, toolErrorResult } from '../../../mcp/runtime/results.mjs';
import { cinemaError, requireObject, requireInteger, requireString, optionalString } from '../../../mcp/runtime/validation.mjs';
import { aiExperienceWarning } from '../../../mcp/viewing/viewing-guidance.mjs';

const viewingNames = ['cinema_inspect_frame', 'cinema_post_message', 'cinema_notebook'];
export const CHAT_MANUAL_TIMEOUT_MS = 25_000;
const tickName = 'open_watch_cinema_tick';
const viewingTools = createViewingTools({});
export const activityFields = Object.freeze({
  activity: [],
  activity_calls: ['connectionId', 'offset', 'limit'],
  activity_call: ['connectionId', 'callId'],
  activity_image: ['connectionId', 'callId', 'index']
});

const cacheId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

export function validActivityRequest({ action, connectionId, callId, offset, limit, index }) {
  if (action === 'activity') return true;
  if (!cacheId(connectionId)) return false;
  if (action === 'activity_calls') {
    return (offset === undefined || nonnegative(offset))
      && (limit === undefined || (Number.isSafeInteger(limit) && limit >= 1 && limit <= 200));
  }
  return cacheId(callId) && (action === 'activity_call' || (action === 'activity_image' && nonnegative(index)));
}
const factories = {
  viewing: [
    ...viewingTools, ...createNotebookTools({})
  ].filter(({ definition }) => viewingNames.includes(definition.name)),
  manual: viewingTools.filter(({ definition }) => definition.name === tickName),
  history: createHistoryTools({}),
  control: [...createControlTools({}), ...createManagementTools({})]
};
const toolGroup = new Map(Object.entries(factories).flatMap(([group, entries]) =>
  entries.map(({ definition }) => [definition.name, group])));

export function chatToolGroup(name) {
  return toolGroup.get(name);
}

export function isChatToolEnabled(name, { enableManual, enableHistory, enableControl }) {
  const group = chatToolGroup(name);
  return group === 'viewing' || (group === 'manual' && enableManual === true)
    || (group === 'history' && enableHistory === true)
    || (group === 'control' && enableControl === true);
}

const readOnly = new Set([tickName, 'cinema_inspect_frame', 'cinema_read_window']);
export const chatRoomTools = Object.values(factories).flat().map(({ definition }) => ({
  ...definition,
  annotations: {
    readOnlyHint: readOnly.has(definition.name),
    destructiveHint: ['cinema_notebook', 'cinema_manage'].includes(definition.name),
    openWorldHint: false
  },
  _meta: { ui: { visibility: ['model'] } }
}));

export function createChatControlTools({ cinemaUrl, signal: cardSignal, connectionId, getProfileId }) {
  const { cinemaRequest, discoverCinema } = createCinemaClient({ urls: [cinemaUrl] });
  const activity = createActivityReporter({ cinemaRequest, connectionId, getProfileId });
  const deps = { discoverCinema, cinemaError, requireInteger, requireString, optionalString, aiExperienceWarning,
    clientState: {} };
  const handlers = new Map([...createControlTools(deps), ...createManagementTools(deps)].map(
    entry => [entry.definition.name, entry]));
  cardSignal.addEventListener('abort', activity.close, { once: true });
  return async (name, args, signal) => {
    const active = signal ? AbortSignal.any([cardSignal, signal]) : cardSignal;
    const started = activity.begin();
    const { definition, handler } = handlers.get(name);
    let result;
    try {
      active.throwIfAborted();
      const data = await handler(requireObject(args ?? {}), {
        signal: active,
        request: (path, options) => cinemaRequest(path, { ...options, signal: active })
      });
      active.throwIfAborted();
      result = textResult(data);
    } catch (error) {
      result = toolErrorResult(error);
    }
    const action = definition.inputSchema.properties.action.enum.includes(args?.action) ? args.action : undefined;
    if (!active.aborted) activity.delivered(started, { tool: name, action, isError: result.isError === true,
      content: result.content, profileId: getProfileId(), finishedAt: Math.max(started.startedAt, Date.now()) });
    return result;
  };
}
