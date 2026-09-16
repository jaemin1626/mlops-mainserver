(()=>{
'use strict';
const API='/training-api',ROOT_ID='ivx-dataset-branches';
let lastPath='',lastSelectedId='',busy=false,activeBranch='',activeGraph=null;
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n};
const currentId=()=>location.pathname.match(/\/datasets\/simple\/[^/]+\/tasks\/([a-f0-9]{32})/)?.[1];
const fmtSize=n=>{n=Number(n)||0;if(!n)return'0 B';const u=['B','KB','MB','GB','TB'],i=Math.min(Math.floor(Math.log(n)/Math.log(1024)),4);return(n/1024**i).toFixed(i?1:0)+' '+u[i]};
const fmtDate=s=>s?new Date(s).toLocaleString('ko-KR'):'-';
function hideUnusedDatasetControls(){
 if(!location.pathname.includes('/datasets/simple/'))return;
 document.querySelectorAll('button,a').forEach(control=>{
  if(control.closest('#'+ROOT_ID))return;
  const text=control.textContent.replace(/\s+/g,' ').trim().toLowerCase();
  const signature=[control.getAttribute('aria-label'),control.getAttribute('title'),control.getAttribute('data-id'),control.className,...[...control.querySelectorAll('i,mat-icon,svg,use')].flatMap(icon=>[icon.className?.baseVal||icon.className,icon.textContent,icon.getAttribute('href'),icon.getAttribute('data-id')])].filter(Boolean).join(' ').toLowerCase();
  if(text==='details'||text.startsWith('task information')||/(^|[ _-])(help|help_outline|question)([ _-]|$)/.test(signature)||/(^|[ _-])(refresh|reload|download)([ _-]|$)/.test(signature))control.classList.add('ivx-db-hidden-control');
 });
}
function leafText(root,text){return [...root.querySelectorAll('span,div,a')].find(n=>n.children.length===0&&n.textContent.trim()===text)}
function renameDatasetColumns(){
 if(!location.pathname.startsWith('/datasets/'))return;
 document.querySelectorAll('th,[role="columnheader"],sm-table-header-cell,.header-cell,.header-label,span,div').forEach(node=>{
  if(node.children.length===0&&node.textContent.trim()==='VERSION')node.textContent='BRANCH NAME';
 });
 if(!activeGraph)return;
 const byVersion=new Map(activeGraph.nodes.map(n=>[String(n.version).replace(/^v/i,''),n.branch]));
 document.querySelectorAll('span,div,a').forEach(name=>{
  if(name.children.length||!['Detector','VLM'].includes(name.textContent.trim()))return;
  let row=name.parentElement;
  for(let depth=0;row&&depth<8;depth++,row=row.parentElement){
   const match=[...byVersion].find(([version])=>leafText(row,version)||leafText(row,'v'+version));
   if(match){name.textContent=match[1];name.dataset.ivxVersionName='true';break}
  }
 });
}
async function loadGraph(id){for(const kind of ['detector','vlm']){const r=await fetch(API+'/datasets/graph?type='+kind,{credentials:'same-origin'});if(!r.ok)continue;const g=await r.json();if(g.nodes?.some(n=>n.id===id))return{g,kind}}throw Error('현재 Dataset의 버전 관계를 찾지 못했습니다.')}
function visibleGraph(g,branch){
 if(branch==='all')return{nodes:g.nodes,edges:g.edges};
 const map=new Map(g.nodes.map(n=>[n.id,n])),ids=new Set(g.nodes.filter(n=>n.branch===branch).map(n=>n.id));
 [...ids].forEach(id=>{let n=map.get(id);while(n?.parent_id&&map.has(n.parent_id)){ids.add(n.parent_id);n=map.get(n.parent_id)}});
 return{nodes:g.nodes.filter(n=>ids.has(n.id)),edges:g.edges.filter(e=>ids.has(e.source)&&ids.has(e.target))};
}
function positions(nodes){
 const map=new Map(nodes.map(n=>[n.id,n])),kids=new Map(nodes.map(n=>[n.id,[]]));
 nodes.forEach(n=>{if(kids.has(n.parent_id))kids.get(n.parent_id).push(n)});
 const roots=nodes.filter(n=>!map.has(n.parent_id)),pos=new Map();let leaf=0,maxDepth=0;
 const walk=(n,d)=>{maxDepth=Math.max(maxDepth,d);const cs=kids.get(n.id)||[];let x;if(!cs.length)x=leaf++*240+130;else x=cs.map(c=>walk(c,d+1)).reduce((a,b)=>a+b,0)/cs.length;pos.set(n.id,{x,depth:d});return x};
 roots.forEach(r=>walk(r,0));return{pos,width:Math.max(520,leaf*240+20),height:(maxDepth+1)*145+35,maxDepth};
}
function navigate(id){history.pushState({},'',location.pathname.replace(/\/tasks\/[a-f0-9]{32}/,'/tasks/'+id)+location.search);window.dispatchEvent(new PopStateEvent('popstate'));setTimeout(()=>scan(true),250)}
async function modal(node,kind,onDone,g){
 const shade=el('div','ivx-db-shade'),box=el('form','ivx-db-modal ivx-db-tree-modal');shade.append(box);box.append(el('h2','','새 Dataset Version 생성'),el('label','','Base Dataset 폴더 선택'));
 const status=el('div','ivx-db-tree-status','데이터 폴더를 불러오는 중…'),tree=el('div','ivx-db-folder-tree');box.append(status,tree,el('label','','Dataset version 이름'));const branch=el('input');branch.required=true;branch.placeholder='예: v2';branch.maxLength=32;box.append(branch,el('label','','Dataset Branch 이름'));const version=el('input');version.required=true;version.placeholder='예: 2.0.0';box.append(version,el('label','','설명'));const desc=el('textarea');desc.rows=3;desc.maxLength=4000;box.append(desc);
 const error=el('div','ivx-db-error'),actions=el('div','ivx-db-actions'),cancel=el('button','ivx-db-secondary','취소'),create=el('button','ivx-db-primary','Version 생성');cancel.type='button';create.disabled=true;actions.append(cancel,create);box.append(error,actions);document.body.append(shade);cancel.onclick=()=>shade.remove();shade.onclick=e=>{if(e.target===shade)shade.remove()};
 let catalog,selected=new Set(),has=(path,folder)=>folder==='.'||path===folder||path.startsWith(folder+'/'),rows=folder=>(catalog?.records||[]).filter(r=>has(r.path,folder)||[r.label,...(r.labels||[])].some(p=>has(p,folder)));
 const draw=()=>{tree.replaceChildren();const folders=catalog?.folders||[];const add=(folder,depth)=>{const label=el('label','ivx-db-tree-row'),check=el('input');check.type='checkbox';check.dataset.folder=folder;const data=rows(folder),count=data.filter(r=>selected.has(r.path)).length;check.checked=data.length>0&&count===data.length;check.indeterminate=count>0&&count<data.length;check.disabled=!data.length;label.style.paddingLeft=(depth*18)+'px';label.append(check,document.createTextNode('▣ '+(folder==='.'?(kind==='detector'?'Detector':'VLM'):folder.split('/').pop())+' ('+count+'/'+data.length+')'));tree.append(label);folders.filter(p=>p!==folder&&(p.includes('/')?p.slice(0,p.lastIndexOf('/')):'.')===folder).forEach(c=>add(c,depth+1))};add('.',0);status.textContent='선택 데이터 '+selected.size+'개';create.disabled=selected.size<2};
 tree.onchange=e=>{const folder=e.target.dataset.folder;if(folder===undefined)return;rows(folder).forEach(r=>e.target.checked?selected.add(r.path):selected.delete(r.path));draw()};
 try{const requests=[fetch(API+'/datasets/tree?type='+kind+'&modality='+encodeURIComponent(node.modality||'both'),{credentials:'same-origin'})];const responses=await Promise.all(requests);if(responses.some(r=>!r.ok))throw Error('Base Dataset 폴더를 불러오지 못했습니다.');catalog=await responses[0].json();draw();branch.focus()}catch(err){status.textContent='불러오기 실패';error.textContent=err.message}
 box.onsubmit=async e=>{e.preventDefault();const branchName=branch.value.trim();if(g.branches.includes(branchName)){error.textContent='이미 존재하는 브랜치 이름입니다.';return}create.disabled=cancel.disabled=true;error.textContent='선택 데이터 검증 및 Version 생성 중…';const folders=[];(catalog.folders||[]).forEach(f=>{const r=rows(f);if(r.length&&r.every(x=>selected.has(x.path))&&!folders.some(p=>has(f,p)))folders.push(f)});const common={dataset_type:kind,source_id:null,selected_folders:folders,selected_files:[...selected],modality:node.modality||'both',dataset_only:true};
  try{let r=await fetch(API+'/datasets/prepare',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(common)}),data=await r.json();if(!r.ok)throw Error(data.error||'Dataset 준비 실패');r=await fetch(API+'/datasets/connect',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...common,token:data.token,branch_name:branchName,new_branch:true,version:version.value.trim(),description:desc.value.trim()})});data=await r.json();if(!r.ok)throw Error(data.error||'Version 생성 실패');activeBranch=branchName;shade.remove();onDone(data.source_node.id)}catch(err){error.textContent=err.message;create.disabled=cancel.disabled=false}
 };
}
function branchModal(g,kind,selected,onDone){
 const shade=el('div','ivx-db-shade'),box=el('form','ivx-db-modal ivx-db-tree-modal');shade.append(box);box.append(el('h2','','새 Dataset branch 생성'));
 box.append(el('label','','부모 노드 선택'));const parent=el('select');const nodes=[...g.nodes].sort((a,b)=>String(a.version).localeCompare(String(b.version),undefined,{numeric:true}));nodes.forEach(n=>parent.append(new Option(n.branch+' · v'+n.version,n.id)));parent.value=selected?.id||nodes.at(-1)?.id||'';box.append(parent);
 const status=el('div','ivx-db-tree-status','부모 Dataset 기록을 불러오는 중…'),tree=el('div','ivx-db-folder-tree');box.append(el('label','','Dataset 기록 · Tree 선택'),status,tree);
 box.append(el('label','','Branch 이름'));const version=el('input');version.required=true;version.maxLength=64;version.pattern='v?[0-9]+(?:\.[0-9]+){1,2}';version.placeholder='예: v1.2.0';box.append(version);
 box.append(el('label','','설명'));const desc=el('textarea');desc.rows=3;desc.maxLength=4000;box.append(desc);
 const error=el('div','ivx-db-error'),actions=el('div','ivx-db-actions'),cancel=el('button','ivx-db-secondary','취소'),save=el('button','ivx-db-primary','＋ 저장');cancel.type='button';save.disabled=true;actions.append(cancel,save);box.append(error,actions);document.body.append(shade);
 cancel.onclick=()=>shade.remove();shade.onclick=e=>{if(e.target===shade)shade.remove()};
 let catalog=null,selectedFiles=new Set(),loading=false;const has=(path,folder)=>folder==='.'||path===folder||path.startsWith(folder+'/');const rows=folder=>(catalog?.records||[]).filter(r=>has(r.path,folder)||[r.label,...(r.labels||[])].some(p=>has(p,folder)));
 const draw=()=>{tree.replaceChildren();const folders=catalog?.folders||[];const add=(folder,depth)=>{const label=el('label','ivx-db-tree-row'),check=el('input');check.type='checkbox';check.dataset.folder=folder;const data=rows(folder),count=data.filter(r=>selectedFiles.has(r.path)).length;check.checked=data.length>0&&count===data.length;check.indeterminate=count>0&&count<data.length;check.disabled=loading||!data.length;label.style.paddingLeft=(depth*18)+'px';label.append(check,document.createTextNode('▣ '+(folder==='.'?(kind==='detector'?'Detector':'VLM'):folder.split('/').pop())+' ('+count+'/'+data.length+')'));tree.append(label);folders.filter(p=>p!==folder&&(p.includes('/')?p.slice(0,p.lastIndexOf('/')):'.')===folder).forEach(c=>add(c,depth+1))};add('.',0);status.textContent='선택 데이터 '+selectedFiles.size+'개';save.disabled=loading||selectedFiles.size<2};
 tree.onchange=e=>{const folder=e.target.dataset.folder;if(folder===undefined)return;rows(folder).forEach(r=>e.target.checked?selectedFiles.add(r.path):selectedFiles.delete(r.path));draw()};
 const loadParent=async()=>{loading=true;save.disabled=true;error.textContent='';status.textContent='부모 Dataset 기록을 불러오는 중…';tree.replaceChildren();try{const [treeResponse,versionResponse]=await Promise.all([fetch(API+'/datasets/tree?type='+kind+'&modality='+encodeURIComponent(g.nodes.find(n=>n.id===parent.value)?.modality||'both'),{credentials:'same-origin'}),fetch(API+'/datasets/version?type='+kind+'&id='+encodeURIComponent(parent.value),{credentials:'same-origin'})]);if(!treeResponse.ok||!versionResponse.ok)throw Error('부모 Dataset 기록을 불러오지 못했습니다.');catalog=await treeResponse.json();const manifest=await versionResponse.json(),available=new Set((catalog.records||[]).map(r=>r.path));selectedFiles=new Set((manifest.selected_files||[]).filter(path=>available.has(path)));loading=false;draw();version.focus()}catch(err){loading=false;status.textContent='불러오기 실패';error.textContent=err.message}};
 parent.onchange=loadParent;
 box.onsubmit=async e=>{e.preventDefault();const parentNode=g.nodes.find(n=>n.id===parent.value),branchVersion=version.value.trim().replace(/^v/i,'');if(!parentNode){error.textContent='부모 노드를 선택하세요.';return}if(g.nodes.some(n=>String(n.version).replace(/^v/i,'')===branchVersion)){error.textContent='이미 존재하는 Branch 이름입니다.';return}if(selectedFiles.size<2){error.textContent='Dataset 데이터를 최소 2개 선택하세요.';return}loading=true;save.disabled=cancel.disabled=true;error.textContent='선택 Dataset 저장 및 Branch 연결 중…';const folders=[];(catalog.folders||[]).forEach(f=>{const data=rows(f);if(data.length&&data.every(r=>selectedFiles.has(r.path))&&!folders.some(p=>has(f,p)))folders.push(f)});const common={dataset_type:kind,source_id:parentNode.id,selected_folders:folders,selected_files:[...selectedFiles],modality:parentNode.modality||'both',dataset_only:true};
  try{let r=await fetch(API+'/datasets/prepare',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(common)}),data=await r.json();if(!r.ok)throw Error(data.error||'Dataset 준비 실패');r=await fetch(API+'/datasets/connect',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...common,token:data.token,version:branchVersion,description:desc.value.trim(),branch_name:parentNode.branch,new_branch:false})});data=await r.json();if(!r.ok)throw Error(data.error||'Branch 저장 실패');activeBranch=parentNode.branch;shade.remove();onDone(data.source_node.id)}catch(err){loading=false;error.textContent=err.message;save.disabled=cancel.disabled=false}
 };
 loadParent();
}
function pathTree(paths){
 const root={folders:new Map(),files:[]};
 paths.forEach(path=>{const parts=String(path).split('/').filter(Boolean),file=parts.pop();let node=root;parts.forEach(part=>{if(!node.folders.has(part))node.folders.set(part,{folders:new Map(),files:[]});node=node.folders.get(part)});if(file)node.files.push(file)});
 const count=node=>node.files.length+[...node.folders.values()].reduce((sum,child)=>sum+count(child),0);
 const draw=(node,name,isRoot=false)=>{const details=el('details','ivx-db-path-node');if(isRoot)details.open=true;const summary=el('summary','',name+' ('+count(node)+'개)');details.append(summary);[...node.folders].sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})).forEach(([folder,child])=>details.append(draw(child,'📁 '+folder)));if(node.files.length){const files=el('div','ivx-db-path-files');node.files.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).forEach(file=>files.append(el('div','', '▧ '+file)));details.append(files)}return details};
 return draw(root,'전체 Dataset',true);
}
function changeList(title,items,kind){
 const details=el('details','ivx-db-change-list '+kind),summary=el('summary','',title+' '+items.length+'개');details.append(summary);if(items.length){const list=el('div','ivx-db-change-items');items.forEach(path=>list.append(el('div','',path)));details.append(list)}return details;
}
async function loadDetails(panel,kind,node){
 panel.replaceChildren(el('div','ivx-db-detail-loading','Dataset 추적 정보를 불러오는 중…'));
 try{
  const response=await fetch(API+'/datasets/details?type='+kind+'&id='+encodeURIComponent(node.id),{credentials:'same-origin'}),data=await response.json();if(!response.ok)throw Error(data.error||'상세 정보를 불러오지 못했습니다.');
  panel.replaceChildren();const description=el('section','ivx-db-info-card ivx-db-description'),descriptionHead=el('div','ivx-db-card-head'),descriptionState=el('span','ivx-db-save-state','');descriptionHead.append(el('h3','','Branch 설명'),descriptionState);const descriptionInput=el('textarea');descriptionInput.rows=4;descriptionInput.maxLength=4000;descriptionInput.placeholder='이 branch의 목적과 데이터 변경 내용을 입력하세요.';descriptionInput.value=data.description||'';const descriptionActions=el('div','ivx-db-description-actions'),descriptionCount=el('span','ivx-db-count',descriptionInput.value.length+' / 4000'),descriptionSave=el('button','ivx-db-primary','설명 저장');descriptionSave.type='button';descriptionActions.append(descriptionCount,descriptionSave);description.append(descriptionHead,descriptionInput,descriptionActions);panel.append(description);descriptionInput.oninput=()=>{descriptionCount.textContent=descriptionInput.value.length+' / 4000';descriptionState.textContent='수정됨'};descriptionSave.onclick=async()=>{descriptionSave.disabled=true;descriptionInput.disabled=true;descriptionState.textContent='저장 중…';try{const response=await fetch(API+'/datasets/description',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataset_type:kind,id:node.id,description:descriptionInput.value})}),result=await response.json();if(!response.ok)throw Error(result.error||'설명을 저장하지 못했습니다.');descriptionInput.value=result.description;descriptionCount.textContent=result.description.length+' / 4000';descriptionState.textContent='저장 완료';node.description=result.description}catch(error){descriptionState.textContent='저장 실패';alert(error.message)}finally{descriptionSave.disabled=false;descriptionInput.disabled=false}};
  const tree=el('section','ivx-db-info-card ivx-db-tree-card'),treeHead=el('div','ivx-db-card-head');treeHead.append(el('h3','','포함 데이터 Tree'),el('span','ivx-db-count',data.file_count+'개 · train '+data.splits.train+' / valid '+data.splits.valid+' / test '+data.splits.test));tree.append(treeHead,pathTree(data.selected_files));panel.append(tree);
  const usage=el('section','ivx-db-info-card'),usageHead=el('div','ivx-db-card-head');usageHead.append(el('h3','','학습 활용 이력'),el('span','ivx-db-count',data.training_usage.length+'회'));usage.append(usageHead);if(!data.training_usage.length)usage.append(el('p','ivx-db-empty','이 Dataset branch를 사용한 학습이 없습니다.'));data.training_usage.forEach(row=>{const item=el('div','ivx-db-usage');const left=el('div');left.append(el('strong','',row.name||row.task_id),el('span','',String(row.model_type||'model').toUpperCase()+' · '+fmtDate(row.used_at)));item.append(left,el('span','ivx-db-status '+row.status,row.status||'-'));usage.append(item)});panel.append(usage);
  const changes=el('section','ivx-db-info-card'),changesHead=el('div','ivx-db-card-head');changesHead.append(el('h3','','부모 노드 대비 변경'),el('span','ivx-db-count','추가 '+data.changes.added_count+' · 삭제 '+data.changes.removed_count));changes.append(changesHead,changeList('추가된 데이터',data.changes.added,'added'),changeList('삭제된 데이터',data.changes.removed,'removed'));panel.append(changes);
 }catch(error){panel.replaceChildren(el('div','ivx-db-error','상세 정보 조회 실패: '+error.message))}
}
function render(host,g,kind,selectedId){
 const selected=g.nodes.find(n=>n.id===selectedId);if(!activeBranch||(!g.branches.includes(activeBranch)&&activeBranch!=='all'))activeBranch=selected?.branch||g.branches[0]||'v1';
 const wrap=el('section','ivx-db-panel');wrap.id=ROOT_ID;const head=el('div','ivx-db-head'),title=el('div','ivx-db-head-title','VERSION BRANCHES'),tools=el('div','ivx-db-tools');
 const select=el('select','ivx-db-branch-select');select.setAttribute('aria-label','Dataset 브랜치');select.append(new Option('전체 브랜치','all'));g.branches.forEach(b=>select.append(new Option(b,b)));select.value=activeBranch;
 const addNode=el('button','ivx-db-secondary','＋ 새 branch'),addVersion=el('button','ivx-db-secondary','＋ 새 Version'),refresh=el('button','ivx-db-refresh','↻ 새로고침');tools.append(select,addNode,addVersion,refresh);head.append(title,tools);wrap.append(head);
 const shown=visibleGraph(g,activeBranch),{pos,width,height,maxDepth}=positions(shown.nodes),viewport=el('div','ivx-db-viewport'),canvas=el('div','ivx-db-canvas');canvas.style.width=width+'px';canvas.style.height=height+'px';viewport.append(canvas);wrap.append(viewport);
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width','100%');svg.setAttribute('height',String(height));svg.classList.add('ivx-db-lines');canvas.append(svg);
 const xy=id=>{const p=pos.get(id);return p&&{x:p.x,y:(maxDepth-p.depth)*145+22}};
 shown.edges.forEach(e=>{const a=xy(e.source),b=xy(e.target);if(!a||!b)return;const path=document.createElementNS(svg.namespaceURI,'path'),mid=(a.y+b.y)/2;path.setAttribute('d',`M ${a.x} ${a.y+94} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${b.y}`);svg.append(path)});
 const branchNodes=g.nodes.filter(n=>n.branch===activeBranch),headId=branchNodes.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0]?.id;
 shown.nodes.forEach(n=>{const p=xy(n.id),context=activeBranch!=='all'&&n.branch!==activeBranch,card=el('button','ivx-db-node'+(n.id===selectedId?' selected':'')+(context?' context':''));card.type='button';card.style.left=(p.x-100)+'px';card.style.top=p.y+'px';
  const title=el('div','ivx-db-title','v'+n.version);if(n.id===headId)title.append(el('span','ivx-db-latest','HEAD'));card.append(title,el('div','ivx-db-node-branch','⑂ '+n.branch),el('div','ivx-db-meta',n.status+' · '+n.file_count+' files'),el('div','ivx-db-time',fmtDate(n.created_at)));card.onclick=()=>{activeBranch=n.branch;navigate(n.id)};canvas.append(card)});
 const detail=el('div','ivx-db-detail');if(selected){const info=el('div');info.append(el('strong','',selected.name+' · '+selected.branch+' · v'+selected.version));const parent=g.nodes.find(n=>n.id===selected.parent_id);info.append(el('span','','부모: '+(parent?parent.branch+' / v'+parent.version:'없음')));const children=g.nodes.filter(n=>n.parent_id===selected.id);info.append(el('span','','하위 버전: '+(children.length?children.map(n=>n.branch+' / v'+n.version).join(', '):'없음')));detail.append(info)}wrap.append(detail);const inspector=el('div','ivx-db-inspector');wrap.append(inspector);if(selected)loadDetails(inspector,kind,selected);
 select.onchange=()=>{activeBranch=select.value;wrap.remove();render(host,g,kind,selectedId)};addNode.onclick=()=>branchModal(g,kind,selected,id=>navigate(id));addVersion.onclick=()=>selected&&modal(selected,kind,id=>navigate(id),g);refresh.onclick=()=>{wrap.remove();scan(true)};host.prepend(wrap);
}
async function scan(force=false){const id=currentId(),path=location.pathname;if(!id){document.getElementById(ROOT_ID)?.remove();document.querySelector('sm-open-dataset-version-info')?.classList.remove('ivx-db-replaced');return}const host=document.querySelector('sm-open-dataset-version-info');if(!host||busy)return;if(!force&&path===lastPath&&document.getElementById(ROOT_ID))return;busy=true;try{document.getElementById(ROOT_ID)?.remove();host.classList.add('ivx-db-replaced');const{g,kind}=await loadGraph(id);activeGraph=g;const selected=g.nodes.find(n=>n.id===id);if(id!==lastSelectedId){activeBranch=selected?.branch||g.branches[0]||'v1';lastSelectedId=id}renameDatasetColumns();render(host,g,kind,id);lastPath=path}catch(e){console.error('[Dataset branches]',e)}finally{busy=false}}
new MutationObserver(()=>{hideUnusedDatasetControls();renameDatasetColumns();scan()}).observe(document.documentElement,{childList:true,subtree:true});addEventListener('popstate',()=>setTimeout(()=>{renameDatasetColumns();scan(true)},200));setInterval(()=>{hideUnusedDatasetControls();renameDatasetColumns();scan()},1000);hideUnusedDatasetControls();renameDatasetColumns();scan();
})();
