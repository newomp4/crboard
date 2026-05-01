// Export a board as a single self-contained HTML file.
//
// The exported file has zero dependencies — no React, no framework, no
// network calls (beyond the embeds themselves). It bundles:
//   1. A vanilla-JS viewer that re-implements pan/zoom and item rendering
//   2. The board data as JSON inside a <script> tag
//   3. All images already inlined as data URLs (because we store them that way)
//
// The recipient double-clicks the file → opens in any browser → can pan,
// zoom, watch embeds. No editor, no toolbar, view-only.

import type { Board, Theme } from "./types";

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// JSON safely embedded inside a <script> block. The </ sequence is the only
// thing that can break out of a script tag, so we escape it.
const safeJson = (v: unknown) =>
  JSON.stringify(v).replace(/<\/(script)/gi, "<\\/$1");

export const exportToHtml = (board: Board, theme: Theme = "light"): string => {
  const title = escapeHtml(board.name || "crboard");
  const data = safeJson(board);

  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${title}</title>
<style>
  :root{--bg:#fafafa;--surface:#fff;--surface-2:#fff;--border:#e5e5e5;
    --text:#0a0a0a;--text-2:#525252;--text-3:#737373;--grid-dot:#d4d4d4;
    --chrome-bg:rgba(255,255,255,.85)}
  [data-theme="dark"]{--bg:#0a0a0a;--surface:#171717;--surface-2:#1f1f1f;
    --border:#262626;--text:#fafafa;--text-2:#d4d4d4;--text-3:#a3a3a3;
    --grid-dot:#262626;--chrome-bg:rgba(23,23,23,.85);color-scheme:dark}
  html,body{height:100%;margin:0;background:var(--bg);color:var(--text);
    font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Inter,sans-serif;
    -webkit-font-smoothing:antialiased;overflow:hidden}
  *{box-sizing:border-box}
  #viewport{position:absolute;inset:0;overflow:hidden;touch-action:none;cursor:grab}
  #viewport.grabbing{cursor:grabbing}
  #grid{position:absolute;inset:0;pointer-events:none;opacity:.6;
    background-image:radial-gradient(circle,var(--grid-dot) 1px,transparent 1px)}
  #world{position:absolute;left:0;top:0;transform-origin:0 0;width:0;height:0}
  .item{position:absolute}
  .item.text{padding:12px;line-height:1.35;background:var(--surface-2);
    border:1px solid var(--border);color:var(--text);
    white-space:pre-wrap;word-break:break-word;overflow:hidden}
  .item.text h1,.item.text h2,.item.text h3,.item.text h4,.item.text h5,.item.text h6{
    font-weight:700;margin:0 0 .4em 0;line-height:1.2}
  .item.text h1{font-size:1.6em}.item.text h2{font-size:1.35em}
  .item.text h3{font-size:1.15em}.item.text h4{font-size:1.05em}
  .item.text h5{font-size:1em;font-weight:600}.item.text h6{font-size:.9em;font-weight:600}
  .item.text div{line-height:1.35}
  .item.text ul,.item.text ol{padding-left:1.4em;margin:0 0 .4em 0}
  .item.text li{line-height:1.4}
  .item.text code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    background:var(--border);padding:.05em .3em;border-radius:2px;font-size:.9em}
  .item.text a{color:var(--text);text-decoration:underline}
  .item.text strong{font-weight:700}.item.text em{font-style:italic}.item.text s{text-decoration:line-through}
  .item.image img{width:100%;height:100%;object-fit:contain;display:block;background:var(--bg)}
  .item.embed{display:flex;flex-direction:column;background:var(--bg);
    border:1px solid var(--border);overflow:hidden}
  .item.embed .frame-wrap{flex:1;position:relative;min-height:0}
  .item.embed iframe{width:100%;height:100%;border:0;background:var(--bg);display:block}
  .item.embed .src-link{display:flex;align-items:center;gap:6px;padding:6px 10px;
    border-top:1px solid var(--border);background:var(--surface-2);
    font-size:11px;color:var(--text-2);
    text-decoration:none;flex-shrink:0}
  .item.embed .src-link span.label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .item.embed .src-link b{color:var(--text);font-weight:500}
  .item.link{display:flex;flex-direction:column;justify-content:center;padding:16px;
    background:var(--surface-2);border:1px solid var(--border);
    text-decoration:none;color:var(--text);font-size:14px;word-break:break-word}
  .item.link b{display:block;margin-bottom:4px;font-weight:600}
  .item.link span{color:var(--text-3);font-size:12px}
  .item.drawing svg{display:block;overflow:visible;pointer-events:none}
  #hint{position:fixed;left:12px;bottom:12px;font-size:11px;color:var(--text-3);
    background:var(--chrome-bg);padding:6px 10px;border:1px solid var(--border);
    pointer-events:none;letter-spacing:.01em}
  #title{position:fixed;left:12px;top:12px;font-size:13px;font-weight:600;color:var(--text);
    background:var(--chrome-bg);padding:6px 10px;border:1px solid var(--border);pointer-events:none}
  #zoom{position:fixed;right:12px;bottom:12px;font-size:11px;color:var(--text-3);
    background:var(--chrome-bg);padding:6px 10px;border:1px solid var(--border);
    font-variant-numeric:tabular-nums;pointer-events:none}
