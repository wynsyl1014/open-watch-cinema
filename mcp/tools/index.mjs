import { createNotebookTools } from './notebook.mjs';
import { createManagementTools } from './management.mjs';
import { createControlTools } from './control.mjs';
import { createHistoryTools } from './history.mjs';
import { createViewingTools } from './viewing.mjs';

export function createToolRegistry(dependencies) {
  const entries = [
    ...createViewingTools(dependencies),
    ...createNotebookTools(dependencies),
    ...(dependencies.enableHistory ? createHistoryTools(dependencies) : []),
    ...(dependencies.enableControl ? [...createControlTools(dependencies), ...createManagementTools(dependencies)] : [])
  ];
  const handlers = new Map();
  for (const { definition, handler } of entries) {
    if (handlers.has(definition.name)) throw new Error(`Duplicate tool: ${definition.name}`);
    handlers.set(definition.name, handler);
  }
  return {
    definitions: entries.map(({ definition }) => definition),
    async call(name, rawArguments, context = {}) {
      const args = dependencies.requireObject(rawArguments || {});
      const signal = context.signal;
      signal?.throwIfAborted();
      const handler = handlers.get(name);
      if (!handler) throw dependencies.cinemaError('UNKNOWN_TOOL', `影院没有这个工具：${name}。`);
      const seekVersion = context.expectedSeekVersion;
      const request = (path, options = {}) => dependencies.cinemaRequest(path, {
        ...options, signal,
        ...(Number.isSafeInteger(seekVersion) ? {
          headers: { ...options.headers, 'x-owc-expected-seek-version': String(seekVersion) }
        } : {})
      });
      return handler(args, { ...context, signal, request });
    }
  };
}
