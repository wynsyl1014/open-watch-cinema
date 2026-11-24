import { actionGroup } from './action-group.mjs';
import { createPreparationTools } from './preparation.mjs';
import { createRoomActions } from './room-actions.mjs';
export function createManagementTools(deps) {
  const entries = [...createPreparationTools(deps), ...createRoomActions(deps)];
  const actions = Object.fromEntries(entries.map(e => [e.definition.name.replace('cinema_', ''), e]));
  return [actionGroup('cinema_manage', 'Manage screenings and preparation: status, list_media, rescan, prepare_ai, job_status, list_rooms, open_room, end_room. Opening/ending a room follows the viewer’s choice.', actions, deps.cinemaError)];
}
