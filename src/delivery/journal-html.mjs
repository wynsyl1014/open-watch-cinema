// Self-contained exports: film-supplied text stays text, and only embedded raster portraits can become URLs.
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const list = value => Array.isArray(value) ? value : [];
const copy = (value, cls = 'copy') => value ? `<p class="${cls}">${html(value)}</p>` : '';
const time = value => value ? `<span class="time">${html(value)}</span>` : '';
const common = `
*{box-sizing:border-box}html{color-scheme:light}body{margin:0;color:#162d40;background:#f0f3f3;font:16px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:52rem;margin:0 auto;padding:clamp(1rem,5vw,3.25rem)}h1,h2,h3,p,ol,ul,figure{margin:0}h1,h2,h3{line-height:1.25;overflow-wrap:anywhere}
h1,h2,.person-name{font-family:Georgia,"Songti SC",SimSun,serif}h1{font-size:clamp(1.95rem,6vw,3.35rem);font-weight:600;letter-spacing:-.035em}
h2{font-size:clamp(1.45rem,4vw,2rem);font-weight:600}.copy,.keep,.person-name,.bubble,.action-text{white-space:pre-wrap;overflow-wrap:anywhere}
.time{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.78rem;letter-spacing:.015em;font-variant-numeric:tabular-nums;white-space:nowrap}
.empty,.meta{font-size:.82rem;color:#586976}.meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:.16rem .8rem;overflow-wrap:anywhere}
.kicker{font-size:.78rem;font-weight:650;letter-spacing:.14em}.group{margin-top:2.25rem}.group>h2{margin-bottom:.85rem}
@media print{@page{margin:14mm}html,body{background:white!important}main{max-width:none;padding:0}h2,h3,.meta{break-after:avoid}.portrait,.graph,.card,.line-item,.turn,.event{break-inside:avoid}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;
function documentHtml(title, styles, body) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${html(title)}</title><style>${common}${styles}</style></head><body><main>${body}</main></body></html>`;
}

const roomStyles = `
body{background:#e9eef2}.ticket{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:stretch;background:#152e45;color:#fff7df;border-radius:14px}
.ticket-main{padding:.8rem clamp(.85rem,3vw,1.45rem)}
.ticket-caption{display:flex;flex-wrap:wrap;align-items:baseline;gap:.15rem .85rem;margin-bottom:.25rem}
.ticket .kicker{color:#e7cfa2}.ticket h1{font-size:clamp(1.24rem,3.4vw,1.8rem);line-height:1.22}
.ticket-stub{border-inline-start:1px dashed #9fabb0;align-content:center;padding:.45rem .7rem;text-align:center;color:#e7cfa2;font-size:.75rem}
.ticket-stub strong{display:block;font-size:1.18rem;color:#fff8e8;font-weight:550}.ticket-date{color:#d9e0e5;font-size:.78rem}.ticket+.group{margin-top:1.45rem}
.chat{list-style:none;padding:0;display:grid;gap:1.1rem}.turn{display:flex;flex-direction:column;align-items:flex-start}.turn.right{align-items:flex-end}
.turn .meta{margin:0 .15rem .24rem}.speaker{font-size:.86rem;font-weight:650;color:#274052}.bubble{max-width:min(86%,40rem);padding:.63rem 1rem;border:1px solid #c9d6df;background:#fff;border-radius:2px 13px 13px}
.right .bubble{background:#dbe8ee;border-color:#bfced8;border-radius:13px 2px 13px 13px}.event{display:flex;align-items:center;gap:.8rem;justify-content:center;text-align:center;margin:.3rem 0}
.event::before,.event::after{content:"";flex:1;max-width:4rem;border-top:1px solid #bdc9cd}.event-body{max-width:80%;font-size:.91rem;color:#405364}.event .meta{justify-content:center;margin-bottom:.1rem}
@media(max-width:400px){.ticket-main{padding:.65rem .8rem}.ticket-stub{padding:.5rem}.bubble{max-width:95%}}
`;
export function renderRoomHtml({ title, date, messages = [] }) {
  const sides = new Map();
  const rows = messages.map(message => {
    const stamp = `<div class="meta"><span class="speaker keep">${html(message.name)}</span>${time(message.at)}</div>`;
    if (message.interaction) return `<li class="event"><div class="event-body">${stamp}<p class="action-text">${html(message.text)}</p></div></li>`;
    if (!sides.has(message.name)) sides.set(message.name, sides.size % 2);
    return `<li class="turn${sides.get(message.name) ? ' right' : ''}">${stamp}<p class="bubble">${html(message.text)}</p></li>`;
  }).join('');
  return documentHtml(`${title} · 观影记录`, roomStyles, `<header class="ticket"><div class="ticket-main"><div class="ticket-caption"><p class="kicker">观影记录</p>${copy(date, 'ticket-date keep')}</div>
<h1 class="keep">${html(title)}</h1></div><div class="ticket-stub"><strong>${messages.length}</strong>条记录</div></header>
<section class="group"><h2>房间实录</h2>${rows ? `<ol class="chat">${rows}</ol>` : '<p class="empty">这个房间还没有留言或互动。</p>'}</section>`);
}

