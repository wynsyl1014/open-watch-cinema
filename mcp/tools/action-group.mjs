// Compose a small public action surface; reject unknown keys before dispatch.
export function actionGroup(name, description, actions, cinemaError) {
  const routes = new Map(Object.entries(actions));
  return { definition: { name, description, inputSchema: {
    type: 'object', properties: { action: { type: 'string', enum: [...routes.keys()] },
      parameters: { type: 'object', description: 'Arguments for the selected action; see the matching oneOf branch.' } },
    required: ['action'], additionalProperties: false,
    oneOf: [...routes].map(([action, entry]) => ({ properties: {
      action: { const: action }, parameters: entry.definition.inputSchema
    }, ...(entry.definition.inputSchema.required?.length ? { required: ['parameters'] } : {}) }))
  } }, async handler(args, context) {
    if (Object.keys(args).some(k => !['action', 'parameters'].includes(k))) throw cinemaError('INVALID_ARGUMENTS', 'Only action and parameters are accepted.');
    const entry = routes.get(args.action);
    if (!entry) throw cinemaError('INVALID_ACTION', '这个工具没有该操作。');
    const parameters = args.parameters ?? {};
    const schema = entry.definition.inputSchema;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
      || Object.keys(parameters).some(k => !Object.hasOwn(schema.properties, k))
      || (schema.required || []).some(k => !Object.hasOwn(parameters, k))) {
      throw cinemaError('INVALID_ARGUMENTS', 'Arguments do not match this action.');
    }
    for (const [key, value] of Object.entries(parameters)) {
      const rule = schema.properties[key];
      const invalid = (rule.type === 'string' && (typeof value !== 'string' || value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? Infinity)))
        || (rule.type === 'boolean' && typeof value !== 'boolean')
        || (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity)))
        || (rule.enum && !rule.enum.includes(value));
      if (invalid) throw cinemaError('INVALID_ARGUMENTS', 'Invalid parameter: ' + key);
    }
    return entry.handler(parameters, context);
  } };
}
