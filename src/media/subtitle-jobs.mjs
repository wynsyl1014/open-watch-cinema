import { randomUUID } from 'node:crypto';
import { extractSubtitleStreams, readSavedEmbeddedSubtitles, recoverSubtitleExtraction } from './media-subtitles.mjs';

const languageOptions = ['zh-Hans','zh-Hant','en'];

export function subtitlePreferences(db) {
  const read = db.prepare("select value from settings where key='subtitle_languages'");
  const write = db.prepare("insert into settings(key,value,updated_at) values('subtitle_languages',?,?) on conflict(key) do update set value=excluded.value, updated_at=excluded.updated_at");
  return {
    get() { const row = read.get(); return row ? JSON.parse(row.value) : [...languageOptions]; },
    set(value) {
      if (!Array.isArray(value) || value.some(language => !languageOptions.includes(language))) {
        throw new Error('请选择有效的字幕语言。');
      }
      const selected = languageOptions.filter(language => value.includes(language));
      write.run(JSON.stringify(selected),new Date().toISOString());
      return selected;
    }
  };
}

export function createSubtitleJob(mediaId, selection) {
  return {id:randomUUID(), mediaId, kind:'subtitles', status:'queued', progress:0,
    startedAt:new Date().toISOString(), ...selection};
}

// Jobs belong to the film. Only the current percentage and the scheduling queue are process-local.
export function createSubtitleJobs({save, refresh, changed}) {
  const current = new Map();
  const active = new Set();
  let queue = Promise.resolve();
  function schedule(item, job, operation) {
    active.add(item.id);
    current.set(item.id, job);
    const ready = save(item, {...job});
    // Queue before awaiting the write so simultaneous entrances observe the same job.
    queue = queue.then(async () => {
      try {
        await ready;
        if (operation === 'recover') {
          await recoverSubtitleExtraction(item.absolutePath);
          const saved = new Set((await readSavedEmbeddedSubtitles(item.absolutePath)).map(track => track.id));
          if (Array.isArray(job.plannedTrackIds) && job.plannedTrackIds.every(id => saved.has(id))) {
            job.status = 'completed';
            job.progress = 100;
          } else {
            job.status = 'interrupted';
            job.error = '上次提取时影院服务已中断，可以重新提取。';
          }
          await refresh(item);
        } else {
          job.status = 'processing';
          await save(item, {...job});
          await extractSubtitleStreams(item.absolutePath, {
            trackIds:job.trackIds, languages:job.languages,
            async onSelected(ids) {
              job.plannedTrackIds = ids;
              await save(item,{...job});
            },
            onProgress:({percent}) => { if (Number.isFinite(percent)) job.progress = Math.max(job.progress,Math.min(99,percent)); }
          });
          await refresh(item);
          job.progress = 100;
          job.status = 'completed';
        }
      } catch (error) {
        job.status = 'failed';
        job.error = error.message;
      }
      job.finishedAt = new Date().toISOString();
      try { await save(item, {...job}); }
      finally { active.delete(item.id); changed(item.id); }
    }).catch(error => console.error('字幕任务：',error.message));
    ready.catch(()=>{});
    changed(item.id);
    return ready.then(() => job);
  }
  return {
    active:id => active.has(id),
    get:id => current.get(id) || null,
    find:id => [...current.values()].find(job => job.id === id),
    observe(items) {
      const present = new Set(items.map(item => item.id));
      for (const id of current.keys()) if (!present.has(id) && !active.has(id)) current.delete(id);
      for (const item of items) {
        if (!item.subtitleJob || current.has(item.id)) continue;
        const job = {...item.subtitleJob};
        current.set(item.id,job);
        if (job.status === 'pending') {
          job.status = 'queued';
          void schedule(item,job,'extract').catch(error => console.error('字幕任务：',error.message));
        } else if (['queued','processing'].includes(job.status)) {
          void schedule(item,job,'recover').catch(error => console.error('字幕恢复：',error.message));
        }
      }
    },
    start(item, selection) {
      if (active.has(item.id)) return Promise.resolve(current.get(item.id));
      return schedule(item,createSubtitleJob(item.id,selection),'extract');
    }
  };
}