const bookStyles = `
body{background:#e9eeef}.book{background:#fffdf4;border:1px solid #c9d4d4;border-radius:12px;overflow:hidden}
.book-cover{background:#cee3e9;border-bottom:1px solid #acc8d0;padding:clamp(1.45rem,5vw,3rem)}
.book-cover .kicker{color:#345b6d;margin-bottom:1rem}.pages{padding:0 clamp(.9rem,4vw,2.5rem) 2.25rem}.pages h2{padding-bottom:.55rem;border-bottom:1px solid #aebfbe;color:#244a5a}
.characters{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:.8rem}.card{border:1px solid #d3d8c9;border-radius:8px;background:#fffef9;padding:.9rem}
.person-head{display:flex;gap:.7rem;align-items:center;margin-bottom:.45rem}.portrait{width:3rem;height:3rem;flex:none;border-radius:50%;background:#d8e8e8;color:#345364;display:grid;place-items:center;overflow:hidden;font:600 1.2rem Georgia,serif}
.portrait img{width:100%;height:100%;object-fit:cover}.person-name{font-weight:650;font-size:1.12rem}.meta,.small{font-size:.78rem}.meta{color:#516971}.card>.meta,.line-item>.meta{margin-top:.45rem}
.line-items{list-style:none;padding:0}.line-item{padding:.75rem 0;border-bottom:1px solid #e1e2d5}.line-item:last-child{border-bottom:0}.line-item>.copy+.copy{margin-top:.3rem}
.answer{margin-top:.6rem;border-left:3px solid #9bbeb4;padding-left:.75rem}.answer .meta{margin-top:.3rem}.tag{color:#3a6373;font-size:.78rem}.tagline{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.3rem}.subhead{font-size:1rem;margin:.3rem 0}
.graph{display:grid;grid-template-columns:minmax(3.7rem,1fr) minmax(0,3.4fr);align-items:stretch;margin:.85rem 0;border:1px solid #c6d7d8;border-radius:8px;background:#f2f7f5;padding:.8rem .65rem}
.hub{align-self:center;position:relative;text-align:center}.node{display:inline-block;position:relative;max-width:100%;padding:.28rem .65rem;border:1px solid #a8c4ca;border-radius:1rem;background:#d9e9eb;color:#214b5c;font-weight:650}
.branches{position:relative;padding-left:1rem}.branches::before{content:"";position:absolute;top:50%;left:0;width:1rem;border-top:1px solid #71969d}
.hub::before{content:"";position:absolute;top:50%;left:50%;right:-1rem;border-top:1px solid #71969d}
.branch{position:relative;display:grid;grid-template-columns:minmax(0,1.6fr) minmax(3.4rem,1fr);align-items:center;padding:.4rem 0}
.branch::before{content:"";position:absolute;left:0;top:0;bottom:0;border-left:1px solid #71969d}.branch:first-child::before{top:50%}.branch:last-child::before{bottom:50%}
.edge{position:relative;min-width:0;text-align:center;line-height:1.35;padding:.25rem .65rem}.edge::before{content:"";position:absolute;left:0;right:0;top:50%;border-top:1px solid #71969d}
.edge-label{position:relative;display:inline-block;max-width:100%;background:#f2f7f5;color:#315b69;padding:.15rem .2rem;font-size:.87rem}.arrow{font-family:Arial,sans-serif;white-space:nowrap}.edge-meta{display:block;font-size:.7rem;color:#526970}
.data-list{list-style:none;padding:0}.rel-note{margin:.35rem 0 .8rem;padding-left:.65rem;border-left:2px solid #c4d7d8}.rel-note .meta{margin-top:.15rem}
@media(max-width:500px){.graph{padding:.65rem .35rem}.branches{padding-left:.45rem}.branches::before{width:.45rem}.hub::before{right:-.45rem}.node{padding:.18rem .38rem;font-size:.85rem}.edge{padding:.2rem .22rem}.edge-label{font-size:.78rem}.book{border-radius:7px}}
@media print{.book{border:0;overflow:visible}.pages{padding:0}.book-cover{padding:1rem}.group{margin-top:1.2rem}.graph{break-inside:auto}.branch,.rel-note{break-inside:avoid}}
`;
function credit(entry) {
  const contributors = list(entry.credits).filter(c => c?.name && list(c.fields).length);
  const fieldCredits = contributors.flatMap(c => {
    const fields = c.fields.filter(field => !(entry.answer && c.name === entry.answerAuthor
      && ['解答', '解答时间'].includes(field)));
    return fields.length ? [`${c.name}（${fields.join('、')}）`] : [];
  });
  return `<div class="meta">${time(entry.at)}${entry.author ? `<span>记录 · ${html(entry.author)}</span>` : ''}
${entry.editor && entry.editor !== entry.author && !contributors.some(c => c.name === entry.editor) ? `<span>修订 · ${html(entry.editor)}</span>` : ''}
${fieldCredits.length ? `<span>${html(fieldCredits.join('　'))}</span>` : ''}</div>`;
}
function tags(entry) {
  const items = [...list(entry.characters), ...list(entry.tags)].filter(Boolean);
  return items.length ? `<div class="tagline">${items.map(tag => `<span class="tag">${html(tag)}</span>`).join('')}</div>` : '';
}
function portrait(person) {
  return `<span class="portrait" aria-hidden="true">${html(Array.from(person.name || '·')[0])}</span>`;
}
function section(name, body, empty) {
  return `<section class="group"><h2>${name}</h2>${body || `<p class="empty">${empty}</p>`}</section>`;
}
function characterCards(people) {
  if (!people.length) return '';
  return `<div class="characters">${people.map(p => `<article class="card"><div class="person-head">${portrait(p)}
<h3 class="person-name">${html(p.name)}</h3></div>${copy(p.text)}${p.appearance ? `<p class="copy"><strong>外貌</strong>　${html(p.appearance)}</p>` : ''}${credit(p)}</article>`).join('')}</div>`;
}
function relationshipGraph(people, edges) {
  if (!edges.length) return '';
  const names = new Map(people.map(p => [p.ref, p.name]));
  const incident = new Map();
  edges.forEach((edge, index) => {
    for (const person of new Set([edge.from, edge.to])) {
      if (!incident.has(person)) incident.set(person, []);
      incident.get(person).push(index);
    }
  });
  const seen = new Set();
  const graphs = [];
  const nameOf = ref => names.get(ref) || '未记录姓名';
  const node = ref => `<span class="node keep">${html(nameOf(ref))}</span>`;
  for (const [hub, indexes] of [...incident].sort((a, b) => b[1].length - a[1].length)) {
    const remaining = indexes.filter(i => !seen.has(i));
    // Separate large stars into printable groups. Each edge appears exactly once.
    for (let start = 0; start < remaining.length; start += 5) {
      const rows = [];
      const notes = [];
      for (const index of remaining.slice(start, start + 5)) {
        seen.add(index);
        const e = edges[index];
        const other = e.from === hub ? e.to : e.from;
        const arrow = e.direction === 'forward' ? (e.from === hub ? '→' : '←') : '↔';
        const label = e.label || e.name || e.text;
        rows.push(`<div class="branch"><div class="edge"><span class="edge-label"><span class="keep">${html(label)}</span>
<span class="arrow">${arrow}</span>${e.status ? `<span class="edge-meta">${html(e.status)}</span>` : ''}</span></div><div>${node(other)}</div></div>`);
        const detail = e.text && e.text !== label ? copy(e.text) : '';
        const evidence = Array.isArray(e.evidence) ? e.evidence.join('\n') : e.evidence;
        notes.push(`<li class="rel-note"><span class="small keep">${html(nameOf(e.from))} ${e.direction === 'forward' ? '→' : '↔'} ${html(nameOf(e.to))} · ${html(label)}</span>${detail}${copy(evidence)}${credit(e)}</li>`);
      }
      graphs.push(`<figure class="graph" aria-label="${html(nameOf(hub))}的人物关系图"><div class="hub">${node(hub)}</div><div class="branches">${rows.join('')}</div></figure><ul class="data-list">${notes.join('')}</ul>`);
    }
  }
  return graphs.join('');
}
function lines(entries, render) {
  return entries.length ? `<ol class="line-items">${entries.map(entry =>
    `<li class="line-item">${render(entry)}${tags(entry)}${credit(entry)}</li>`).join('')}</ol>` : '';
}
export function renderNotebookHtml({ title, characters = [], relationships = [], timeline = [], questions = [], notes = [] }) {
  const book = [
    section('人物', characterCards(characters), '还没有人物记录。'),
    section('人物关系', relationshipGraph(characters, relationships), '还没有关系记录。'),
    section('时间线', lines(timeline, e => copy(e.text)), '还没有剧情记录。'),
    section('疑问', lines(questions, e => `${e.status ? `<span class="tag">${html(e.status)}</span>` : ''}${copy(e.text)}${copy(e.detail)}
${e.answer ? `<div class="answer"><h3 class="subhead">解答</h3>${copy(e.answer)}<div class="meta">${time(e.answerAt)}${html(e.answerAuthor)}</div></div>` : ''}`), '还没有疑问。'),
    section('随记', lines(notes, e => copy(e.text)), '还没有随记。')
  ];
  return documentHtml(`${title} · 观影手记`, bookStyles, `<article class="book"><header class="book-cover"><p class="kicker">观影手记</p><h1 class="keep">${html(title)}</h1></header><div class="pages">${book.join('')}</div></article>`);
}