</style>
</head>
<body>
<div id="title">${title}</div>
<div id="viewport">
  <div id="grid"></div>
  <div id="world"></div>
</div>
<div id="hint">scroll to pan &middot; ⌘/ctrl + scroll to zoom &middot; space + drag to pan</div>
<div id="zoom">100%</div>
<script id="board" type="application/json">${data}</script>
<script>
${VIEWER_JS}
</script>
</body>
</html>`;
};

// The viewer is plain JS — it re-implements pan/zoom + rendering from scratch
// so the export has zero npm dependencies and zero React baggage. The board
// shape mirrors src/types.ts.
const VIEWER_JS = `
(function(){
  var data=document.getElementById('board').textContent;
  var board=JSON.parse(data);
  var view={x:(board.view&&board.view.x)||0,y:(board.view&&board.view.y)||0,
            zoom:(board.view&&board.view.zoom)||1};
  var viewport=document.getElementById('viewport');
  var world=document.getElementById('world');
  var grid=document.getElementById('grid');
  var zoomLabel=document.getElementById('zoom');

  function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

  // Mini markdown renderer — same rules as src/markdown.ts in the editor.
  function safeUrl(u){return /^https?:\\/\\//i.test(String(u).trim())?String(u).trim():'#';}
  function mdInline(text){
    var codes=[];
    var s=text.replace(/\`([^\`\\n]+)\`/g,function(_,c){codes.push(c);return ' CODE'+(codes.length-1)+' ';});
    s=escapeHtml(s);
    s=s.replace(/\\*\\*([^*\\n]+?)\\*\\*/g,'<strong>$1</strong>');
    s=s.replace(/__([^_\\n]+?)__/g,'<strong>$1</strong>');
    s=s.replace(/(?<!\\*)\\*([^*\\n]+?)\\*(?!\\*)/g,'<em>$1</em>');
    s=s.replace(/(?<!_)_([^_\\n]+?)_(?!_)/g,'<em>$1</em>');
    s=s.replace(/~~([^~\\n]+?)~~/g,'<s>$1</s>');
    s=s.replace(/\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)/g,function(_,label,url){
      return '<a href="'+escapeHtml(safeUrl(url))+'" target="_blank" rel="noreferrer">'+label+'</a>';
    });
    s=s.replace(/ CODE(\\d+) /g,function(_,i){return '<code>'+escapeHtml(codes[+i])+'</code>';});
    return s;
  }
  function mdRender(text){
    if(!text) return '';
    var lines=text.split('\\n'); var out=[]; var listType=null;
    function closeList(){ if(listType){ out.push('</'+listType+'>'); listType=null; } }
    for(var i=0;i<lines.length;i++){
      var line=lines[i];
      var hm=line.match(/^(#{1,6})\\s+(.*)$/);
      if(hm){ closeList(); var lvl=hm[1].length; out.push('<h'+lvl+'>'+mdInline(hm[2])+'</h'+lvl+'>'); continue; }
      var ulm=line.match(/^[-*]\\s+(.*)$/);
      if(ulm){ if(listType!=='ul'){closeList();out.push('<ul>');listType='ul';} out.push('<li>'+mdInline(ulm[1])+'</li>'); continue; }
      var olm=line.match(/^\\d+\\.\\s+(.*)$/);
      if(olm){ if(listType!=='ol'){closeList();out.push('<ol>');listType='ol';} out.push('<li>'+mdInline(olm[1])+'</li>'); continue; }
      closeList();
      out.push('<div>'+(mdInline(line)||'&nbsp;')+'</div>');
    }
    closeList();
    return out.join('');
  }

  function detectEmbed(input){
    try{var u=new URL(input);}catch(e){return null;}
    if(u.hostname.indexOf('youtu.be')>=0){
      var id=u.pathname.slice(1); if(id) return 'https://www.youtube.com/embed/'+id;
    }
    if(u.hostname.indexOf('youtube.com')>=0){
      if(u.pathname==='/watch'){var v=u.searchParams.get('v'); if(v) return 'https://www.youtube.com/embed/'+v}
      var m=u.pathname.match(/^\\/(embed|shorts|live)\\/([\\w-]+)/); if(m) return 'https://www.youtube.com/embed/'+m[2];
    }
    if(u.hostname.indexOf('instagram.com')>=0){
      var im=u.pathname.match(/^\\/(p|reel|tv|reels)\\/([\\w-]+)/);
      if(im){var t=im[1]==='reels'?'reel':im[1]; return 'https://www.instagram.com/'+t+'/'+im[2]+'/embed/'}
    }
    if(u.hostname.indexOf('tiktok.com')>=0){
      var tm=u.pathname.match(/\\/video\\/(\\d+)/); if(tm) return 'https://www.tiktok.com/embed/v2/'+tm[1];
    }
    var th=u.hostname.replace(/^mobile\\./,'');
    if(th==='twitter.com'||th==='www.twitter.com'||th==='x.com'||th==='www.x.com'){
      var twm=u.pathname.match(/\\/status\\/(\\d+)/);
      if(twm) return 'https://platform.twitter.com/embed/Tweet.html?id='+twm[1]+'&dnt=true';
    }
    if(u.hostname.indexOf('vimeo.com')>=0){
      var vm=u.pathname.match(/\\/(\\d+)(?:\\/|$)/);
      if(vm) return 'https://player.vimeo.com/video/'+vm[1];
    }
    if(u.hostname.indexOf('spotify.com')>=0){
      var sm=u.pathname.match(/^\\/(track|episode|album|playlist|artist|show)\\/([\\w-]+)/);
      if(sm) return 'https://open.spotify.com/embed/'+sm[1]+'/'+sm[2];
    }
    return input;
  }

  function renderItem(it){
    var el=document.createElement('div');
    el.className='item '+it.type;
    el.style.left=it.x+'px'; el.style.top=it.y+'px';
    el.style.width=it.w+'px'; el.style.height=it.h+'px';
    el.style.zIndex=it.z||0;
    if(it.type==='text'){
      el.style.fontSize=(it.fontSize||16)+'px';
      el.style.fontWeight=(it.fontWeight||400);
      el.innerHTML=mdRender(it.text||'');
    } else if(it.type==='image'){
      var img=document.createElement('img'); img.src=it.src; img.alt=it.alt||''; img.draggable=false;
      el.appendChild(img);
    } else if(it.type==='embed'){
      var wrap=document.createElement('div'); wrap.className='frame-wrap';
      var f=document.createElement('iframe'); f.src=detectEmbed(it.url)||it.url;
      f.setAttribute('allow','autoplay; encrypted-media; picture-in-picture; fullscreen');
      f.setAttribute('allowfullscreen','');
      f.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-forms allow-presentation');
      wrap.appendChild(f);
      el.appendChild(wrap);

      // Source-link footer: matches editor styling, opens original page in a new tab.
      var host='', path='';
      try{var su=new URL(it.url); host=su.hostname.replace(/^www\\./,''); path=su.pathname+su.search;}catch(e){host=it.url;}
      var srcA=document.createElement('a'); srcA.className='src-link';
      srcA.href=it.url; srcA.target='_blank'; srcA.rel='noreferrer'; srcA.title=it.url;
      var pathHtml=(path&&path!=='/')?escapeHtml(path):'';
      srcA.innerHTML='<span class="label"><b>'+escapeHtml(host)+'</b>'+pathHtml+'</span>'+
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+
        '<path d="M14 5h5v5"/><path d="M19 5l-9 9"/><path d="M19 13v6H5V5h6"/></svg>';
      srcA.addEventListener('pointerdown',function(e){e.stopPropagation();});
      el.appendChild(srcA);
    } else if(it.type==='link'){
      var a=document.createElement('a'); a.href=it.url; a.target='_blank'; a.rel='noreferrer';
      var host=''; try{host=new URL(it.url).hostname}catch(e){}
      a.innerHTML='<b>'+escapeHtml(it.title||host)+'</b><span>'+escapeHtml(it.url)+'</span>';
      // Replace wrapper with anchor.
      el.className='item link';
      el.style.padding='0';
      a.style.display='flex'; a.style.flexDirection='column'; a.style.justifyContent='center';
      a.style.padding='16px'; a.style.width='100%'; a.style.height='100%';
      a.style.background='#fff'; a.style.border='1px solid #e5e5e5'; a.style.color='#0a0a0a';
      a.style.textDecoration='none'; a.style.fontSize='14px'; a.style.wordBreak='break-word';
      el.appendChild(a);
    } else if(it.type==='drawing'){
      var ns='http://www.w3.org/2000/svg';
      var svg=document.createElementNS(ns,'svg');
      svg.setAttribute('width','100%'); svg.setAttribute('height','100%');
      svg.setAttribute('viewBox','0 0 '+it.w+' '+it.h);
      (it.strokes||[]).forEach(function(s){
        var p=document.createElementNS(ns,'path');
        p.setAttribute('d',s.d); p.setAttribute('stroke',s.color||'#0a0a0a');
        p.setAttribute('stroke-width',s.strokeWidth||2);
        p.setAttribute('fill','none'); p.setAttribute('stroke-linecap','round');
        p.setAttribute('stroke-linejoin','round');
        svg.appendChild(p);
      });
      el.appendChild(svg);
    } else if(it.type==='connector'){
      // Connectors are rendered separately in an SVG layer above the world.
      return null;
    }
    return el;
  }

  (board.items||[]).forEach(function(it){
    var el=renderItem(it); if(el) world.appendChild(el);
  });

  // ----- connector layer -----
  // Compute world-coord lines clipped at each item's bbox edge, render as SVG
  // inside the world transform so they pan/zoom with everything else.
  var ns2='http://www.w3.org/2000/svg';
  var connectorSvg=document.createElementNS(ns2,'svg');
  connectorSvg.setAttribute('style','position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none');
  // Marker definition (arrowhead). Sized in user-space units; with
  // vector-effect:non-scaling-stroke on the line, the visible arrow stays
  // roughly constant in screen pixels because the rendered stroke is fixed.
  var defs=document.createElementNS(ns2,'defs');
  defs.innerHTML='<marker id="cr-arrow" markerUnits="strokeWidth" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M 0 0 L 6 3 L 0 6 Z" fill="currentColor"/></marker>';
  connectorSvg.appendChild(defs);
  var byId={};
  (board.items||[]).forEach(function(it){ byId[it.id]=it; });
  function rayBoxExit(start,dir,box){
    var tx=dir.x>0?(box.x+box.w-start.x)/dir.x:dir.x<0?(box.x-start.x)/dir.x:Infinity;
    var ty=dir.y>0?(box.y+box.h-start.y)/dir.y:dir.y<0?(box.y-start.y)/dir.y:Infinity;
    var t=Math.max(0,Math.min(tx,ty));
    return {x:start.x+dir.x*t,y:start.y+dir.y*t};
  }
  (board.items||[]).forEach(function(it){
    if(it.type!=='connector') return;
    var a=byId[it.from], b=byId[it.to];
    if(!a||!b) return;
    var fc={x:a.x+a.w/2,y:a.y+a.h/2}, tc={x:b.x+b.w/2,y:b.y+b.h/2};
    var e1=rayBoxExit(fc,{x:tc.x-fc.x,y:tc.y-fc.y},a);
    var e2=rayBoxExit(tc,{x:fc.x-tc.x,y:fc.y-tc.y},b);
    var line=document.createElementNS(ns2,'line');
    line.setAttribute('x1',e1.x); line.setAttribute('y1',e1.y);
    line.setAttribute('x2',e2.x); line.setAttribute('y2',e2.y);
    line.setAttribute('stroke','currentColor');
    line.setAttribute('stroke-width','1.75');
    line.setAttribute('vector-effect','non-scaling-stroke');
    line.setAttribute('marker-end','url(#cr-arrow)');
    line.setAttribute('style','color:var(--text-2)');
    connectorSvg.appendChild(line);
  });
  world.appendChild(connectorSvg);

  function applyView(){
    world.style.transform='translate('+view.x+'px,'+view.y+'px) scale('+view.zoom+')';
    grid.style.backgroundSize=(24*view.zoom)+'px '+(24*view.zoom)+'px';
    grid.style.backgroundPosition=view.x+'px '+view.y+'px';
    zoomLabel.textContent=Math.round(view.zoom*100)+'%';
  }
  applyView();

  viewport.addEventListener('wheel',function(e){
    e.preventDefault();
    var r=viewport.getBoundingClientRect();
    var cx=e.clientX-r.left, cy=e.clientY-r.top;
    if(e.ctrlKey||e.metaKey){
      var factor=Math.exp(-e.deltaY*0.01);
      var nz=Math.min(8,Math.max(0.1,view.zoom*factor));
      var wx=(cx-view.x)/view.zoom, wy=(cy-view.y)/view.zoom;
      view.zoom=nz; view.x=cx-wx*nz; view.y=cy-wy*nz;
    } else { view.x-=e.deltaX; view.y-=e.deltaY; }
    applyView();
  },{passive:false});

  var spaceDown=false;
  window.addEventListener('keydown',function(e){if(e.code==='Space'){spaceDown=true;e.preventDefault();}});
  window.addEventListener('keyup',function(e){if(e.code==='Space')spaceDown=false;});

  viewport.addEventListener('pointerdown',function(e){
    if(e.target.closest('a')) return;
    if(!spaceDown && e.button===0) return; // let iframes/links be interactive
    e.preventDefault();
    viewport.classList.add('grabbing');
    var sx=e.clientX, sy=e.clientY, ox=view.x, oy=view.y;
    function mv(ev){view.x=ox+(ev.clientX-sx); view.y=oy+(ev.clientY-sy); applyView();}
    function up(){window.removeEventListener('pointermove',mv);window.removeEventListener('pointerup',up);
      viewport.classList.remove('grabbing');}
    window.addEventListener('pointermove',mv); window.addEventListener('pointerup',up);
  });
  viewport.addEventListener('contextmenu',function(e){e.preventDefault();});
})();
`;

export const downloadHtml = (board: Board, theme: Theme = "light") => {
  const html = exportToHtml(board, theme);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(board.name || "board").replace(/[^\w\-. ]+/g, "_")}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
