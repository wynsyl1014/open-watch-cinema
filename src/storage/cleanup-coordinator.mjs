import { randomUUID } from 'node:crypto';
import {
  knownCleanupFilms, previewCleanupRecords, approveCleanup, pendingCleanups,
  finishCleanup, cancelCleanup
} from './film-cleanup.mjs';

const fail = (message, statusCode = 409) => Object.assign(new Error(message), {statusCode});
const categories = ['video', 'subtitles', 'package', 'records', 'folder'];

function cleanTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) {
    throw fail('请选择一部影片或一个合集。', 400);
  }
  if (typeof value.mediaId === 'string' && /^[a-f0-9]{24}$/.test(value.mediaId)) return {mediaId:value.mediaId};
  if (typeof value.collectionPath === 'string' && value.collectionPath.length > 0
      && value.collectionPath.split('/').every(part => part && !part.startsWith('.') && !part.includes('\\'))) {
    return {collectionPath:value.collectionPath};
  }
  throw fail('清理目标无效。', 400);
}

function cleanSelection(input, target, dissolve) {
  if (dissolve) {
    if (!target.collectionPath || (input && Object.keys(input).length)) throw fail('解散合集只移动内容。',400);
    return {};
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !categories.includes(key) || typeof input[key] !== 'boolean')
      || !Object.values(input).some(Boolean)) {
    throw fail('请勾选要清理的项目。',400);
  }
  return Object.fromEntries(categories.map(key => [key, input[key] === true]));
}

export function createCleanupCoordinator({db, library, edits, busy, updated}) {
  const previews = new Map();
  let applying = false;

  async function inspect(target) {
    const storage = await library.previewCleanup(target);
    let films = storage.films;
    if (target.mediaId && !films.length) {
      const film = knownCleanupFilms(db).find(row => row.id === target.mediaId);
      if (!film) throw fail('找不到这部影片。',404);
      films = [{id:film.id,title:film.title,relativePath:film.relativePath,hasVideo:false}];
    }
    const ids = films.map(film => film.id);
    const records = previewCleanupRecords(db,ids);
    const rooms = records.films.flatMap(film => film.rooms);
    const busyFilms = films.filter(film => busy(film.id) || edits.has(film.id)
      || records.films.some(row => row.mediaId === film.id && row.activeRoomCount > 0)).map(film => film.title);
    const preview = {...storage,films,mediaIds:ids,busy:Boolean(storage.busy || busyFilms.length),
      busyFilms:[...new Set([...(storage.busyFilms || []),...busyFilms])],
      rooms:rooms.map(({id,mediaId,mediaTitle,openedAt,messageCount}) => ({id,mediaId,mediaTitle,openedAt,messageCount})),
      sessionCount:rooms.length, messageCount:rooms.reduce((n,room)=>n+room.messageCount,0),
      notebookCount:records.films.filter(film=>film.notebookEntryCount>0).length,
      entryCount:records.films.reduce((n,film)=>n+film.notebookEntryCount,0)};
    return {preview, records};
  }

  async function execute(receipt) {
    const {target, selected, revision, dissolve} = receipt.filesystem;
    const files = dissolve || selected.video || selected.subtitles || selected.package || selected.folder;
    if (files) {
      if (dissolve) await library.dissolveCollection(target.collectionPath,revision,receipt.id);
      else await library.applyCleanup(target,selected,revision,receipt.id);
    }
    finishCleanup(db,receipt.id);
    if (files) await library.ackCleanup(receipt.id).catch(error => console.error('清理回执将在重启时回收：',error.message));
  }

  async function resolveFailure(receipt) {
    const operation = (await library.listCleanupOperations()).find(job=>job.id===receipt.id);
    if (operation) return false;
    cancelCleanup(db,receipt.id);
    return true;
  }

  return {
    async preview(input) {
      const target = cleanTarget(input);
      const {preview,records} = await inspect(target);
      const token = randomUUID();
      previews.set(token,{target,revision:preview.revision,recordsRevision:records.revision});
      while (previews.size>64) previews.delete(previews.keys().next().value);
      return {...preview,token};
    },

    async apply(body) {
      const target = cleanTarget(body.target);
      const prior = previews.get(body.token);
      if (!prior || JSON.stringify(prior.target)!==JSON.stringify(target)) throw fail('请重新打开清理预览。');
      if (body.action !== undefined && body.action !== 'dissolve') throw fail('未知合集操作。',400);
      const dissolve = body.action==='dissolve';
      const selected = cleanSelection(body.selected,target,dissolve);
      if (applying) throw fail('另一项清理正在执行，请稍后重试。');
      applying = true;
      let locked = [], receipt;
      try {
        const {preview,records} = await inspect(target);
        if (preview.revision!==prior.revision || records.revision!==prior.recordsRevision) throw fail('内容已变化，请重新预览。');
        if (preview.busy) throw fail('有影片正在使用或写入，请稍后重试。'+preview.busyFilms.join('、'));
        if ((dissolve || selected.folder) && preview.unknownPaths.length) throw fail('请先移出额外文件：'+preview.unknownPaths.join('、'));
        if (dissolve && !preview.canDissolve) throw fail('暂时无法解散合集。'+preview.moveConflicts.join('、'));
        if (selected.folder && ((preview.videoCount && !selected.video) || (preview.subtitleFileCount && !selected.subtitles)
            || (preview.packageCount && !selected.package)
            || (target.mediaId && (preview.sessionCount || preview.entryCount) && !selected.records))) throw fail('目录内仍有未勾选清理的资料，请保留目录或调整选择。');
        const filesystem = {target,selected,revision:preview.revision,dissolve};
        locked = preview.mediaIds;
        for (const id of locked) edits.add(id);
        receipt = approveCleanup(db,{id:randomUUID(),preview:records,scopes:{records:Boolean(selected.records)},filesystem});
        previews.delete(body.token);
        await execute(receipt);
      } catch (error) {
        if (receipt && !await resolveFailure(receipt)) {
          locked = []; // Recovery owns these locks until both stores have finished.
        }
        throw error;
      } finally {
        for (const id of locked) edits.delete(id);
        applying = false;
      }
      await updated();
      return {ok:true};
    },

    async recover(onlyPending = false) {
      const receipts = pendingCleanups(db);
      if (applying || (onlyPending && !receipts.length)) return;
      applying = true;
      try {
        for (const receipt of receipts) {
          const ids = receipt.preview.films.map(film=>film.mediaId);
          ids.forEach(id=>edits.add(id));
          try {
            await execute(receipt);
          } catch (error) {
            if (!await resolveFailure(receipt)) {
              console.error('清理尚待恢复：',error.message);
              continue;
            }
          }
          ids.forEach(id=>edits.delete(id));
        }
        const pending = new Set(pendingCleanups(db).map(job=>job.id));
        for (const op of await library.listCleanupOperations()) {
          if (op.complete && !pending.has(op.id)) await library.ackCleanup(op.id);
        }
        if (receipts.length && onlyPending) await updated();
      } finally {
        applying = false;
      }
    }
  };
}
