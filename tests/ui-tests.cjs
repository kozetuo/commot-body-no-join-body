'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Also works after this file is copied into the deliverable's tests/ directory.
const candidates = [path.join(__dirname, '../plugin'), path.join(__dirname, '../outputs/commot-body-no-join-body/plugin')];
const plugin = candidates.find(dir => fs.existsSync(path.join(dir, 'index.js')));
if (!plugin) throw new Error('Cannot locate the plugin directory.');
const Engine = require(path.join(plugin, 'lib/separation.js'));
const colors = [[16, 30, 45], [238, 87, 42], [25, 160, 150], [255, 255, 255]];
function makeImage(width, height, pixel) {
  const data = new Uint8Array(width * height * 4);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) data.set(pixel(x,y), (y*width+x)*4);
  return {width,height,data};
}
class Element {
  constructor(tag) { this.tagName=tag;this.style={};this.className='';this.value='';this.disabled=false;this.children=[];this.listeners={};this._text=''; }
  set textContent(value) { this._text=String(value);this.children=[]; }
  get textContent() { return this._text; }
  appendChild(child) { this.children.push(child);return child; }
  setAttribute(name,value) { this[name]=String(value); }
  addEventListener(name, fn) { (this.listeners[name]||(this.listeners[name]=[])).push(fn); }
  async dispatch(name, force=false) { if(this.disabled&&!force)return;for(const fn of this.listeners[name]||[]) await fn({target:this,type:name}); }
}
function harness({readError}={}) {
  const ids = new Map();
  const html = fs.readFileSync(path.join(plugin,'index.html'),'utf8');
  for (const match of html.matchAll(/<([a-z-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const el=new Element(match[1].toLowerCase());el.id=match[3];
    const value=match[2].match(/\bvalue="([^"]*)"/);if(value)el.value=value[1];
    ids.set(el.id,el);
  }
  const $=id=>{assert.ok(ids.has(id),'Missing DOM '+id);return ids.get(id);};
  // Native selects expose their selected option through value.
  $('substrate').value='none';$('lpi').value='35';$('angle').value='22.5';$('tolerance').value='4';$('substrateHex').value='#FFFFFF';
  function all() { const result=[];const visit=el=>{result.push(el);el.children.forEach(visit);};ids.forEach(visit);return result; }
  const document={getElementById:$,createElement:tag=>new Element(tag),querySelectorAll:selector=>all().filter(el=>selector==='.hex-input'?el.className.split(/\s+/).includes('hex-input'):selector==='button, input, select'?['button','input','select'].includes(el.tagName):false)};
  const full=makeImage(80,60,(x,y)=>[...colors[(x===79&&y===59)?2:((x+y)%3===2?3:(x+y)%3)],255]);
  const preview=makeImage(40,30,(x,y)=>[...colors[(x+y)%3===2?3:(x+y)%3],255]);
  const source={id:9,name:'Accent design.png',width:80,height:60,resolution:300,historyStateID:12};
  const calls={reads:0,analyses:[],outputs:[],encodes:[],separations:[]};
  let analyzeGate=null, encodeCount=0;
  const Host={
    async readPreview() {calls.reads++;if(readError)throw new Error(readError);return {source,image:preview,dataUrl:'source-url'};},
    async analyzeSource(s,options,progress) {calls.analyses.push({...options});if(analyzeGate)await analyzeGate;progress(1,'Analyzed');return Engine.analyze(full,options);},
    async encodePreview(data,width,height,background) {calls.encodes.push({data:new Uint8Array(data),width,height,background});return 'preview-'+(++encodeCount);},
    async createSeparations(s,palette,options) {calls.outputs.push({kind:'layers',source:s,palette:palette.map(c=>c.slice()),options:{...options}});return {name:'Separated art'};},
    async exportFilms(s,palette,options) {calls.outputs.push({kind:'films',source:s,palette:palette.map(c=>c.slice()),options:{...options}});return {folderName:'Film folder'};}
  };
  const wrapped={...Engine,separate(image,palette,options){calls.separations.push({...options});return Engine.separate(image,palette,options);}};
  let nextTimer=1;const timers=new Map();
  const context={document,Uint8Array,console,require:name=>name==='./lib/separation'?wrapped:name==='./lib/photoshop-host'?Host:(()=>{throw Error('Unexpected require '+name);})(),setTimeout(fn){const id=nextTimer++;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}};
  vm.runInNewContext(fs.readFileSync(path.join(plugin,'index.js'),'utf8'),context,{filename:'plugin/index.js'});
  async function settle() {for(let i=0;i<12;i++)await Promise.resolve();}
  async function click(id,force=false){await $(id).dispatch('click',force);await settle();}
  async function change(id,value){$(id).value=value;await $(id).dispatch('change');await settle();}
  async function flush(){while(timers.size){const pending=[...timers.values()];timers.clear();for(const fn of pending)await fn();}await settle();}
  return {$,calls,click,change,flush,settle,fields:()=>document.querySelectorAll('.hex-input'),timers,setGate:gate=>{analyzeGate=gate;}};
}
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
  await test('actual controller reads, analyzes original pixels, and enables output',async()=>{
    const h=harness();assert.equal(h.$('createLayers').disabled,true);await h.click('readArtwork');
    assert.equal(h.calls.reads,1);assert.equal(h.calls.analyses.length,1);assert.equal(h.fields().length,4,'Rare full-resolution accent must be inferred');
    assert.equal(h.$('createLayers').disabled,false);assert.equal(h.$('exportFilms').disabled,false);assert.equal(h.calls.separations.at(-1).sourceScale,2);
    await h.click('createLayers');assert.equal(h.calls.outputs.length,1);assert.equal(h.calls.outputs[0].options.sourceScale,1);assert.equal(h.calls.outputs[0].options.dpi,300);assert.equal(h.calls.outputs[0].palette.length,4);assert.match(h.$('status').textContent,/Created/);
  });
  await test('capture errors remain visible beside Read and release the busy controls',async()=>{
    const message='The requested functionality is only allowed from inside a modal scope';
    const h=harness({readError:message});await h.click('readArtwork');
    assert.equal(h.$('readStatus').textContent,message);assert.equal(h.$('status').textContent,message);
    assert.equal(h.$('readStatus').className,'capture-status error');
    assert.equal(h.$('readArtwork').disabled,false);assert.equal(h.$('createLayers').disabled,true);
    assert.equal(h.calls.analyses.length,0);
  });
  await test('palette edits are honored and unfocused HEX edits are committed at output',async()=>{
    const h=harness();await h.click('readArtwork');const oldAnalyses=h.calls.analyses.length;
    let field=h.fields()[0];field.value='#132435';await field.dispatch('change');await h.settle();
    assert.equal(h.calls.analyses.length,oldAnalyses);assert.equal(h.fields()[0].value,'#132435');
    h.fields()[0].value='#AABBCC';await h.click('exportFilms');assert.equal(h.calls.outputs[0].kind,'films');assert.deepEqual(Array.from(h.calls.outputs[0].palette[0]),[170,187,204]);assert.match(h.$('status').textContent,/Exported/);
  });
  await test('count, substrate, and mode changes debounce into current palette and settings',async()=>{
    const h=harness();await h.click('readArtwork');const start=h.calls.analyses.length;
    await h.click('count3');await h.change('substrate','white');await h.click('modeHalftone');await h.change('lpi','25');await h.change('angle','30');
    assert.equal(h.$('createLayers').disabled,true);assert.equal(h.timers.size,1);await h.flush();
    assert.equal(h.calls.analyses.length,start+1);assert.equal(h.$('createLayers').disabled,false);
    await h.click('createLayers');const output=h.calls.outputs.at(-1);assert.equal(output.options.inkCount,3);assert.equal(output.options.mode,'halftone');assert.equal(output.options.substrate,'white');assert.equal(output.options.lpi,25);assert.equal(output.options.angle,30);assert.ok(output.palette.length<=3);assert.ok(!output.palette.some(c=>c.every(v=>v===255)));
  });
  await test('pending count change cannot export the stale palette',async()=>{
    const h=harness();await h.click('readArtwork');assert.equal(h.fields().length,4);await h.click('count3');
    // Exercise the handler defensively even though the real button is disabled.
    await h.click('exportFilms',true);assert.equal(h.calls.outputs.length,1);assert.equal(h.calls.outputs[0].options.inkCount,3);assert.equal(h.calls.outputs[0].palette.length,3);assert.equal(h.timers.size,0);
  });
  await test('invalid HEX is rejected before any output and restores edited field',async()=>{
    const h=harness();await h.click('readArtwork');const field=h.fields()[0],old=field.value;field.value='oops';await field.dispatch('change');await h.settle();assert.equal(field.value,old);assert.match(h.$('status').textContent,/six-digit/);
    h.fields()[0].value='#GGGGGG';await h.click('exportFilms');assert.equal(h.calls.outputs.length,0);assert.match(h.$('status').textContent,/six-digit/);
  });
  await test('invalid settings disable output and recover after correction',async()=>{
    const h=harness();await h.click('readArtwork');await h.click('modeHalftone');await h.change('lpi','110');await h.flush();assert.equal(h.$('createLayers').disabled,true);assert.match(h.$('status').textContent,/LPI/);
    await h.change('lpi','25');await h.flush();assert.equal(h.$('createLayers').disabled,false);await h.change('angle','100');await h.flush();assert.equal(h.$('createLayers').disabled,true);assert.match(h.$('status').textContent,/angle/);
    await h.change('angle','22.5');await h.change('tolerance','31');await h.flush();assert.equal(h.$('createLayers').disabled,true);assert.match(h.$('status').textContent,/tolerance/);
  });
  await test('full-resolution analysis keeps controls disabled until its result is ready',async()=>{
    const h=harness();await h.click('readArtwork');let release;h.setGate(new Promise(resolve=>{release=resolve;}));await h.click('count8');const pending=h.flush();await h.settle();assert.equal(h.$('createLayers').disabled,true);assert.equal(h.$('readArtwork').disabled,true);release();await pending;assert.equal(h.$('createLayers').disabled,false);assert.equal(h.fields().length,4);
  });
  console.log(count+' controller integration tests passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
