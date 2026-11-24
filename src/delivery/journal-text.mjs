const fieldLabels = {
  name:'称呼', text:'正文', appearance:'外貌', label:'关系标签', direction:'方向', uncertain:'确定程度',
  detail:'说明', answer:'解答', characterIds:'关联人物',
  section:'分区', eventAtMs:'影片时间', answerAtMs:'解答时间'
};

function filmTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const tail = String(seconds % 60).padStart(2,'0');
  if (minutes < 60) return minutes + ':' + tail;
  return Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2,'0') + ':' + tail;
}

export function roomJournal(title, date, rawMessages) {
  const ordered = [...rawMessages].sort((left,right) => left.mediaTimeMs-right.mediaTimeMs || left.id-right.id);
  return {
    title, date,
    messages: ordered.map(row => ({
      at:filmTime(row.mediaTimeMs), name:row.senderName, text:row.content, interaction:row.interaction || null
    }))
  };
}

function sameActor(left,right) {
  return Boolean(left && right && left.id===right.id && left.kind===right.kind);
}

function attribution(entry) {
  const authors=new Map();
  for (const [field,actor] of Object.entries(entry.fieldAuthors || {})) {
    if (!fieldLabels[field] || !actor?.name || sameActor(actor,entry.author)) continue;
    const key=actor.kind+' '+actor.id;
    if (!authors.has(key)) authors.set(key,{name:actor.name,fields:[]});
    authors.get(key).fields.push(fieldLabels[field]);
  }
  return {
    author:entry.author?.name || null,
    editor:sameActor(entry.lastEditor,entry.author) ? null : entry.lastEditor?.name || null,
    credits:[...authors.values()]
  };
}

export function notebookJournal(title, rawEntries) {
  const result = {title,characters:[],relationships:[],timeline:[],questions:[],notes:[]};
  const ordered = [...rawEntries].sort((a,b) => a.eventAtMs-b.eventAtMs);
  const people = new Map();
  for (const entry of ordered) {
    if (entry.kind==='character') people.set(entry.id,{ref:'c'+(people.size+1),name:entry.name});
  }
  for (const entry of ordered) {
    const characters = (entry.characterIds || []).map(id=>people.get(id)).filter(Boolean);
    const common = {
      text:entry.text || '', at:filmTime(entry.eventAtMs), ...attribution(entry),
      characters:characters.map(character=>character.name)
    };
    const section = entry.kind==='note' ? entry.section || 'timeline' : entry.kind;
    switch (section) {
      case 'character':
        result.characters.push({...common,...people.get(entry.id),appearance:entry.appearance || ''});
        break;
      case 'relation': {
        if (characters.length!==2) break;
        const label = entry.label || entry.text || '';
        result.relationships.push({...common,from:characters[0].ref,to:characters[1].ref,
          direction:entry.direction==='forward' ? 'forward' : 'mutual',status:entry.uncertain ? '推测' : '已知',
          label,text:entry.text===label ? '' : common.text});
        break;
      }
      case 'timeline': result.timeline.push(common); break;
      case 'jot': result.notes.push(common); break;
      case 'question':
        result.questions.push({...common,detail:entry.detail || '',answer:entry.answer || '',
          answerAt:entry.answer ? filmTime(entry.answerAtMs ?? entry.knownAtMs) : null,
          answerAuthor:entry.answer ? entry.fieldAuthors?.answer?.name || null : null,
          status:entry.answer ? '已解答' : '待解答'});
        break;
    }
  }
  return result;
}

const joinFields = (...fields) => fields.filter(Boolean).join(' · ');

export function renderRoomText(journal) {
  const lines=[joinFields('《'+journal.title+'》观影对话',journal.date)];
  for (const message of journal.messages) {
    const speaker = message.name + (message.interaction ? '（互动）' : '');
    lines.push([message.at,speaker,message.text].filter(value=>value!=null).join('　'));
  }
  return lines.join('\n')+'\n';
}

function entryText(entry,body, {linked=false,question=false}={}) {
  const lines=[joinFields(entry.at,entry.author,linked ? entry.characters.join('、') : null) + '　' + body];
  if (question && entry.answer) {
    lines.push(joinFields('解答',entry.answerAt,entry.answerAuthor)+'　'+entry.answer);
  }
  const editors=new Set();
  for (const credit of entry.credits) {
    editors.add(credit.name);
    const fields = credit.fields.filter(field=>!(question && entry.answer && entry.answerAuthor===credit.name
      && (field==='解答' || field==='解答时间')));
    if (fields.length) lines.push(fields.join('、')+' · '+credit.name);
  }
  if (entry.editor && !editors.has(entry.editor)) lines.push('修订 · '+entry.editor);
  return lines.join('\n');
}

export function renderNotebookText(journal) {
  const lines=['《'+journal.title+'》观影手记'];
  const people=new Map(journal.characters.map(person=>[person.ref,person.name]));
  function section(heading,entries,format) {
    if (!entries.length) return;
    lines.push('',heading,...entries.map(format));
  }
  section('人物',journal.characters,entry=>entryText(entry,
    entry.name+(entry.text ? '\n'+entry.text : '')+(entry.appearance ? '\n外貌：'+entry.appearance : '')));
  section('关系',journal.relationships,entry=>{
    const direction=entry.direction==='forward' ? ' → ' : ' ↔ ';
    const edge=people.get(entry.from)+direction+people.get(entry.to);
    return entryText(entry,joinFields(edge,entry.label,entry.status)+(entry.text ? '\n'+entry.text : ''));
  });
  section('剧情',journal.timeline,entry=>entryText(entry,entry.text,{linked:true}));
  section('疑问',journal.questions,entry=>entryText(entry,
    (entry.answer ? '' : '待解答 · ')+entry.text+(entry.detail ? '\n'+entry.detail : ''),{linked:true,question:true}));
  section('随记',journal.notes,entry=>entryText(entry,entry.text,{linked:true}));
  return lines.join('\n')+'\n';
}
