export function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

export function toolErrorResult(error) {
  const publicCodes = new Set(['PLAYBACK_CHANGED', 'REQUEST_TIMEOUT', 'CONNECTION_FAILED',
    'AI_PROFILE_REQUIRED', 'AI_PROFILE_UNAVAILABLE', 'INVALID_ACTION', 'INVALID_ARGUMENTS', 'WRITE_OUTCOME_UNKNOWN', 'CINEMA_UNREACHABLE', 'CINEMA_INCOMPATIBLE',
    'AI_PACKAGE_INCOMPLETE', 'INVALID_ARGUMENT', 'ROOM_UNAVAILABLE', 'MEDIA_NOT_FOUND',
    'NOTEBOOK_VERSION_CONFLICT', 'NOTEBOOK_ENTRY_UNAVAILABLE', 'NOTEBOOK_LIMIT',
    'FRAME_UNAVAILABLE', 'INVALID_VIEWING_RESPONSE', 'RESOURCE_UNAVAILABLE', 'REQUEST_CONFLICT', 'UNKNOWN_TOOL']);
  const code = publicCodes.has(error?.code) ? error.code
    : error instanceof TypeError || error instanceof RangeError ? 'INVALID_ARGUMENT' : 'CINEMA_REQUEST_FAILED';
  const retryable = ['PLAYBACK_CHANGED', 'REQUEST_TIMEOUT', 'CONNECTION_FAILED', 'AI_PROFILE_UNAVAILABLE'].includes(code);
  const nextAction = code === 'PLAYBACK_CHANGED' ? 'REFRESH_TICK'
    : code === 'AI_PROFILE_REQUIRED' ? 'SELECT_PROFILE_IN_SETTINGS'
    : code === 'WRITE_OUTCOME_UNKNOWN' ? 'CHECK_RESULT'
    : ['CINEMA_UNREACHABLE', 'CINEMA_INCOMPATIBLE', 'AI_PROFILE_UNAVAILABLE'].includes(code) ? 'CHECK_CINEMA'
    : code === 'AI_PACKAGE_INCOMPLETE' ? 'PREPARE_FILM'
    : ['NOTEBOOK_VERSION_CONFLICT', 'NOTEBOOK_ENTRY_UNAVAILABLE', 'NOTEBOOK_LIMIT'].includes(code) ? 'READ_NOTEBOOK'
    : code === 'INVALID_ARGUMENT' ? 'CHECK_ARGUMENTS'
    : code === 'ROOM_UNAVAILABLE' ? 'CHECK_ROOM' : 'NONE';
  const backendMessages = {
    AI_PROFILE_REQUIRED: '请在影院设置里选择或新建一个 AI 档案，然后再试一次。',
    NOTEBOOK_VERSION_CONFLICT: 'This notebook field changed. Read the current entry before saving.',
    NOTEBOOK_ENTRY_UNAVAILABLE: 'That notebook entry is unavailable. Read the current notebook.',
    NOTEBOOK_LIMIT: 'The film notebook has reached its entry limit.',
    INVALID_ARGUMENT: 'Please check the tool arguments and try again.',
    RESOURCE_UNAVAILABLE: 'That cinema item is unavailable right now. Refresh its current state.',
    REQUEST_CONFLICT: 'This action is unavailable in the current room state. Check the room or preparation progress.',
    MEDIA_NOT_FOUND: 'This film is no longer in the library. Refresh the film list.',
    ROOM_UNAVAILABLE: 'That viewing room is unavailable. Check the current room list.',
    AI_PACKAGE_INCOMPLETE: 'The film\'s viewing materials are not fully ready. Check the preparation status.',
    PLAYBACK_CHANGED: 'The film has moved to a new position. Pick up from the latest playback time.'
  };
  const line = error?.notebookLine;
  const message = line && ['INVALID_ARGUMENT', 'NOTEBOOK_VERSION_CONFLICT', 'NOTEBOOK_ENTRY_UNAVAILABLE', 'NOTEBOOK_LIMIT'].includes(code) ? error.message
    : error?.status && backendMessages[code] ? backendMessages[code]
    : code === 'FRAME_UNAVAILABLE' ? 'That film image is unavailable right now.'
    : code === 'CINEMA_REQUEST_FAILED' || code === 'INVALID_VIEWING_RESPONSE'
    ? 'The cinema could not finish this request. Check the local cinema service.'
    : error instanceof Error ? error.message : 'Something went wrong with the cinema request.';
  // Server paths, raw response bodies and diagnostic stacks stay out of the tool result.
  return textResult({ error: code, message, status: error?.status || null, ...(line ? { line } : {}), retryable, nextAction }, true);
}
