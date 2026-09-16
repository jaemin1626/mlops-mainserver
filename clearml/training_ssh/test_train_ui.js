/* A dependency-free UI flow test. Run: node test_train_ui.js ../branding/train/app.js */
async function testTrainingUi(source) {
  function assert(value, message) { if (!value) throw Error(message); }
  const elements = new Map();
  class Element {
    constructor() { this.value=''; this.checked=false; this.disabled=false; this.hidden=false; this.textContent=''; this.dataset={}; this.children=[]; this.listeners={}; this.type='text'; }
    focus() {}
    setCustomValidity(message){this.validationMessage=message;}
    closest(selector) { return this.group===selector?this:this.parent?.closest?.(selector)||null; }
    get options(){return this.children;}
    setAttribute(k,v) { this[k]=v; }
    removeAttribute(k) { delete this[k]; }
    addEventListener(k,f) { this.listeners[k]=f; }
    replaceChildren(...items) { this.children=items; }
    append(...items) { items.forEach(item=>item.parent=this);this.children.push(...items); }
    appendChild(item) { item.parent=this;this.children.push(item); }
    add(item) { this.children.push(item); }
  }
  const el = key => { if(!elements.has(key))elements.set(key,new Element()); return elements.get(key); };
  const detectorNames=['type','data','detector_classes','detector_epochs','batch','gpu','img_size','detector_model_size','name','detector_resume'];
  const legacyNames=['dataset','output_name','detector_base_model','vlm_base_model','resume','lora_enabled','classes','train_path','val_path','weights','epochs','batch_size','learning_rate','sequence_length','lora_rank','lora_alpha','lora_dropout'];
  const vlmNames='modality mode model train_json val_json epochs batch gradient_accumulation learning_rate max_length workers name lora_rank lora_alpha lora_dropout lora_target_modules gradient_checkpointing video_fps video_max_pixels validation_ratio validation_seed max_samples eval_steps logging_steps save_steps save_total_limit'.split(' ').map(k=>'vlm_'+k);
  const fields=Object.fromEntries([...detectorNames,...legacyNames,...vlmNames].map(k=>[k,el('field:'+k)]));
  vlmNames.forEach(k=>fields[k].group='#vlm-settings');fields.vlm_modality.value='image';fields.vlm_mode.value='lora';
  detectorNames.forEach(k=>fields[k].group='#detector-settings');legacyNames.forEach(k=>fields[k].group='#vlm-settings');
  for(const k of ['resume','detector_resume','lora_enabled'])fields[k].type='checkbox';
  const modelButtons=['detector','vlm'].map(name=>{const b=el('model:'+name);b.dataset.model=name;return b;});
  const form=el('#train-form');form.elements=fields;form.reset=()=>{};form.reportValidity=()=>true;
  const datasetControls=[fields.type,fields.data,fields.detector_classes,...['#detector-folder-select','#detector-refresh-datasets','#detector-generate-annotations','#detector-apply-classes','#detector-add-dataset'].map(el)];
  const document={
    querySelector:el,createElement:()=>new Element(),createTextNode:text=>({textContent:text}),addEventListener(){},
    querySelectorAll(selector){
      const gpuInputs=el('#vlm-gpus').children.flatMap(label=>label.children.filter(child=>child.type==='checkbox'));
      if(selector==='#vlm-gpus input:checked')return gpuInputs.filter(input=>input.checked);
      if(selector.startsWith('#vlm-lora input'))return ['lora_rank','lora_alpha','lora_dropout','lora_target_modules'].map(k=>fields['vlm_'+k]);
      if(selector.startsWith('#vlm-video input'))return ['video_fps','video_max_pixels'].map(k=>fields['vlm_'+k]);
      if(selector.startsWith('#train-form input'))return [...Object.values(fields),...gpuInputs,...modelButtons,...datasetControls,el('#launch'),el('#stop')];
      if(selector==='[data-model]')return modelButtons;
      if(selector.startsWith('#dataset input'))return [...datasetControls,...modelButtons];
      if(selector.startsWith('#detector-settings input'))return detectorNames.map(k=>fields[k]);
      if(selector.startsWith('#vlm-settings input'))return [...legacyNames,...vlmNames].map(k=>fields[k]);
      return [];
    }
  };
  class FormData {
    constructor(){return Object.entries(fields).filter(([k,v])=>!v.disabled&&(v.type!=='checkbox'||v.checked)).map(([k,v])=>[k,v.value]);}
  }
  const requests=[];
  const catalog={folders:['images_json','videos_json'],defaults:{TRAIN_MODALITY:'image',TRAIN_MODE:'lora',DEVICE:'0,1',BATCH_SIZE:'1',GRAD_ACCUM:'4'},models:[{path:'/workspace/VLM/weights/Image',label:'Image',modality:'image'}],datasets:[],gpus:[{id:'0',name:'GPU',free_mb:96000},{id:'1',name:'GPU',free_mb:96000}],automatic:{image:{train_json:['/workspace/VLM/annotation/vlm/image/latest/train.json'],val_json:['/workspace/VLM/annotation/vlm/image/latest/valid.json']}}};
  let active=null,failStop=false;
  let failPreparation=false, deferredPreparation=null, releasePreparation;
  const fetch=async(url,options)=>{
    requests.push({url,options});
    let data,status=200;
    if(url.endsWith('/vlm/resources'))data=catalog;
    else if(url.endsWith('/vlm/annotations'))data={train_json:'/workspace/VLM/data/vlm/image/20260914/train.json',val_json:'/workspace/VLM/data/vlm/image/20260914/valid.json',train:9,valid:1};
    else if(url.endsWith('/vlm/preview')){const params=JSON.parse(options.body);data={params,effective:{...params,learning_rate:0.0002,max_length:null},sources:{},command:'train.sh --type vlm',effective_batch:8,automatic:catalog.automatic.image,warnings:[]};}
    else if(url.endsWith('/capabilities'))data={launch:true};
    else if(url.endsWith('/detector/datasets'))data={items:['one','two'],classes:['person','car']};
    else if(url.endsWith('/detector/annotations')){
      if(deferredPreparation)await deferredPreparation;
      if(failPreparation){status=400;data={error:'클래스 ID 범위 오류'};}
      else {
        const names=JSON.parse(options.body).classes;
        data={data:'data/generated/example/data.yaml',yaml:'train: train.txt\nval: test.txt\nnames: '+JSON.stringify(names),files:{'data.yaml':'/server/data.yaml','train.txt':'/server/train.txt','test.txt':'/server/test.txt'},train:9,test:1,missing_labels:0};
      }
    } else if(url.endsWith('/jobs/active'))data={jobs:active?[active]:[],remote_running:!!active};
    else if(url.endsWith('/jobs/job1/stop')||url.endsWith('/stop')){if(failStop){status=502;data={error:'remote stop failed'};}else{active=null;data={status:'stopped'};}}
    else if(url.endsWith('/jobs')){active={id:'job1',status:'running',params:JSON.parse(options.body),logs:'training'};data=active;}
    else if(url.endsWith('/jobs/job1'))data={id:'job1',status:'completed',logs:'done'};
    else throw Error('Unexpected request '+url);
    return {ok:status===200,headers:{get:()=> 'application/json'},json:async()=>data};
  };
  const window={addEventListener(){}};window.parent=window;
  const storage=new Map();
  const sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  const Option=function(text,value){this.textContent=text;this.value=value;};
  new Function('document','window','sessionStorage','fetch','AbortSignal','FormData','Option','setTimeout','clearTimeout',source)(
    document,window,sessionStorage,fetch,{timeout:()=>null},FormData,Option,()=>0,()=>{});
  const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
  await settle();
  assert(fields.detector_classes.value==='person\ncar','default classes loaded');
  const add=folder=>{el('#detector-folder-select').value=folder;el('#detector-add-dataset').onclick();};
  add('one');add('two');add('one');
  assert(el('#detector-selected-datasets').children.length===2,'duplicate folders prevented');
  assert(el('#launch').disabled,'unapplied folders block launch');
  await el('#detector-generate-annotations').onclick();
  assert(!el('#launch').disabled,'prepared dataset enables launch');
  assert(fields.data.value==='data/generated/example/data.yaml','generated YAML path used');
  assert(el('#detector-generated-files').textContent.split('\n').length===3&&!el('#detector-generated-files').textContent.includes('.json'),'only TXT and YAML files shown');
  assert(el('#config-preview').textContent.includes('val: test.txt'),'generated YAML preview');
  el('#request-tab').onclick();
  let payload=JSON.parse(el('#config-preview').textContent);
  assert(payload.type==='detector'&&payload.data===fields.data.value,'training payload type and YAML');
  assert(!('classes' in payload)&&Array.isArray(payload.folders)&&!('detector_classes' in payload),'UI preparation fields stay out of train.sh request');
  const before=fields.data.value;
  fields.detector_classes.value='person\nvehicle';form.listeners.input();
  assert(el('#launch').disabled,'class changes require apply');
  failPreparation=true;
  await el('#detector-apply-classes').onclick();
  assert(el('#detector-annotation-status').textContent.includes('클래스 ID 범위 오류'),'failed preparation message retained');
  assert(fields.data.value===before&&el('#launch').disabled,'failed update cannot launch new settings');
  failPreparation=false;
  await el('#detector-apply-classes').onclick();
  el('#yaml-tab').onclick();
  assert(el('#config-preview').textContent.includes('vehicle'),'class apply updates YAML');
  await form.onsubmit({preventDefault(){}});
  const launches=requests.filter(r=>r.url.endsWith('/jobs'));
  assert(launches.length===1,'launch posted once');
  assert(JSON.parse(launches[0].options.body).data===before,'launch uses prepared YAML');
  assert(el('#job-state').textContent==='running','active status restored');
  assert(fields.gpu.disabled&&modelButtons[0].disabled&&el('#launch').disabled&&!el('#stop').disabled&&!el('#running-link').hidden,'running controls locked');
  const savedData=fields.data.value;
  new Function('document','window','sessionStorage','fetch','AbortSignal','FormData','Option','setTimeout','clearTimeout',source)(document,window,sessionStorage,fetch,{timeout:()=>null},FormData,Option,()=>0,()=>{});
  await settle();assert(fields.data.value===savedData&&fields.detector_classes.value==='person\nvehicle'&&fields.gpu.disabled&&!el('#stop').disabled,'reopened page restores settings and active lock');await el('#detector-refresh-datasets').onclick();assert(fields.data.value===savedData,'folder refresh preserves YAML');
  failStop=true;await el('#stop').onclick();assert(!el('#stop').disabled&&fields.gpu.disabled,'failed stop allows retry and preserves lock');
  failStop=false;await el('#stop').onclick();assert(!fields.gpu.disabled&&fields.output_name.disabled&&el('#stop').disabled,'successful stop restores only active model fields');
  el('#detector-selected-datasets').onclick({target:{closest:()=>({dataset:{index:'0'}})}});
  assert(el('#detector-selected-datasets').children.length===1&&el('#launch').disabled,'removal invalidates prepared dataset');
  deferredPreparation=new Promise(resolve=>releasePreparation=resolve);
  const pending=el('#detector-apply-classes').onclick();
  assert(el('#launch').disabled&&modelButtons[0].disabled,'preparation prevents launch and model switching');
  fields.detector_classes.value='different';
  releasePreparation();await pending;
  assert(el('#detector-annotation-status').textContent.includes('설정이 변경'),'stale response rejected');
  modelButtons[1].onclick();await settle();
  assert(el('#launch').disabled,'VLM requires final review');
  assert(el('#vlm-effective-batch').textContent.includes('= 8'),'VLM effective batch uses selected GPUs and server defaults');
  fields.vlm_learning_rate.value='0';form.listeners.input();assert(fields.vlm_learning_rate.validationMessage,'UI rejects zero learning rate');fields.vlm_learning_rate.value='';fields.vlm_epochs.value='1';fields.vlm_lora_rank.value='8';form.listeners.input();
  el('#vlm-folder-select').value='images_json';el('#vlm-add-dataset').onclick();el('#vlm-folder-select').value='images_json';el('#vlm-add-dataset').onclick();assert(el('#vlm-selected-datasets').children.length===1,'VLM duplicate folders prevented');await el('#vlm-generate-annotations').onclick();
  await el('#vlm-verify').listeners.click();
  let vlmRequest=JSON.parse(requests.filter(r=>r.url.endsWith('/vlm/preview')).at(-1).options.body);
  assert(vlmRequest.epochs===1&&vlmRequest.lora_rank===8&&!('learning_rate' in vlmRequest)&&vlmRequest.gpu==='0,1','VLM blank values omitted, typed values and GPU selection preserved');
  assert(!el('#launch').disabled,'VLM final review enables start');
  fields.vlm_mode.value='full';form.listeners.input();
  assert(el('#launch').disabled&&fields.vlm_lora_rank.disabled,'mode change invalidates review and disables LoRA settings');
  await el('#vlm-verify').listeners.click();
  vlmRequest=JSON.parse(requests.filter(r=>r.url.endsWith('/vlm/preview')).at(-1).options.body);assert(!('lora_rank' in vlmRequest),'full request excludes LoRA');
  await form.onsubmit({preventDefault(){}});assert(active.params.type==='vlm'&&fields.vlm_epochs.disabled,'VLM launch uses shared job flow and locks settings');
  active.ui_settings=active.params.ui_settings;new Function('document','window','sessionStorage','fetch','AbortSignal','FormData','Option','setTimeout','clearTimeout',source)(document,window,sessionStorage,fetch,{timeout:()=>null},FormData,Option,()=>0,()=>{});await settle();assert(el('#vlm-selected-datasets').children.length===1&&fields.vlm_epochs.value==='1'&&fields.vlm_epochs.disabled,'VLM reopen restores source folders and training lock');
  await el('#stop').onclick();assert(!fields.vlm_epochs.disabled&&el('#stop').disabled,'VLM stop unlocks settings');
  el('#vlm-selected-datasets').onclick({target:{closest:()=>({dataset:{index:'0'}})}});assert(el('#launch').disabled&&el('#vlm-generated-files').hidden,'VLM removal invalidates generated data');
  return 'PASS: Detector and VLM launch/stop, settings restore, typed/blank inputs, GPU batch, final review, LoRA conditions and UI validation';
}
if(typeof require==='function'&&require.main===module){
  testTrainingUi(require('fs').readFileSync(process.argv[2],'utf8')).then(console.log).catch(err=>{console.error(err);process.exitCode=1;});
}
