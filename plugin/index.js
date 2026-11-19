(function () {
  'use strict';
  const demo = typeof window !== 'undefined' && window.CommotDemoHost;
  const Engine = demo ? window.CommotSeparation : require('./lib/separation');
  const Host = demo || require('./lib/photoshop-host');
  const $ = id => document.getElementById(id);
  const state = { source:null, image:null, originalUrl:null, palette:[], result:null, inkCount:5, mode:'solid', view:'separated', selectedInk:0, busy:false, cancelled:false, generation:0, timer:null, pending:false, pendingAnalyze:false };
  function hex(rgb) { return '#' + rgb.map(v => Math.round(v).toString(16).padStart(2,'0')).join('').toUpperCase(); }
  function parseHex(text) { const s=String(text).trim().replace(/^#/,''); if(!/^[0-9a-f]{6}$/i.test(s)) throw new Error('Use a six-digit ink color, for example #E85A32.'); return [0,2,4].map(i=>parseInt(s.slice(i,i+2),16)); }
  function status(message,error) {
    $('status').textContent=message; $('status').className=error?'error':'';
    $('readStatus').textContent=message; $('readStatus').className='capture-status'+(error?' error':'');
    if(error) console.error('[COMMOT] '+message);
  }
  function options(fullResolution) {
    let substrate=$('substrate').value;
    if(substrate==='custom') substrate=parseHex($('substrateHex').value);
    const dpi=state.source ? state.source.resolution : 300;
    const lpi=Number($('lpi').value), angle=Number($('angle').value), tolerance=Number($('tolerance').value);
    if(state.mode==='halftone' && (!Number.isFinite(lpi)||lpi<10||lpi>120||lpi>dpi/4)) throw new Error('Set LPI between 10 and '+Math.floor(Math.min(120,dpi/4))+'. Use at least 4 image pixels per halftone cell.');
    if(!Number.isFinite(angle)||angle<0||angle>90) throw new Error('Set the halftone angle between 0° and 90°.');
    if(!Number.isFinite(tolerance)||tolerance<0||tolerance>30) throw new Error('Set background tolerance between 0 and 30.');
    return {inkCount:state.inkCount,mode:state.mode,substrate,tolerance,dpi,lpi,angle,sourceScale:fullResolution?1:(state.source&&state.image?state.source.width/state.image.width:1),isCancelled:()=>state.cancelled};
  }
  function updateButtons() {
    document.querySelectorAll('button, input, select').forEach(el=>{el.disabled=state.busy;});
    $('cancel').disabled=false;
    $('cancel').style.display=state.busy?'block':'none';
    $('createLayers').disabled=state.busy||state.pending||!state.result||!!demo;
    $('exportFilms').disabled=state.busy||state.pending||!state.result||!!demo;
    $('resetPalette').disabled=state.busy||!state.image;
    $('viewFilm').disabled=state.busy||!state.result;
    $('viewOriginal').disabled=state.busy||!state.image;
    $('viewSeparated').disabled=state.busy||!state.result;
    if(demo) { $('createLayers').title='Load this plugin in Photoshop to create full-resolution layers.'; $('exportFilms').title='Load this plugin in Photoshop to export print films.'; }
  }
  function busy(value) { state.busy=value; if(value) {state.cancelled=false;$('progressTrack').style.display='block';$('progressFill').style.width='0%';} else {$('progressTrack').style.display='none';} updateButtons(); }
  function progress(fraction,message) { $('progressFill').style.width=Math.round(Math.max(0,Math.min(1,fraction))*100)+'%'; status(message||'Separating…'); }
  function paletteUI() {
    const parent=$('palette'); parent.textContent='';
    state.palette.forEach((color,i)=>{
      const cell=document.createElement('div');cell.className='ink';
      const swatch=document.createElement('button');swatch.className='swatch'+(state.view==='film'&&state.selectedInk===i?' selected':'');swatch.style.backgroundColor=hex(color);swatch.title='Inspect ink '+(i+1)+' film';
      const n=document.createElement('span');n.className='swatch-number';n.textContent=String(i+1).padStart(2,'0');swatch.appendChild(n);
      swatch.addEventListener('click',()=>{state.selectedInk=i;selectView('film');});
      const field=document.createElement('input');field.type='text';field.className='hex-input';field.value=hex(color);field.maxLength=7;field.title='Ink '+(i+1)+' HEX color';field.setAttribute('aria-label','Ink '+(i+1)+' HEX color');
      field.addEventListener('change',()=>{try{state.palette[i]=parseHex(field.value);recompute(false);}catch(e){field.value=hex(state.palette[i]);status(e.message,true);}});
      const area=document.createElement('div');area.className='ink-coverage';area.textContent=((state.result?state.result.coverage[i]:0)*100).toFixed(1)+'% of canvas';
      cell.appendChild(swatch);cell.appendChild(field);cell.appendChild(area);parent.appendChild(cell);
    });
    $('inkSummary').textContent=state.palette.length+' ink'+(state.palette.length===1?'':'s')+' / '+state.inkCount+' max';
  }
  async function drawPreview(generation) {
    if(!state.image||!state.result)return;
    const view=state.view, image=state.image, palette=state.palette, result=state.result;
    let url=state.originalUrl;
    if(view!=='original') {
      let rgba;
      if(view==='film') {
        const gray=Engine.makePlate(result.indices,image.width,image.height,state.selectedInk);
        rgba=new Uint8Array(gray.length*4);
        for(let p=0;p<gray.length;p++) { const j=p*4;rgba[j]=rgba[j+1]=rgba[j+2]=gray[p];rgba[j+3]=255; }
      } else rgba=Engine.renderComposite(image,result,palette,options(false));
      url=await Host.encodePreview(rgba,image.width,image.height,[232,230,218]);
    }
    if(generation!==state.generation)return;
    $('emptyState').style.display='none';$('previewImage').style.display='block';$('previewImage').src=url;
    $('previewBadge').textContent=view==='film'?'INK '+String(state.selectedInk+1).padStart(2,'0')+' / PREVIEW':view==='original'?'SOURCE / PREVIEW':palette.length+' INKS / PREVIEW';
    ['original','separated','film'].forEach(v=>$('view'+v[0].toUpperCase()+v.slice(1)).className='tab'+(view===v?' active':''));
  }
  async function recompute(analyze) {
    if(!state.image)return;
    clearTimeout(state.timer);analyze=analyze||state.pendingAnalyze;state.pendingAnalyze=false;state.pending=false;
    const generation=++state.generation;
    const ownsBusy=analyze&&!state.busy&&!!Host.analyzeSource;
    if(ownsBusy)busy(true);
    try {
      const opts=options(false);
      if(analyze)state.palette=(Host.analyzeSource?await Host.analyzeSource(state.source,opts,progress):Engine.analyze(state.image,opts)).palette;
      if(!state.palette.length)throw new Error('No printable colors found. Try “Print every color” or lower background tolerance.');
      state.selectedInk=Math.min(state.selectedInk,state.palette.length-1);
      state.result=Engine.separate(state.image,state.palette,opts);
      paletteUI();updateButtons();
      await drawPreview(generation);
      if(generation===state.generation)status(state.palette.length+' printable ink'+(state.palette.length===1?'':'s')+'. '+(demo?'Preview ready. Load the plugin in Photoshop for output.':'Review your colors, then create layers or export films.'));
    } catch(e) { if(generation===state.generation) {state.result=null;updateButtons();status(state.cancelled?'Analysis cancelled.':e.message||String(e),!state.cancelled);} }
    finally {if(ownsBusy)busy(false);}
  }
  function schedule(analyze) { clearTimeout(state.timer);state.pending=true;state.pendingAnalyze=state.pendingAnalyze||analyze;updateButtons();state.timer=setTimeout(()=>recompute(false),200); }
  function selectView(view) { state.view=view;paletteUI();const g=++state.generation;drawPreview(g).catch(e=>status(e.message,true)); }
  async function readArtwork() {
    if(state.busy)return;
    busy(true);status('Reading the visible artwork…');
    try {
      const read=await Host.readPreview(1000);
      if(state.cancelled) {status('Read cancelled.');return;}
      state.source=read.source;state.image=read.image;state.originalUrl=read.dataUrl;
      state.view='separated';state.selectedInk=0;
      $('sourceName').textContent=read.source.name;
      $('sourceSize').textContent=read.source.width+' × '+read.source.height+' / '+Math.round(read.source.resolution)+' DPI';
      const maxLpi=Math.floor(Math.min(120,read.source.resolution/4));$('lpi').max=String(maxLpi);
      if(Number($('lpi').value)>maxLpi)$('lpi').value=String(Math.max(10,Math.floor(read.source.resolution/6)));
      await recompute(true);
    } catch(e) {console.error('[COMMOT] Artwork capture failed',e);status(e.message||String(e),true);} finally {busy(false);}
  }
  async function output(kind) {
    clearTimeout(state.timer);
    // Commit edited settings and any HEX field which has not yet lost focus.
    if(!state.image||state.busy)return;
    let opts;try{document.querySelectorAll('.hex-input').forEach((el,i)=>{state.palette[i]=parseHex(el.value);});opts=options(true);}catch(e){status(e.message,true);return;}
    busy(true);
    try {
      await recompute(false);
      if(!state.result||state.cancelled)return;
      const result=await Host[kind](state.source,state.palette,opts,progress);
      if(!result) {status('Export cancelled.');return;}
      if(kind==='createSeparations')status('Created “'+result.name+'”. Your original artwork is unchanged.');
      else status('Exported '+state.palette.length+' print films + ink map to “'+result.folderName+'”.');
    } catch(e) {status(state.cancelled?'Cancelled.':e.message||String(e),!state.cancelled);}finally{busy(false);}
  }
  $('readArtwork').addEventListener('click',readArtwork);
  for(let n=3;n<=8;n++)$('count'+n).addEventListener('click',()=>{state.inkCount=n;for(let k=3;k<=8;k++)$('count'+k).className=k===n?'active':'';schedule(true);});
  ['solid','halftone'].forEach(mode=>$('mode'+mode[0].toUpperCase()+mode.slice(1)).addEventListener('click',()=>{
    state.mode=mode;$('modeSolid').className=mode==='solid'?'active':'';$('modeHalftone').className=mode==='halftone'?'active':'';
    $('halftoneSettings').style.display=mode==='halftone'?'flex':'none';
    $('modeHint').textContent=mode==='solid'?'Clean, solid shapes. Best for logos, type and flat illustrations.':'Clustered dots mix your inks to retain gradients, shading and soft edges.';schedule(false);
  }));
  ['lpi','angle'].forEach(id=>$(id).addEventListener('change',()=>schedule(false)));
  ['tolerance','substrateHex'].forEach(id=>$(id).addEventListener('change',()=>schedule(true)));
  $('substrate').addEventListener('change',()=>{$('substrateHexWrap').style.display=$('substrate').value==='custom'?'block':'none';$('toleranceWrap').style.display=$('substrate').value==='none'?'none':'flex';schedule(true);});
  $('resetPalette').addEventListener('click',()=>recompute(true));
  ['original','separated','film'].forEach(v=>$('view'+v[0].toUpperCase()+v.slice(1)).addEventListener('click',()=>selectView(v)));
  $('createLayers').addEventListener('click',()=>output('createSeparations'));
  $('exportFilms').addEventListener('click',()=>output('exportFilms'));
  $('cancel').addEventListener('click',()=>{state.cancelled=true;status('Cancelling after the current image strip…');});
  updateButtons();
  if(demo) { $('demoNote').style.display='block';$('readArtwork').textContent='Reload sample ↗';window.CommotUI={state,recompute,readArtwork};readArtwork(); }
})();
