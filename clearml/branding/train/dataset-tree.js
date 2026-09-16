(() => {
'use strict';
const contains=(path,folder)=>folder==='.'||path===folder||path.startsWith(folder+'/');
class DatasetTree {
 constructor(kind,adapter){
  this.kind=kind;this.adapter=adapter;this.root=document.querySelector('#'+kind+'-dataset-tree');this.state={selected_files:[],selected_folders:[],source_node:null,source_id:null,new_version:false,version_group:'',branch:'',update_mode:'append',version_name:'',branch_name:'',...adapter.saved()};this.catalog=null;this.prepared=null;this.loading=false;this.generation=0;this.expanded=new Set(this.state.expanded||['.']);
  this.$=name=>document.querySelector('#'+kind+'-tree-'+name);
  this.$('refresh').onclick=()=>this.load(true);this.$('version').onchange=()=>this.selectVersionGroup(this.$('version').value);this.$('dataset').onchange=()=>this.selectVersionGroup(this.$('dataset').value?'':'');
  this.$('new-version').onchange=()=>{this.state.new_version=this.$('new-version').checked;this.invalidate();this.syncBranchControls();this.save();};
  this.$('branch').onchange=()=>{const id=this.$('branch').value;if(id)this.loadVersion(id);else this.save();};
  this.$('update-append').onchange=()=>{if(this.$('update-append').checked)this.state.update_mode='append';this.invalidate();this.syncBranchControls();this.save();};
  this.$('update-root').onchange=()=>{if(this.$('update-root').checked)this.state.update_mode='root';this.invalidate();this.syncBranchControls();this.save();};
  this.$('version-name').oninput=()=>{this.state.version_name=this.$('version-name').value;this.save();};
  this.$('branch-name').oninput=()=>{this.state.branch_name=this.$('branch-name').value;this.save();};
  this.$('all').onchange=()=>this.toggle('.',this.$('all').checked);
  this.root.onchange=e=>{const path=e.target.dataset.folder;if(path!==undefined)this.toggle(path,e.target.checked);};
  this.root.onclick=e=>{const button=e.target.closest('button[data-toggle]');if(!button)return;const path=button.dataset.toggle;this.expanded.has(path)?this.expanded.delete(path):this.expanded.add(path);this.render();this.save();};
  this.$('files').onchange=e=>{const path=e.target.dataset.file;if(path===undefined)return;const set=new Set(this.state.selected_files);e.target.checked?set.add(path):set.delete(path);this.state.selected_files=[...set];this.changed();};
 }
 versionGroup(v){if(v?.branch)return v.branch;const m=String(v?.version||'').match(/^(?:v)?(\d+)/i);return m?'v'+m[1]:(v?.version||'기타');}
 versionLabel(v){const value=String(v?.version||'');return /^v/i.test(value)?value:'v'+value;}
 groupVersions(){return (this.versions||[]).filter(v=>this.versionGroup(v)===this.state.version_group);}
 directMode(){return !this.state.version_group;}
 syncBranchControls(){const locked=this.locked(),disabled=locked||this.directMode()||!this.state.new_version,rootMode=this.state.update_mode==='root',versionInput=this.$('version-name');this.$('update-append').disabled=disabled;this.$('update-root').disabled=disabled;versionInput.disabled=disabled||!rootMode;versionInput.readOnly=!rootMode;versionInput.value=rootMode?(this.state.version_name||''):((this.state.version_group||'').replace(/^v/i,'v'));versionInput.required=!!(!disabled&&rootMode);this.$('branch-name').disabled=disabled;this.$('branch-name').required=!disabled;}
 locked(){return this.loading||this.adapter.locked();}
 save(){this.state.expanded=[...this.expanded];this.adapter.save(this.state);}
 async api(path,q){return this.adapter.request(path,q===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(q)});}
 records(folder){return (this.catalog?.records||[]).filter(r=>contains(r.path,folder)||[r.label,...(r.labels||[])].some(path=>contains(path,folder)));}
 toggle(folder,checked){
  if(this.locked())return;const set=new Set(this.state.selected_files);this.records(folder).forEach(r=>checked?set.add(r.path):set.delete(r.path));this.state.selected_files=[...set];this.changed();
 }
 foldersForSelection(){
  const selected=new Set(this.state.selected_files),folders=[];
  for(const folder of this.catalog?.folders||[]){const records=this.records(folder);if(records.length&&records.every(r=>selected.has(r.path))&&!folders.some(p=>contains(folder,p)))folders.push(folder);}
  // Partly selected folders still need explicit media-parent provenance.
  this.state.selected_files.forEach(path=>{if(!folders.some(f=>contains(path,f))){const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.';if(!folders.includes(parent))folders.push(parent);}});
  return folders;
 }
 changed(){
  this.generation++;clearTimeout(this.timer);
  this.prepared=null;delete this.state.prepared;this.state.selected_folders=this.foldersForSelection();this.adapter.invalidate();this.render();this.save();this.scheduleSelection();
 }
 query(){const source_id=this.state.new_version&&this.state.update_mode==='root'?null:this.state.source_id;return {dataset_type:this.kind,selected_folders:this.state.selected_folders,selected_files:this.state.selected_files,source_id,modality:this.adapter.modality(),...(this.kind==='detector'?{classes:this.adapter.classes()}: {})};}
 nextNodeVersion(){const selected=this.versions?.find(v=>v.id===this.state.source_id),raw=String(selected?.version||'0.0.0').replace(/^v/i,''),parts=raw.split('.').map(Number);while(parts.length<3)parts.push(0);const used=new Set((this.versions||[]).map(v=>String(v.version).replace(/^v/i,'')));let candidate;do{parts[2]++;candidate=parts.join('.')}while(used.has(candidate));return candidate;}
 scheduleSelection(){clearTimeout(this.timer);this.timer=setTimeout(()=>this.resolveSelection(),250);}
 async resolveSelection(){
  if(!this.catalog)return;const generation=++this.generation;this.$('status').textContent='선택 파일과 분할 목록 확인 중…';
  try{const data=await this.api('/datasets/select',this.query());if(generation!==this.generation)return;Object.assign(this.state,{train_files:data.train_files,valid_files:data.valid_files,test_files:data.test_files});this.showCounts();this.showFiles();this.save();this.$('status').textContent=this.sourceDescription();}
  catch(e){if(generation===this.generation)this.$('status').textContent='선택 확인 실패: '+e.message;}
 }
 sourceDescription(){
  if(!this.state.source_node)return '폴더 선택으로 학습할 데이터를 구성합니다.';
  const base=new Set(this.state.base_files||[]),current=new Set(this.state.selected_files);const modified=base.size!==current.size||[...base].some(p=>!current.has(p));
  return 'Dataset '+this.state.source_node.dataset+' · 브랜치 '+(this.state.source_node.branch||this.state.branch||'v1')+' · 버전 '+this.state.source_node.version+(this.state.source_node.parent_version?' · 부모 '+this.state.source_node.parent_version:'')+(modified?' · 선택 변경됨':' · 버전 선택과 일치')+(this.state.missing_files?' · 로컬에서 없는 파일 '+this.state.missing_files+'개 제외':'');
 }
 async load(refresh=false){
  if(this.loading)return;this.loading=true;this.setDisabled();this.$('status').textContent='Tree 데이터 불러오는 중…';
  try{const catalog=await this.api('/datasets/tree?type='+this.kind+'&modality='+this.adapter.modality());this.catalog=catalog;const available=new Set(catalog.records.map(r=>r.path));
   if(!this.state.selected_files.length&&!this.state.source_id&&this.adapter.folders().length){this.state.selected_files=catalog.records.filter(r=>this.adapter.folders().some(f=>contains(r.path,f)||contains(r.label,f))).map(r=>r.path);}
   this.state.selected_files=this.state.selected_files.filter(p=>available.has(p));this.state.selected_folders=this.foldersForSelection();this.render();this.save();
   if(refresh){this.prepared=null;this.adapter.invalidate();}
   this.$('status').textContent='Dataset 노드 불러오는 중…';const result=await this.api('/datasets/nodes?type='+this.kind);this.versions=result.nodes[0]?.versions||[];
   const dataset=this.$('dataset');dataset.replaceChildren(new Option('폴더 선택만 사용',''));result.nodes.forEach(n=>dataset.add(new Option(n.dataset_name,n.id)));dataset.value=this.state.source_id?result.nodes[0]?.id||'':'';
   const groups=[...new Set(this.versions.filter(v=>['completed','published'].includes(v.status)).map(v=>this.versionGroup(v)))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
   const selectedNode=this.versions.find(v=>v.id===this.state.source_id);if(selectedNode)this.state.version_group=this.versionGroup(selectedNode);if(!groups.includes(this.state.version_group))this.state.version_group='';
   const select=this.$('version');select.replaceChildren(new Option('폴더로 직접 선택하기',''));groups.forEach(v=>select.add(new Option(v,v)));select.value=this.state.version_group;this.populateBranches();
   this.$('new-version').checked=!!this.state.new_version;this.$('update-append').checked=this.state.update_mode!=='root';this.$('update-root').checked=this.state.update_mode==='root';this.$('version-name').value=this.state.version_name||'';this.$('branch-name').value=this.state.branch_name||'';this.syncBranchControls();this.$('status').textContent=this.versions.length?this.sourceDescription():'등록된 Dataset 노드가 없습니다. 새 version 연결을 체크하면 첫 버전을 생성합니다.';
  }catch(e){this.$('status').textContent='데이터 불러오기 실패: '+e.message;}
  finally{this.loading=false;this.setDisabled();if(this.catalog)this.scheduleSelection();}
 }
 async selectVersionGroup(group){
  this.state.version_group=group;this.state.branch='';this.state.update_mode='append';this.state.version_name='';this.state.branch_name='';this.$('update-append').checked=true;this.$('update-root').checked=false;this.$('version-name').value='';this.$('branch-name').value='';
  if(!group){this.state.new_version=false;this.$('new-version').checked=false;this.populateBranches();await this.loadVersion('');return;}
  this.populateBranches();const id=this.$('branch').value;if(id)await this.loadVersion(id);this.save();this.setDisabled();
 }
 populateBranches(){
  const nodes=this.groupVersions().filter(v=>['completed','published'].includes(v.status)).sort((a,b)=>String(a.version).localeCompare(String(b.version),undefined,{numeric:true}));const branch=this.$('branch');branch.replaceChildren(new Option(this.directMode()?'폴더 직접 선택 시 사용 안 함':'브랜치를 선택하세요',''));
  nodes.forEach(v=>branch.add(new Option(this.versionLabel(v)+(v.status==='published'?' · published':''),v.id)));branch.value=nodes.some(v=>v.id===this.state.source_id)?this.state.source_id:(nodes.at(-1)?.id||'');
 }
 async loadVersion(id){
  this.generation++;clearTimeout(this.timer);
  if(this.loading)return;if(!id){this.state.source_id=null;this.state.source_node=null;this.state.base_files=[];this.changed();return;}
  this.loading=true;this.setDisabled();this.$('status').textContent='Dataset version 불러오는 중…';
  try{const manifest=await this.api('/datasets/version?type='+this.kind+'&id='+encodeURIComponent(id));const available=new Set(this.catalog.records.map(r=>r.path));const files=manifest.selected_files||[];this.state.source_id=id;this.state.source_node={...manifest.source_node,parent_version:manifest.parent_version,branch:manifest.source_node?.branch||'v1'};this.state.version_group=this.versionGroup(this.versions?.find(v=>v.id===id)||this.state.source_node);this.state.branch=this.state.source_node.branch;this.$('version').value=this.state.version_group;this.populateBranches();this.$('branch').value=id;this.state.base_files=files;this.state.missing_files=files.filter(p=>!available.has(p)).length;this.state.selected_files=files.filter(p=>available.has(p));this.state.train_files=(manifest.train||[]).filter(p=>available.has(p));this.state.valid_files=(manifest.valid||[]).filter(p=>available.has(p));this.state.test_files=(manifest.test||[]).filter(p=>available.has(p));this.state.selected_folders=this.foldersForSelection();this.prepared=null;this.adapter.invalidate();this.render();this.save();this.$('status').textContent=this.sourceDescription();}
  catch(e){this.$('status').textContent='Dataset version 불러오기 실패: '+e.message;this.$('version').value=this.state.version_group||'';}
  finally{this.loading=false;this.setDisabled();}
 }
 showCounts(){const selected=new Set(this.state.selected_files);const fileCount=new Set((this.catalog?.records||[]).filter(r=>selected.has(r.path)).flatMap(r=>[r.path,r.label])).size;this.$('counts').textContent='폴더 '+this.state.selected_folders.length+'개 · 데이터 '+this.state.selected_files.length+'개 · 파일 '+fileCount+'개 · train '+(this.state.train_files||[]).length+' / valid '+(this.state.valid_files||[]).length+' / test '+(this.state.test_files||[]).length;}
 render(){
  if(!this.catalog)return;const selected=new Set(this.state.selected_files),folders=this.catalog.folders;this.root.replaceChildren();
  const build=(folder,container,depth)=>{
   const rows=this.records(folder),count=rows.filter(r=>selected.has(r.path)).length;const line=document.createElement('div');line.className='tree-row';line.style.paddingLeft=(depth*18)+'px';const children=folders.filter(p=>p!==folder&&(p.includes('/')?p.slice(0,p.lastIndexOf('/')):'.')===folder);
   const toggle=document.createElement('button');toggle.type='button';toggle.dataset.toggle=folder;toggle.textContent=children.length?(this.expanded.has(folder)?'▾':'▸'):'·';toggle.setAttribute('aria-expanded',String(this.expanded.has(folder)));toggle.setAttribute('aria-label',(this.expanded.has(folder)?'접기 ':'펼치기 ')+folder);toggle.dataset.empty=String(!children.length);toggle.disabled=this.locked()||!children.length;
   const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.dataset.folder=folder;check.checked=rows.length>0&&count===rows.length;check.indeterminate=count>0&&count<rows.length;check.dataset.empty=String(!rows.length);check.disabled=this.locked()||!rows.length;label.append(check,document.createTextNode('📁 '+(folder==='.'?(this.kind==='vlm'?'VLM':'Detector'):folder.split('/').pop())+' ('+count+'/'+rows.length+')'));line.append(toggle,label);container.append(line);
   if(this.expanded.has(folder))children.forEach(child=>build(child,container,depth+1));
  };build('.',this.root,0);
  this.$('all').checked=this.catalog.records.length>0&&selected.size===this.catalog.records.length;this.$('all').indeterminate=selected.size>0&&selected.size<this.catalog.records.length;
  this.$('new-version').checked=!!this.state.new_version;this.$('update-append').checked=this.state.update_mode!=='root';this.$('update-root').checked=this.state.update_mode==='root';this.$('version-name').value=this.state.version_name||'';this.$('branch-name').value=this.state.branch_name||'';this.syncBranchControls();if(this.versions){this.$('dataset').value=this.state.source_id?(this.kind==='vlm'?'VLM':'Detector'):'';this.$('version').value=this.state.version_group||'';}this.$('folders').textContent=this.state.selected_folders.join('\n')||'선택한 폴더 없음';this.showFiles();this.showCounts();this.setDisabled();
 }
 showFiles(){
  const box=this.$('files');box.replaceChildren();const selected=new Set(this.state.selected_files),rows=this.catalog.records.filter(r=>selected.has(r.path));const splits={};['train','valid','test'].forEach(k=>(this.state[k+'_files']||[]).forEach(p=>splits[p]=k));
  rows.forEach(r=>{const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.dataset.file=r.path;check.checked=true;check.disabled=this.locked();label.append(check,document.createTextNode(r.path+' ↔ '+r.label+' · '+r.size+' B'+(splits[r.path]?' · '+splits[r.path]:'')));box.append(label);});
 }
 setDisabled(){[this.$('refresh'),this.$('dataset'),this.$('version'),this.$('all')].forEach(el=>el.disabled=this.locked());this.$('branch').disabled=this.locked()||this.directMode();this.$('new-version').disabled=this.locked()||this.directMode();this.root.querySelectorAll('input,button').forEach(el=>el.disabled=this.locked()||el.dataset.empty==='true');this.$('files').querySelectorAll('input').forEach(el=>el.disabled=this.locked());this.syncBranchControls();}
 async prepare(){
  this.generation++;clearTimeout(this.timer);
  if(this.loading||this.adapter.locked())return null;if(this.state.selected_files.length<2)throw Error('학습할 유효한 데이터를 최소 2개 선택하세요.');
  this.loading=true;this.setDisabled();const fingerprint=JSON.stringify(this.query());this.$('status').textContent='선택 데이터 검증 및 학습 파일 생성 중…';
  try{const result=await this.api('/datasets/prepare',this.query());if(fingerprint!==JSON.stringify(this.query()))throw Error('선택 설정이 변경되었습니다. 다시 생성하세요.');this.prepared=result;this.state.selected_files=result.manifest.selected_files;this.state.selected_folders=result.manifest.selected_folders;this.state.prepared={token:result.token,files:result.files,manifest:{bundle:result.manifest.bundle}};Object.assign(this.state,{train_files:result.manifest.train,valid_files:result.manifest.valid,test_files:result.manifest.test});this.showCounts();this.showFiles();this.save();this.$('status').textContent='학습 파일 생성 완료';return result;}
  catch(e){this.$('status').textContent='학습 파일 생성 실패: '+e.message;throw e;}
  finally{this.loading=false;this.setDisabled();}
 }
 async beforeLaunch(){
  const prepared=this.prepared||this.state.prepared;if(!prepared)throw Error('Tree 선택을 적용해 학습 파일을 생성하세요.');let source=this.state.source_node;
  if(this.state.new_version){const root=this.state.update_mode==='root';const name=this.state.version_name.trim(),branchName=this.state.branch_name.trim();if(root&&!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(name))throw Error('Dataset version 이름은 문자·숫자로 시작하고 점·밑줄·하이픈을 사용할 수 있습니다.');if(!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(branchName))throw Error('Dataset branch 이름은 문자·숫자·점·밑줄·하이픈으로 입력하세요.');this.loading=true;this.setDisabled();this.$('status').textContent=root?'새 Dataset version 생성 중…':'선택한 branch에 노드 추가 중…';
   try{const request={...this.query(),token:prepared.token,source_id:root?null:this.state.source_id,branch_name:root?name:this.state.version_group,new_branch:root,version:branchName.replace(/^v/i,'')};const result=await this.api('/datasets/connect',request);source=result.source_node;this.state.source_node=source;this.state.source_id=source.id;this.state.base_files=[...this.state.selected_files];this.state.new_version=false;this.state.update_mode='append';this.state.version_name='';this.state.branch_name='';this.state.branch=source.branch||this.state.branch;this.state.version_group=this.versionGroup(source);this.$('new-version').checked=false;this.$('update-append').checked=true;this.$('update-root').checked=false;this.$('version-name').value='';this.$('branch-name').value='';this.save();this.$('status').textContent=(root?'새 Dataset version ':'branch 노드 ')+source.version+' 생성 완료';}
   catch(e){this.$('status').textContent='새 Dataset version 생성 실패 · 학습을 시작하지 않았습니다: '+e.message;throw e;}
   finally{this.loading=false;this.setDisabled();}
  }
  return {dataset_project:'Dataset',dataset_name:this.kind==='vlm'?'VLM':'Detector',dataset_version:source?.version||'',dataset_branch:source?.branch||this.state.branch||'v1',dataset_parent_version:source?.parent_version||'',dataset_id:source?.id||'',dataset_manifest:prepared.manifest.bundle+'/manifest.json',dataset_token:prepared.token,dataset_modality:this.adapter.modality(),...(this.kind==='detector'?{train_list:prepared.files.train,valid_list:prepared.files.valid,test_list:prepared.files.test}:{valid_json:prepared.files.valid})};
 }
 restore(state){if(!state)return;this.state={...this.state,...state};this.prepared=state.prepared||null;this.render();}
 invalidate(){this.prepared=null;delete this.state.prepared;this.save();}
}
window.DatasetTrees={create:(kind,adapter)=>new DatasetTree(kind,adapter),contains};
})();
