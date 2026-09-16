(() => {
'use strict';
const form=document.querySelector('#train-form'), missing={textContent:'',hidden:false,disabled:false,setAttribute(){},removeAttribute(){},value:0}, $=s=>document.querySelector(s)||missing, fields=form.elements;
let model='detector',tab='yaml',ready=false,busy=false,jobTimer,checking=false,activeJobId=null;
const selectedDatasets=[], detectorFolders=[]; let detectorBrowsePath='', modalFolderPath='', modalFolderMode='detector';
const vlmFolders=[];let vlmDataset=null,preparingVlm=false;
let vlmCatalog=null,vlmPrepared=null,vlmFingerprint='',vlmPreviewGeneration=0;
const vlmKeys=['modality','mode','model','train_json','val_json','epochs','batch','gradient_accumulation','learning_rate','max_length','workers','name','lora_rank','lora_alpha','lora_dropout','lora_target_modules','gradient_checkpointing','video_fps','video_max_pixels','validation_ratio','validation_seed','max_samples','eval_steps','logging_steps','save_steps','save_total_limit'];
const vlmNumbers=new Set(['epochs','batch','gradient_accumulation','learning_rate','max_length','workers','lora_rank','lora_alpha','lora_dropout','video_fps','video_max_pixels','validation_ratio','validation_seed','max_samples','eval_steps','logging_steps','save_steps','save_total_limit']);
const vlmLabels={"modality": "학습 대상", "mode": "학습 방식", "model": "기본 모델", "train_json": "학습 JSON", "val_json": "검증 JSON", "epochs": "학습 횟수", "batch": "GPU당 배치", "gradient_accumulation": "그래디언트 누적 횟수", "learning_rate": "학습률", "max_length": "최대 시퀀스 길이", "workers": "데이터 로더 작업자", "gpu": "사용 GPU", "name": "작업 이름", "lora_rank": "LoRA Rank", "lora_alpha": "LoRA Alpha", "lora_dropout": "LoRA Dropout", "lora_target_modules": "LoRA 적용 모듈", "gradient_checkpointing": "그래디언트 체크포인팅", "video_fps": "영상 FPS", "video_max_pixels": "영상 최대 픽셀", "validation_ratio": "검증 분할 비율", "validation_seed": "검증 분할 시드", "max_samples": "최대 샘플 수", "eval_steps": "평가 주기", "logging_steps": "로그 주기", "save_steps": "저장 주기", "save_total_limit": "체크포인트 유지 개수", "eval_strategy":"평가 방식", "save_strategy":"체크포인트 저장 방식"};
let preparedDataset=null, preparingDataset=false;
const trees={};
const drafts={}, API='/training-api', DATASET_ROOT='/opt/clearml/data/datasets/detector', RUN_ROOT='/home/intellivix/train/Detector/runs/Detector/';
function payload(){
 if(model==='detector'){
  const v={type:'detector'};
  for(const [key,field] of Object.entries({data:'data',epochs:'detector_epochs',batch:'batch',gpu:'gpu',img_size:'img_size',weights:'detector_model_size',name:'name'})){
   const value=fields[field].value;
   if(value!=='')v[key]=['epochs','batch','img_size'].includes(key)?Number(value):value;
  }
  v.weights={small:'weights/yolo26n.pt',medium:'weights/yolo26l.pt',large:'weights/yolo26x.pt'}[v.weights]||'weights/yolo26n.pt';v.folders=[...detectorFolders];v.resume=fields.detector_resume.checked;
  return v;
 }
 const v={type:'vlm'};
 for(const key of vlmKeys){
  const field=fields['vlm_'+key];if(!field||field.disabled)continue;
  const value=field.value.trim();if(value==='')continue;
  v[key]=vlmNumbers.has(key)?Number(value):key==='gradient_checkpointing'?value==='true':value;
 }
 if(vlmDataset&&vlmDataset.signature===vlmDatasetSignature()){v.train_json=vlmDataset.train_json;v.val_json=vlmDataset.val_json;}
 const gpu=fields.vlm_gpu?.value.trim();
 if(gpu)v.gpu=gpu;
 return v;
}
function preview(){
 if(busy)return;
 const v=payload();
 if(model==='detector'){
  $('#config-preview').textContent=tab==='yaml'?(!detectorDatasetDirty()&&preparedDataset?.yaml||'폴더와 클래스를 선택한 뒤 annotation을 생성하면 data.yaml을 확인할 수 있습니다.'):JSON.stringify(v,null,2);$('#model-tag').textContent='DETECTOR';
  const savedTree=drafts.detector?.dataset_tree;drafts.detector=Object.fromEntries(new FormData(form));if(savedTree)drafts.detector.dataset_tree=savedTree;drafts.detector.detector_resume=fields.detector_resume.checked;
  drafts.detector.dataset_folders=[...detectorFolders];drafts.detector.prepared_dataset=preparedDataset;
  syncDetectorDataset();
  try{sessionStorage.setItem('ivx-training-drafts-v1',JSON.stringify(drafts));}catch(_){}
  return;
 }
 syncVlmSections();validateVlmFields();
 const current=payload();
 $('#config-preview').textContent=JSON.stringify(current,null,2);$('#model-tag').textContent='VLM';
 const savedTree=drafts.vlm?.dataset_tree;const savedGpu=drafts.vlm?.vlm_gpu;drafts.vlm={};if(savedTree)drafts.vlm.dataset_tree=savedTree;if(savedGpu!==undefined)drafts.vlm.vlm_gpu=savedGpu;vlmKeys.forEach(key=>{const field=fields['vlm_'+key];if(field)drafts.vlm['vlm_'+key]=field.value;});
 if(vlmCatalog)drafts.vlm.vlm_gpu=current.gpu||'';
 drafts.vlm.dataset_folders=[...vlmFolders];drafts.vlm.prepared_dataset=vlmDataset;renderVlmFolders();
 if(JSON.stringify(current)!==vlmFingerprint){vlmPrepared=null;$('#vlm-preview-status').textContent='설정 확인 후 학습을 시작하세요.';$('#vlm-effective').replaceChildren();}
 $('#launch').disabled=busy;
 updateVlmBatch();
 try{sessionStorage.setItem('ivx-training-drafts-v1',JSON.stringify(drafts));}catch(_){}
}
function choose(next){
 if(preparingDataset||preparingVlm||busy)return;
 model=next;form.reset();
 $('#detector-settings').hidden=next!=='detector';$('#vlm-settings').hidden=next==='detector';
 for(const [selector,disabled] of [['#detector-settings',next!=='detector'],['#vlm-settings',next==='detector']])
  document.querySelectorAll(selector+' input, '+selector+' select, '+selector+' textarea').forEach(el=>el.disabled=disabled);
 $('#yaml-tab').hidden=next==='vlm';$('#preview').hidden=next==='vlm';
 document.querySelectorAll('.steps a').forEach(a=>{const target=a.getAttribute('href')?.replace('#vlm-','#');if(['#dataset','#parameters','#advanced'].includes(target))a.setAttribute('href',next==='vlm'?'#vlm-'+target.slice(1):target);});
 $('#launch').disabled=busy;
 if(fields.output_name)fields.output_name.required=false;
 if(drafts[next])Object.entries(drafts[next]).forEach(([k,v])=>{if(fields[k]){if(fields[k].type==='checkbox')fields[k].checked=Boolean(v);else fields[k].value=v;}});
 document.querySelectorAll('[data-model]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.model===next)));if(next==='vlm'){populateVlmChoices();if(!vlmCatalog)loadVlmResources();}trees[next]?.render();preview();
}
try{
 Object.assign(drafts,JSON.parse(sessionStorage.getItem('ivx-training-drafts-v1')||'{}'));
 if(Array.isArray(drafts.detector?.dataset_folders))detectorFolders.push(...drafts.detector.dataset_folders.filter(x=>typeof x==='string'));
 const saved=drafts.detector?.prepared_dataset;
 if(saved&&typeof saved.data==='string'&&typeof saved.yaml==='string'&&typeof saved.signature==='string')preparedDataset=saved;
 if(Array.isArray(drafts.vlm?.dataset_folders))vlmFolders.push(...drafts.vlm.dataset_folders);
 vlmDataset=drafts.vlm?.prepared_dataset||null;
}catch(_){}
document.querySelectorAll('[data-model]').forEach(b=>b.onclick=()=>choose(b.dataset.model));form.addEventListener('input',preview);

function setTrainingLock(locked){
 document.querySelectorAll('#train-form input, #train-form select, #train-form textarea, #train-form button').forEach(el=>{
  el.disabled=locked||checking||preparingVlm||preparingDataset||el.closest('#vlm-settings')!==null&&model==='detector'||el.closest('#detector-settings')!==null&&model!=='detector';
 });
 $('#stop').disabled=(!locked&&!clearmlSyncPending)||stopping; $('#running-link').hidden=!locked;
 Object.values(trees).forEach(tree=>tree.setDisabled());
 if(!locked){if(model==='vlm'){syncVlmSections();$('#launch').disabled=false;}else syncDetectorDataset();}
}
let stopping=false,statusGeneration=0,clearmlSyncPending=null;
async function stopTraining(){
 if((!busy&&!clearmlSyncPending)||stopping)return;
 stopping=true;statusGeneration++;clearTimeout(jobTimer);$('#stop').disabled=true;$('#stop').textContent='■ 학습 종료 중…';$('#job-state').textContent='종료 중';$('#logs').textContent+='\n[backend] 원격 학습 종료 중입니다. 최대 30초 정도 걸릴 수 있습니다.';
 try{
  const stopJobId=activeJobId||clearmlSyncPending;
  const result=await request(stopJobId?'/jobs/'+encodeURIComponent(stopJobId)+'/stop':model==='vlm'?'/stop/vlm':'/stop',{method:'POST'});
  clearmlSyncPending=null;
  $('#logs').textContent+='\n'+(result.logs||'[backend] 학습 종료 요청을 보냈습니다.');
  await restoreActiveJob(true);
 }catch(e){if(e.data?.clearml_sync_failed)clearmlSyncPending=activeJobId||clearmlSyncPending;$('#logs').textContent+='\n[backend] 종료 실패: '+e.message;}
 finally{stopping=false;$('#stop').textContent=clearmlSyncPending?'ClearML 종료 상태 갱신 재시도':'■ 학습 종료';$('#stop').disabled=!busy&&!clearmlSyncPending;clearTimeout(jobTimer);jobTimer=setTimeout(restoreActiveJob,5000);}
}
$('#stop').onclick=stopTraining;
function restoreJobSettings(j){
 const params=j.params||{};
 if(params.type==='vlm'){
  if(j.ui_settings){drafts.vlm=j.ui_settings;trees.vlm?.restore(j.ui_settings.dataset_tree);vlmFolders.splice(0,vlmFolders.length,...(j.ui_settings.dataset_folders||[]));vlmDataset=j.ui_settings.prepared_dataset||null;}
  if(model!=='vlm'){busy=false;choose('vlm');}
  vlmKeys.forEach(key=>{if(fields['vlm_'+key]&&params[key]!==undefined)fields['vlm_'+key].value=String(params[key]);});
  if(params.gpu){if(fields.vlm_gpu)fields.vlm_gpu.value=params.gpu;drafts.vlm={...drafts.vlm,vlm_gpu:params.gpu};}populateVlmChoices();
  $('#vlm-effective').textContent=JSON.stringify(j.effective||params,null,2);return;
 }
 if(model!=='detector'){busy=false;choose('detector');}
 for(const [key,name] of Object.entries({data:'data',epochs:'detector_epochs',batch:'batch',gpu:'gpu',img_size:'img_size',name:'name'}))if(params[key]!==undefined)fields[name].value=params[key];
 if(params.resume!==undefined)fields.detector_resume.checked=params.resume;
 const size=Object.entries({small:'weights/yolo26n.pt',medium:'weights/yolo26l.pt',large:'weights/yolo26x.pt'}).find(([,v])=>v===params.weights);
 if(size)fields.detector_model_size.value=size[0];
 if(Array.isArray(params.folders))detectorFolders.splice(0,detectorFolders.length,...params.folders);
 if(j.ui_settings){drafts.detector=j.ui_settings;trees.detector?.restore(j.ui_settings.dataset_tree);Object.entries(j.ui_settings).forEach(([k,v])=>{if(fields[k]){if(fields[k].type==='checkbox')fields[k].checked=Boolean(v);else fields[k].value=v;}});preparedDataset=j.ui_settings.prepared_dataset||preparedDataset;}
 renderDetectorFolders();
}
async function restoreActiveJob(force=false){
 if(stopping&&!force)return;
 const generation=++statusGeneration;clearTimeout(jobTimer);
 try{
  const savedId=sessionStorage.getItem('ivx-active-job-id'),r=await request('/jobs/active');
  const j=(r.jobs&&r.jobs[0])||(savedId?await request('/jobs/'+encodeURIComponent(savedId)).catch(()=>null):null);
  if(generation!==statusGeneration)return;
  busy=!!(r.remote_running||j&&['queued','running','stopping'].includes(j.status));
  activeJobId=busy&&j?j.id:null;
  if(busy&&j){restoreJobSettings(j);busy=true;sessionStorage.setItem('ivx-active-job-id',String(j.id));}
  if(!busy&&!j)sessionStorage.removeItem('ivx-active-job-id');
  const statusLabel={queued:'학습 준비 중',running:'학습 실행 중',stopping:'종료 중',completed:'학습 완료',failed:'학습 실패',stopped:'학습 종료'};$('#job-state').textContent=busy?(statusLabel[j?.status]||'학습 실행 중'):(statusLabel[j?.status]||'대기');
  if(j){$('#job-id').textContent=String(j.id);$('#logs').textContent=j.logs||'로그 대기 중';}
  else if(busy){if(r.remote_types?.[0]&&r.remote_types[0]!==model){busy=false;choose(r.remote_types[0]);busy=true;}$('#logs').textContent='학습 서버에서 '+model.toUpperCase()+' 학습이 실행 중입니다.';}
  if(j?.clearml_task_id){const link=$('#clearml-link');link.hidden=false;link.href=j.clearml_path||String(j.logs||'').match(/(\/projects\/[a-f0-9]{32}\/(?:tasks|experiments)\/[a-f0-9]{32}\/output\/log)/i)?.[1]||'/projects/*/tasks/'+encodeURIComponent(j.clearml_task_id)+'/output/log';}else{$('#clearml-link').hidden=true;}
  setTrainingLock(busy);
 }catch(e){if(generation===statusGeneration)$('#connection').textContent='학습 상태 확인 실패: '+e.message;}
 finally{if(generation===statusGeneration&&!stopping)jobTimer=setTimeout(restoreActiveJob,5000);}
}
function detectorClasses(){return fields.detector_classes.value.split(/[,\n]/).map(x=>x.trim()).filter(Boolean);}
function detectorSignature(){return JSON.stringify({folders:[...detectorFolders].sort(),classes:detectorClasses()});}
function detectorDatasetDirty(){return detectorFolders.length>0&&(!preparedDataset||preparedDataset.signature!==detectorSignature());}
function syncDetectorDataset(){
 const dirty=detectorDatasetDirty();
 if(model==="detector")$("#launch").disabled=busy||preparingDataset||dirty;
 fields.data.readOnly=detectorFolders.length>0;
 $('#detector-class-map').textContent=detectorClasses().map((name,id)=>id+': '+name).join(' · ');
 if(dirty&&!preparingDataset&&!$('#detector-annotation-status').textContent.startsWith('실패:'))$('#detector-annotation-status').textContent='선택한 폴더와 클래스를 적용하려면 annotation 생성 또는 클래스 적용을 눌러주세요.';
 $('#detector-generated-files').hidden=!preparedDataset||dirty;
 if(preparedDataset&&!dirty)$('#detector-generated-files').textContent=Object.values(preparedDataset.files||{}).join('\n');
}
function renderDetectorFolders(){
 const box=$('#detector-selected-datasets');box.replaceChildren();
 detectorFolders.forEach((path,index)=>{
  const chip=document.createElement('span'),label=document.createElement('span'),button=document.createElement('button');
  chip.className='dataset-chip';label.textContent=path;button.type='button';button.dataset.index=index;button.textContent='×';button.setAttribute('aria-label',path+' 제거');
  chip.append(label,button);box.appendChild(chip);
 });
}
async function loadDetectorFolders(refresh=true){
 if(trees.detector){if(!fields.detector_classes.value){const defaults=await request('/detector/datasets');if(Array.isArray(defaults.classes))fields.detector_classes.value=defaults.classes.join('\n');}await trees.detector.load(Boolean(refresh));return;}
 const button=$('#detector-refresh-datasets');button.disabled=true;
 detectorFolders.splice(0,detectorFolders.length);preparedDataset=null;fields.data.value='';if(drafts.detector){drafts.detector.dataset_folders=[];drafts.detector.prepared_dataset=null;}
  renderDetectorFolders();
 try{
  const data=await request('/detector/datasets'+(detectorBrowsePath?'?path='+encodeURIComponent(detectorBrowsePath):'')),select=$('#detector-folder-select');
  select.replaceChildren(new Option('폴더를 선택하세요',''));
  data.items.forEach(path=>{const name=path.split('/').pop();select.add(new Option('📁 '+name,path));});
  $('#detector-current-folder').textContent=detectorBrowsePath||'루트 폴더';
  $('#detector-up-folder').disabled=!detectorBrowsePath;
  if(!fields.detector_classes.value&&Array.isArray(data.classes))fields.detector_classes.value=data.classes.join('\n');
  preview();
 }catch(err){$('#detector-annotation-status').textContent='폴더 조회 실패: '+err.message;}
 finally{button.disabled=busy;}
}
async function loadFolderModal(path,mode=modalFolderMode){
 modalFolderMode=mode;modalFolderPath=path;const modal=$('#folder-modal'),list=$('#folder-modal-list');modal.hidden=false;list.textContent='하위 폴더를 불러오는 중…';
 $('#folder-modal-title').textContent=mode==='vlm'?'VLM 하위 폴더 선택':'Detector 하위 폴더 선택';$('#folder-modal-path').textContent=path||'루트 폴더';$('#folder-modal-up').disabled=!path;
 try{let items;if(mode==='vlm'){const all=vlmCatalog?.folders||[],prefix=path?path+'/':'';items=all.filter(x=>x.startsWith(prefix)&&!x.slice(prefix.length).includes('/'));}else{const data=await request('/detector/datasets'+(path?'?path='+encodeURIComponent(path):''));items=data.items;}
  list.replaceChildren();if(!items.length){list.innerHTML='<p class="folder-empty">이 폴더에는 하위 폴더가 없습니다.</p>';return;}
  items.forEach(child=>{const b=document.createElement('button');b.type='button';b.className='folder-modal-item';b.textContent='📁 '+child.split('/').pop();b.onclick=()=>loadFolderModal(child,mode);list.append(b);});
 }catch(err){list.textContent='하위 폴더를 불러오지 못했습니다: '+err.message;}
}
const enterDetectorFolder=()=>{const path=$('#detector-folder-select').value;if(path)loadFolderModal(path,'detector');};
const enterVlmFolder=()=>{const path=$('#vlm-folder-select').value;if(path)loadFolderModal(path,'vlm');};
$('#detector-enter-folder').onclick=enterDetectorFolder;
$('#vlm-enter-folder').onclick=enterVlmFolder;
async function selectAllDetectorFolders(){try{const data=await request('/detector/datasets');detectorFolders.splice(0,detectorFolders.length,...data.items);renderDetectorFolders();preview();}catch(err){alert('전체 폴더를 불러오지 못했습니다: '+err.message);}}
function selectAllVlmFolders(){const items=(vlmCatalog?.folders||[]).filter(path=>!path.includes('/'));vlmFolders.splice(0,vlmFolders.length,...items);renderVlmFolders();preview();}
$('#detector-select-all-folder').onclick=selectAllDetectorFolders;
$('#vlm-select-all-folder').onclick=selectAllVlmFolders;
$('#folder-modal-up').onclick=()=>loadFolderModal(modalFolderPath.split('/').slice(0,-1).join('/'));
['#folder-modal-close','#folder-modal-cancel'].forEach(id=>$(id).onclick=()=>$('#folder-modal').hidden=true);
$('#folder-modal-select').onclick=()=>{const target=modalFolderMode==='vlm'?vlmFolders:detectorFolders;if(modalFolderPath&&!target.includes(modalFolderPath)){target.push(modalFolderPath);if(modalFolderMode==='vlm')renderVlmFolders();else renderDetectorFolders();preview();}$('#folder-modal').hidden=true;};
$('#detector-add-dataset').onclick=()=>{
 if(preparingDataset||preparingVlm||busy)return;
 const select=$('#detector-folder-select'),path=select.value;
 if(!path)return; if(detectorFolders.includes(path)){select.focus();return;}
 detectorFolders.push(path);select.value='';renderDetectorFolders();preview();'선택됨: '+detectorFolders.length+'개 폴더';
};
$('#detector-selected-datasets').onclick=e=>{
 if(preparingDataset||preparingVlm||busy)return;
 const button=e.target.closest('button[data-index]');if(!button)return;
 detectorFolders.splice(Number(button.dataset.index),1);renderDetectorFolders();preview();
};
async function prepareDetectorDataset(){
 if(trees.detector){
  if(busy||preparingDataset||preparingVlm)return;preparingDataset=true;$('#launch').disabled=true;
  try{const result=await trees.detector.prepare();if(result){fields.data.value=result.data;preparedDataset={data:result.data,yaml:result.yaml,files:result.files,signature:detectorSignature()};$('#detector-annotation-status').textContent='✓ 학습 파일 생성 완료 · train '+result.train+' / valid '+result.valid+' / test '+result.test;}}
  catch(e){$('#detector-annotation-status').textContent='실패: '+e.message;}finally{preparingDataset=false;preview();setTrainingLock(busy);}return;
 }
 if(preparingDataset||busy||model!=='detector')return;
 if(!detectorFolders.length){$('#detector-annotation-status').textContent='학습할 폴더를 ＋로 추가하세요.';return;}
 const classes=detectorClasses();
 if(!classes.length||new Set(classes).size!==classes.length){$('#detector-annotation-status').textContent='중복 없이 클래스를 입력하세요.';return;}
 const signature=detectorSignature(),params={folders:[...detectorFolders],classes};
 preparingDataset=true;syncDetectorDataset();
 const controls=[...document.querySelectorAll('#dataset input, #dataset textarea, #dataset select, #dataset button, [data-model]')];
 controls.forEach(el=>el.disabled=true);
 $('#detector-annotation-status').textContent='선택 데이터 검증 및 annotation·data.yaml 생성 중…';
 try{
  const result=await request('/detector/annotations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)});
  if(!result.data||!result.yaml||!result.files)throw Error('생성 결과가 올바르지 않습니다.');
  if(signature!==detectorSignature())throw Error('설정이 변경되었습니다. 다시 적용하세요.');
  fields.data.value=result.data;preparedDataset={data:result.data,yaml:result.yaml,files:result.files,signature};
  $('#detector-annotation-status').textContent='✓ data.yaml 반영 완료 · 학습 '+result.train+'개 / 검증·테스트 '+result.test+'개'+(result.missing_labels?' · 라벨 없는 이미지 '+result.missing_labels+'개는 배경으로 사용':'');
 }catch(err){$('#detector-annotation-status').textContent='실패: '+err.message;}
 finally{preparingDataset=false;controls.forEach(el=>el.disabled=false);preview();}
}
$('#detector-generate-annotations').onclick=prepareDetectorDataset;
$('#detector-apply-classes').onclick=prepareDetectorDataset;
$('#detector-refresh-datasets').onclick=loadDetectorFolders;

function vlmDatasetSignature(){return JSON.stringify({folders:[...vlmFolders].sort(),modality:fields.vlm_modality.value});}
function renderVlmFolders(){
 const box=$('#vlm-selected-datasets');box.replaceChildren();
 vlmFolders.forEach((path,index)=>{const chip=document.createElement('span'),label=document.createElement('span'),button=document.createElement('button');chip.className='dataset-chip';label.textContent=path;button.type='button';button.dataset.index=index;button.textContent='×';button.disabled=busy||preparingVlm;button.setAttribute('aria-label',path+' 제거');chip.append(label,button);box.appendChild(chip);});
 const valid=vlmDataset&&vlmDataset.signature===vlmDatasetSignature();$('#vlm-generated-files').hidden=!valid;
 if(valid){$('#vlm-generated-files').textContent=vlmDataset.train_json+'\n'+vlmDataset.val_json;$('#vlm-annotation-status').textContent='✓ 생성 완료 · 학습 '+vlmDataset.train+'개 / 검증 '+vlmDataset.valid+'개';}
 else if(!preparingVlm)$('#vlm-annotation-status').textContent='폴더와 학습 대상을 선택한 뒤 JSON을 생성하세요.';
}
$('#vlm-add-dataset').onclick=()=>{if(busy||preparingVlm)return;const select=$('#vlm-folder-select');if(select.value&&!vlmFolders.includes(select.value))vlmFolders.push(select.value);select.value='';preview();};
$('#vlm-selected-datasets').onclick=e=>{if(busy||preparingVlm)return;const button=e.target.closest('button[data-index]');if(button){vlmFolders.splice(Number(button.dataset.index),1);preview();}};
$('#vlm-generate-annotations').onclick=async()=>{
 if(trees.vlm){if(busy||preparingVlm||preparingDataset)return;preparingVlm=true;
  try{const result=await trees.vlm.prepare();if(result){vlmDataset={train_json:result.train_json,val_json:result.val_json,train:result.train,valid:result.valid,files:result.files,signature:vlmDatasetSignature()};vlmPrepared=null;preview();}}catch(e){$('#vlm-annotation-status').textContent='생성 실패: '+e.message;}finally{preparingVlm=false;setTrainingLock(busy);}return;
 }
 if(busy||preparingVlm||model!=='vlm')return;
 if(!vlmFolders.length){$('#vlm-annotation-status').textContent='학습할 폴더를 ＋로 추가하세요.';return;}
 const signature=vlmDatasetSignature();preparingVlm=true;vlmPrepared=null;setTrainingLock(true);$('#stop').disabled=true;$('#running-link').hidden=true;
 $('#vlm-annotation-status').textContent='라벨 검증 및 9:1 무작위 분할 중…';let error='';
 try{const result=await request('/vlm/annotations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folders:[...vlmFolders],modality:fields.vlm_modality.value})});if(!result.train_json||!result.val_json)throw Error('JSON 생성 결과가 올바르지 않습니다.');if(signature!==vlmDatasetSignature())throw Error('설정이 변경되었습니다. 다시 생성하세요.');vlmDataset={...result,signature};}
 catch(e){error='생성 실패: '+e.message;}
 finally{preparingVlm=false;setTrainingLock(busy);preview();if(error)$('#vlm-annotation-status').textContent=error;}
};

function syncVlmSections(){
 if(!fields.vlm_mode)return;
 for(const [id,hidden] of [['#vlm-lora',fields.vlm_mode.value!=='lora'],['#vlm-video',fields.vlm_modality.value==='image']]){
  $(id).hidden=hidden;document.querySelectorAll(id+' input, '+id+' select').forEach(el=>el.disabled=busy||model!=='vlm'||hidden);
 }
}
function validateVlmFields(){
 const integers=new Set(['epochs','batch','gradient_accumulation','max_length','workers','lora_rank','lora_alpha','video_max_pixels','validation_seed','max_samples','eval_steps','logging_steps','save_steps','save_total_limit']);
 for(const key of vlmNumbers){
  const field=fields['vlm_'+key];if(!field)continue;
  let message='';const raw=field.value.trim(),value=Number(raw);
  if(!field.disabled&&raw!==''){
   if(!Number.isFinite(value)||integers.has(key)&&!Number.isInteger(value))message='유효한 '+(integers.has(key)?'정수':'숫자')+'를 입력하세요.';
   else if(key==='validation_ratio'&&!(value>0&&value<1))message='0 초과 1 미만을 입력하세요.';
   else if(key==='lora_dropout'&&!(value>=0&&value<1))message='0 이상 1 미만을 입력하세요.';
   else if(['learning_rate','video_fps'].includes(key)&&value<=0)message='0보다 큰 값을 입력하세요.';
   else if(['workers','validation_seed','save_steps'].includes(key)&&value<0)message='0 이상을 입력하세요.';
   else if(integers.has(key)&&!['workers','validation_seed','save_steps','eval_steps'].includes(key)&&value<1)message='1 이상을 입력하세요.';
  }
  field.setCustomValidity?.(message);
 }
}
function populateVlmChoices(reset=false){
 if(!vlmCatalog||!fields.vlm_modality)return;
 const modality=fields.vlm_modality.value;
 const select=$('#vlm-folder-select');select.replaceChildren(new Option('폴더를 선택하세요',''));(vlmCatalog.folders||[]).filter(path=>!path.includes('/')).forEach(path=>select.add(new Option('📁 '+path,path)));renderVlmFolders();
 if(fields.vlm_gpu&&!fields.vlm_gpu.value)fields.vlm_gpu.value=drafts.vlm?.vlm_gpu||vlmCatalog.defaults.DEVICE||'0';

}
function updateVlmBatch(){
 if(!vlmCatalog||!fields.vlm_batch)return;
 const batch=Number(fields.vlm_batch.value||vlmCatalog.defaults.BATCH_SIZE||1),accum=Number(fields.vlm_gradient_accumulation.value||vlmCatalog.defaults.GRAD_ACCUM||8),count=(fields.vlm_gpu?.value||'').split(',').filter(Boolean).length;
 $('#vlm-effective-batch').textContent='유효 배치 크기: '+batch+' × GPU '+count+'개 × 누적 '+accum+' = '+(batch*count*accum);
}
async function loadVlmResources(){
 const button=$('#vlm-refresh'),hadDraft=!!drafts.vlm;button.disabled=true;
 if(!trees.vlm)vlmFolders.splice(0,vlmFolders.length);if(!trees.vlm)vlmDataset=null;if(!trees.vlm&&drafts.vlm){drafts.vlm.dataset_folders=[];drafts.vlm.prepared_dataset=null;}renderVlmFolders();
 try{
  vlmCatalog=await request('/vlm/resources');
  if(!hadDraft){fields.vlm_modality.value=vlmCatalog.defaults.TRAIN_MODALITY||'both';fields.vlm_mode.value=vlmCatalog.defaults.TRAIN_MODE||'lora';}
  const mapping={epochs:'EPOCHS',batch:'BATCH_SIZE',gradient_accumulation:'GRAD_ACCUM',learning_rate:'LEARNING_RATE',max_length:'MAX_SEQ_LENGTH',workers:'DATALOADER_NUM_WORKERS',lora_rank:'LORA_R',lora_alpha:'LORA_ALPHA',lora_dropout:'LORA_DROPOUT',video_fps:'VIDEO_FPS',video_max_pixels:'VIDEO_MAX_PIXELS',validation_ratio:'VALID_RATIO',validation_seed:'VALID_SPLIT_SEED',eval_steps:'EVAL_STEPS',logging_steps:'LOGGING_STEPS',save_steps:'SAVE_STEPS',save_total_limit:'SAVE_TOTAL_LIMIT'};
  Object.entries(mapping).forEach(([key,env])=>{if(fields['vlm_'+key])fields['vlm_'+key].placeholder=vlmCatalog.defaults[env]||'서버 설정 / 자동';});
  populateVlmChoices();$('#vlm-resource-status').textContent='서버 데이터 폴더·GPU 목록 연결됨';
  vlmPrepared=null;if(model==='vlm')preview();setTrainingLock(busy);
 }catch(e){$('#vlm-resource-status').textContent='서버 목록 조회 실패: '+e.message;}
 finally{button.disabled=busy||model!=='vlm';if(trees.vlm&&!trees.vlm.catalog)await trees.vlm.load();}
}
async function verifyVlm(){
 if(busy||preparingVlm||model!=='vlm')return;if(!vlmDataset||vlmDataset.signature!==vlmDatasetSignature()){$('#vlm-preview-status').textContent='폴더를 선택하고 train.json · valid.json을 생성하세요.';return;}validateVlmFields();if(!form.reportValidity())return;
 const button=$('#vlm-verify'),generation=++vlmPreviewGeneration;button.disabled=true;$('#launch').disabled=true;
 const params=payload(),fingerprint=JSON.stringify(params);$('#vlm-preview-status').textContent='서버 설정 및 데이터 접근 확인 중…';
 try{
  const result=await request('/vlm/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)});
  if(generation!==vlmPreviewGeneration||model!=='vlm'||JSON.stringify(payload())!==fingerprint)return;
  vlmPrepared=result;vlmFingerprint=fingerprint;
  const box=$('#vlm-effective');box.replaceChildren();const table=document.createElement('table');table.className='effective-table';
  const header=document.createElement('tr');['설정','최종 적용값','출처'].forEach(text=>{const th=document.createElement('th');th.textContent=text;header.appendChild(th);});table.appendChild(header);
  Object.entries(result.effective).filter(([key])=>!['model','validation_ratio','validation_seed'].includes(key)).forEach(([key,value])=>{const row=document.createElement('tr');[vlmLabels[key]||key,value===null?(key==='train_json'||key==='val_json'?(result.automatic[key].join(', ')||(key==='val_json'?'자동 분할':'탐색 결과 없음')):'자동 / 제한 없음'):String(value),result.sources[key]].forEach(text=>{const cell=document.createElement('td');cell.textContent=text;row.appendChild(cell);});table.appendChild(row);});box.appendChild(table);
  result.warnings.forEach(text=>{const p=document.createElement('p');p.className='hint';p.textContent=text;box.appendChild(p);});
  $('#config-preview').textContent=JSON.stringify({request:result.params,command:result.command},null,2);
  $('#vlm-preview-status').textContent='✓ 설정 확인 완료 · 유효 배치 '+result.effective_batch+' · 학습 시작 가능';$('#launch').disabled=false;
 }catch(e){vlmPrepared=null;$('#vlm-preview-status').textContent='설정 확인 실패: '+e.message;$('#launch').disabled=false;}
 finally{button.disabled=busy;}
}
function toggleVlmFinalSettings(){const section=$('#vlm-final-settings'),body=[...section.children].slice(1),collapsed=section.dataset.collapsed==='true';section.dataset.collapsed=String(!collapsed);body.forEach(el=>el.hidden=!collapsed);$('#vlm-verify').setAttribute('aria-expanded',String(collapsed));}
const verifyVlmOriginal=verifyVlm; verifyVlm=async()=>{const section=$('#vlm-final-settings');if(vlmPrepared){toggleVlmFinalSettings();return;}await verifyVlmOriginal();};
$('#vlm-verify').onclick=()=>verifyVlm();
function selectTab(t){tab=t;$('#yaml-tab').setAttribute('aria-selected',String(t==='yaml'));$('#request-tab').setAttribute('aria-selected',String(t==='request'));preview();}
$('#yaml-tab').onclick=()=>selectTab('yaml');$('#request-tab').onclick=()=>selectTab('request');
$('#download').onclick=()=>{if(!form.reportValidity())return;const url=URL.createObjectURL(new Blob([JSON.stringify(payload(),null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='training-'+model+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
async function request(path,options={}){
 const r=await fetch(API+path,{credentials:'same-origin',...options,signal:AbortSignal.timeout(180000)});
 if(!r.headers.get('content-type')?.includes('application/json'))throw Error(r.status===413?'선택한 Dataset 요청이 너무 큽니다. 서버 요청 크기 설정을 확인하세요.':'학습 실행 API가 JSON 응답을 반환하지 않았습니다. HTTP '+r.status);
 const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error||data.detail||'서버 요청 실패'),{data});return data;
}
async function connect(){try{const c=await request('/capabilities');ready=c.launch===true;$('#connection').textContent=ready?'● 실행 API 연결됨':'설정 작성 가능 · 실행 API 연결 대기';}catch(e){ready=false;$('#connection').textContent='설정 작성·저장 가능 · 실행 API 미연결';}}
form.onsubmit=async e=>{
 e.preventDefault();if(busy||checking||preparingDataset||preparingVlm)return;
 if(!form.reportValidity())return;
 if(model==='vlm'&&(!vlmPrepared||JSON.stringify(payload())!==vlmFingerprint)){$('#job-state').textContent='설정 확인 중';await verifyVlm();if(!vlmPrepared||JSON.stringify(payload())!==vlmFingerprint){$('#job-state').textContent='설정 확인 필요';return;}}
 if(model==='detector'&&detectorDatasetDirty()){alert('데이터셋 또는 클래스 설정이 변경되었습니다. annotation 자동 생성 또는 data.yaml 저장을 다시 실행하세요.');syncDetectorDataset();return;}
 if(!ready){checking=true;await connect();checking=false;if(!ready){$('#job-state').textContent='연결 필요';$('#logs').textContent='실행 API가 연결되지 않아 학습을 시작하지 않았습니다. 설정 저장으로 요청 JSON을 내려받을 수 있습니다.';return;}}
 let datasetMetadata={};
 if(trees[model]&&(trees[model].state.selected_files.length||trees[model].state.new_version)){checking=true;setTrainingLock(true);$('#job-state').textContent='Dataset 확인 중';try{datasetMetadata=await trees[model].beforeLaunch();}catch(e){$('#job-state').textContent='Dataset 연결 실패';$('#logs').textContent=e.message;return;}finally{checking=false;setTrainingLock(busy);}}
 const launchParams={...(model==='vlm'?vlmPrepared.params:payload()),...datasetMetadata,ui_settings:{...drafts[model]}};busy=true;setTrainingLock(true);$('#job-state').textContent='요청 중';
 try{
  const job=await request('/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(launchParams)});if(!job.id)throw Error('서버가 작업 ID를 반환하지 않았습니다.');
  activeJobId=job.id;sessionStorage.setItem('ivx-active-job-id',String(job.id));setTrainingLock(true);$('#job-id').textContent=String(job.id);$('#logs').textContent='학습 요청이 접수되었습니다.';
  await restoreActiveJob();
 }catch(err){$('#job-state').textContent='요청 실패';$('#logs').textContent=err.message;busy=false;setTrainingLock(false);}
};
document.querySelector('.close').onclick=e=>{if(window.parent!==window){e.preventDefault();window.parent.postMessage({type:'ivx-close-train'},location.origin);}};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&window.parent!==window){e.preventDefault();window.parent.postMessage({type:'ivx-close-train'},location.origin);}});
document.querySelector('#vlm-refresh')?.addEventListener('click',loadVlmResources);
fields.vlm_modality?.addEventListener('change',()=>{if(trees.vlm){trees.vlm.invalidate();trees.vlm.load(true);}populateVlmChoices(true);preview();});
fields.vlm_mode?.addEventListener('change',preview);
if(window.DatasetTrees){
 for(const kind of ['detector','vlm']){
  trees[kind]=window.DatasetTrees.create(kind,{
   saved:()=>drafts[kind]?.dataset_tree||{},folders:()=>kind==='detector'?detectorFolders:vlmFolders,
   locked:()=>busy||checking||model!==kind,modality:()=>kind==='vlm'?fields.vlm_modality.value:'both',classes:detectorClasses,request,
   invalidate:()=>{if(kind==='detector')preparedDataset=null;else{vlmDataset=null;vlmPrepared=null;}trees[kind]?.invalidate();$('#launch').disabled=busy;},
   save:state=>{drafts[kind]={...drafts[kind],dataset_tree:state};const target=kind==='detector'?detectorFolders:vlmFolders;target.splice(0,target.length,...state.selected_folders);if(!busy&&kind===model)preview();try{sessionStorage.setItem('ivx-training-drafts-v1',JSON.stringify(drafts));}catch(_){}},
  });
 }
}
window.addEventListener('pagehide',()=>clearTimeout(jobTimer));choose(model);renderDetectorFolders();busy=true;setTrainingLock(true);connect();(async()=>{await restoreActiveJob();await loadDetectorFolders(false);setTrainingLock(busy);})();
})();
