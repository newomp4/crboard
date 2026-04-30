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

import type { Board } from "./types";

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

export const exportToHtml = (board: Board): string => {
  const title = escapeHtml(board.name || "crboard");
  const data = safeJson(board);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${title}</title>
<style>
  html,body{height:100%;margin:0;background:#fafafa;color:#0a0a0a;
    font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Inter,sans-serif;
    -webkit-font-smoothing:antialiased;overflow:hidden}
  *{box-sizing:border-box}
  #viewport{position:absolute;inset:0;overflow:hidden;touch-action:none;cursor:grab}
  #viewport.grabbing{cursor:grabbing}
  #grid{position:absolute;inset:0;pointer-events:none;opacity:.6;
    background-image:radial-gradient(circle,#d4d4d4 1px,transparent 1px)}
  #world{position:absolute;left:0;top:0;transform-origin:0 0;width:0;height:0}
  .item{position:absolute}
  .item.text{padding:12px;line-height:1.4;background:#fff;border:1px solid #e5e5e5;
    white-space:pre-wrap;overflow:auto}
  .item.image img{width:100%;height:100%;object-fit:contain;display:block;background:#fafafa}
  .item.embed{display:flex;flex-direction:column;background:#fafafa;border:1px solid #e5e5e5;overflow:hidden}
  .item.embed .frame-wrap{flex:1;position:relative;min-height:0}
  .item.embed iframe{width:100%;height:100%;border:0;background:#fafafa;display:block}
  .item.embed .src-link{display:flex;align-items:center;gap:6px;padding:6px 10px;
    border-top:1px solid #e5e5e5;background:#fff;font-size:11px;color:#525252;
    text-decoration:none;flex-shrink:0}
  .item.embed .src-link span.label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .item.embed .src-link b{color:#0a0a0a;font-weight:500}
  .item.link{display:flex;flex-direction:column;justify-content:center;padding:16px;
    background:#fff;border:1px solid #e5e5e5;text-decoration:none;color:#0a0a0a;font-size:14px;
    word-break:break-word}
  .item.link b{display:block;margin-bottom:4px;font-weight:600}
  .item.link span{color:#737373;font-size:12px}
  .item.drawing svg{display:block;overflow:visible;pointer-events:none}
  #hint{position:fixed;left:12px;bottom:12px;font-size:11px;color:#737373;
    background:rgba(255,255,255,.85);padding:6px 10px;border:1px solid #e5e5e5;
    pointer-events:none;letter-spacing:.01em}
  #title{position:fixed;left:12px;top:12px;font-size:13px;font-weight:600;color:#0a0a0a;
    background:rgba(255,255,255,.85);padding:6px 10px;border:1px solid #e5e5e5;pointer-events:none}
  #zoom{position:fixed;right:12px;bottom:12px;font-size:11px;color:#737373;
    background:rgba(255,255,255,.85);padding:6px 10px;border:1px solid #e5e5e5;
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
      el.textContent=it.text||'';
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
    }
    return el;
  }

  (board.items||[]).forEach(function(it){ world.appendChild(renderItem(it)); });

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

export const downloadHtml = (board: Board) => {
  const html = exportToHtml(board);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(board.name || "board").replace(/[^\w\-. ]+/g, "_")}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
