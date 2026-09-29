const pptxgen = require('pptxgenjs');

const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'OpenAI Codex';
pptx.subject = '객체 검출 모델 개발 계획';
pptx.title = '객체 검출 모델 개발 계획';
pptx.company = 'MLOps Team';
pptx.lang = 'ko-KR';
pptx.theme = {
  headFontFace: 'NanumSquare', bodyFontFace: 'NanumSquare', lang: 'ko-KR'
};
pptx.defineSlideMaster({
  title: 'MASTER',
  background: { color: 'F5F7FA' },
  objects: [
    { rect: { x: 0, y: 0, w: 13.333, h: 0.12, fill: { color: '19B5A5' }, line: { color: '19B5A5' } } },
    { text: { text: 'OBJECT DETECTION MODEL DEVELOPMENT', options: { x: 0.58, y: 7.12, w: 5.8, h: 0.18, fontFace: 'Arial', fontSize: 7.5, color: '8290A3', charSpacing: 1.1, margin: 0 } } },
    { text: { text: '2026.09', options: { x: 11.8, y: 7.12, w: 0.9, h: 0.18, fontFace: 'Arial', fontSize: 7.5, color: '8290A3', align: 'right', margin: 0 } } }
  ],
  slideNumber: { x: 12.78, y: 7.08, color: '8290A3', fontFace: 'Arial', fontSize: 8 }
});

const C = { navy:'172B4D', teal:'19B5A5', cyan:'3A86FF', orange:'FF9F43', red:'E85D75', ink:'25324B', gray:'667085', light:'E8EDF3', white:'FFFFFF', pale:'F5F7FA', green:'3DBE8B' };
const addTitle = (s, title, kicker) => {
  s.addText(kicker || 'MODEL DEVELOPMENT PLAN', {x:0.65,y:0.38,w:4.5,h:0.25,fontFace:'Arial',fontSize:9,bold:true,color:C.teal,charSpacing:1.5,margin:0});
  s.addText(title, {x:0.65,y:0.72,w:11.8,h:0.55,fontSize:26,bold:true,color:C.navy,margin:0,breakLine:false});
};
const addPill = (s, text, x, y, w, color=C.teal) => {
  s.addShape(pptx.ShapeType.roundRect,{x,y,w,h:0.34,rectRadius:0.08,fill:{color},line:{color}});
  s.addText(text,{x:x+0.05,y:y+0.05,w:w-0.1,h:0.2,fontSize:9,bold:true,color:C.white,align:'center',margin:0});
};
const addCard = (s, x, y, w, h, title, body, accent=C.teal) => {
  s.addShape(pptx.ShapeType.roundRect,{x,y,w,h,rectRadius:0.06,fill:{color:C.white},line:{color:'DCE3EC',width:1}});
  s.addShape(pptx.ShapeType.rect,{x,y,w:0.08,h,fill:{color:accent},line:{color:accent}});
  s.addText(title,{x:x+0.25,y:y+0.2,w:w-0.45,h:0.35,fontSize:17,bold:true,color:C.navy,margin:0});
  s.addText(body,{x:x+0.25,y:y+0.72,w:w-0.45,h:h-0.9,fontSize:11.5,color:C.gray,breakLine:false,margin:0.02,paraSpaceAfterPt:8,bullet: body.includes('\n') ? {type:'bullet'} : undefined});
};

// 1. Cover
{
  const s = pptx.addSlide(); s.background = {color:C.navy};
  s.addShape(pptx.ShapeType.rect,{x:0,y:0,w:0.18,h:7.5,fill:{color:C.teal},line:{color:C.teal}});
  s.addText('OBJECT DETECTION', {x:0.85,y:1.0,w:5.2,h:0.3,fontFace:'Arial',fontSize:11,bold:true,color:'63D9CD',charSpacing:2.4,margin:0});
  s.addText('객체 검출 모델\n개발 계획', {x:0.82,y:1.55,w:7.2,h:1.55,fontSize:34,bold:true,color:C.white,margin:0,breakLine:false});
  s.addText('통합 · 산업안전 · ITS 데이터셋 기반 YOLOv7 모델 고도화', {x:0.86,y:3.35,w:7.8,h:0.45,fontSize:17,color:'C9D4E5',margin:0});
  s.addText('2026. 09. 23 — 2026. 10. 06', {x:0.86,y:4.18,w:4.8,h:0.35,fontFace:'Arial',fontSize:15,bold:true,color:'63D9CD',margin:0});
  // abstract detection visual
  const boxes=[{x:9.15,y:1.15,w:2.55,h:2.0,c:C.teal,t:'PERSON'},{x:8.2,y:3.45,w:3.35,h:1.75,c:C.cyan,t:'VEHICLE'},{x:10.4,y:4.85,w:1.45,h:1.35,c:C.orange,t:'CONE'}];
  boxes.forEach(b=>{s.addShape(pptx.ShapeType.rect,{x:b.x,y:b.y,w:b.w,h:b.h,fill:{color:C.navy,transparency:100},line:{color:b.c,width:2}});addPill(s,b.t,b.x,b.y-0.25,Math.max(0.8,b.w*0.48),b.c)});
  s.addText('데이터 자산 통합 → 학습 → 경량화 → 검증/품의', {x:0.86,y:6.55,w:6.5,h:0.3,fontSize:11,color:'9EADC2',margin:0});
}

// 2. Executive summary
{
  const s=pptx.addSlide('MASTER'); addTitle(s,'개발 목표 및 추진 방향','01  OVERVIEW');
  s.addText('세 모델의 강점을 결합해 현장 범용성과 도메인 대응력을 동시에 확보', {x:0.68,y:1.4,w:11.7,h:0.42,fontSize:18,bold:true,color:C.ink,margin:0});
  addCard(s,0.68,2.08,3.82,2.45,'01  데이터 통합','사람·차량의 다양성 확보\n중장비 및 traffic cone 클래스 보강\n고속도로·터널 도메인 편향 완화',C.teal);
  addCard(s,4.76,2.08,3.82,2.45,'02  모델 학습','YOLOv7 기반 단일 검출기 학습\n클래스 정의·라벨 정책 통일\n데이터셋별 샘플링 균형 적용',C.cyan);
  addCard(s,8.84,2.08,3.82,2.45,'03  경량화·검증','Pruning으로 추론 효율 개선\n정확도·속도·용량 종합 평가\n운영 적용 모델 품의',C.orange);
  s.addShape(pptx.ShapeType.roundRect,{x:0.68,y:5.0,w:11.98,h:1.05,fill:{color:'E8F8F5'},line:{color:'BDEAE4'}});
  s.addText('최종 산출물', {x:0.95,y:5.25,w:1.4,h:0.28,fontSize:12,bold:true,color:C.teal,margin:0});
  s.addText('통합 학습 데이터셋  ·  YOLOv7 원본 모델  ·  Pruned 모델  ·  성능 평가서 및 모델 품의 자료', {x:2.25,y:5.2,w:9.8,h:0.35,fontSize:14,bold:true,color:C.navy,margin:0});
}

// 3. Dataset assets
{
  const s=pptx.addSlide('MASTER'); addTitle(s,'보유 데이터셋과 상호 보완 구조','02  DATA ASSETS');
  const items=[
    {x:0.65,c:C.teal,t:'통합 검출기',classes:'사람 · 차량 · 중장비',strength:'다양한 사람·차량 데이터',bbox:'[BBOX: 여러 환경의 사람·차량·중장비 검출 샘플 이미지]'},
    {x:4.48,c:C.orange,t:'산업안전 검출기',classes:'사람 · 차량 · traffic cone',strength:'다양한 시점의 traffic cone',bbox:'[BBOX: 근거리/원거리/사선 뷰의 traffic cone 검출 샘플]'},
    {x:8.31,c:C.cyan,t:'ITS 검출기',classes:'사람 · 차량',strength:'고속도로·터널 장면',bbox:'[BBOX: 고속도로 및 터널 CCTV 검출 샘플 이미지]'}
  ];
  items.forEach(o=>{
    s.addShape(pptx.ShapeType.roundRect,{x:o.x,y:1.45,w:3.55,h:4.55,fill:{color:C.white},line:{color:'DCE3EC'}});
    s.addShape(pptx.ShapeType.rect,{x:o.x,y:1.45,w:3.55,h:0.1,fill:{color:o.c},line:{color:o.c}});
    s.addText(o.t,{x:o.x+0.25,y:1.78,w:3.05,h:0.4,fontSize:19,bold:true,color:C.navy,margin:0});
    s.addText(o.classes,{x:o.x+0.25,y:2.35,w:3.0,h:0.3,fontSize:11,bold:true,color:o.c,margin:0});
    s.addShape(pptx.ShapeType.roundRect,{x:o.x+0.25,y:2.9,w:3.05,h:1.45,fill:{color:'F1F4F8'},line:{color:'CED7E3',dash:'dash'}});
    s.addText(o.bbox,{x:o.x+0.45,y:3.3,w:2.65,h:0.65,fontSize:10,color:'79879A',italic:true,align:'center',valign:'mid',margin:0.02});
    s.addText('핵심 강점',{x:o.x+0.25,y:4.72,w:0.9,h:0.25,fontSize:10,bold:true,color:C.gray,margin:0});
    s.addText(o.strength,{x:o.x+0.25,y:5.08,w:3.0,h:0.35,fontSize:14,bold:true,color:C.ink,margin:0});
  });
}

// 4. Integration blueprint
{
  const s=pptx.addSlide('MASTER'); addTitle(s,'통합 데이터셋 구성안','03  INTEGRATION BLUEPRINT');
  const src=[['통합 검출기','사람·차량 다양성\n+ 중장비',C.teal],['산업안전','traffic cone 다양성',C.orange],['ITS','고속도로·터널\n도메인',C.cyan]];
  src.forEach((a,i)=>{const y=1.55+i*1.45; s.addShape(pptx.ShapeType.roundRect,{x:0.75,y,w:3.0,h:0.95,fill:{color:C.white},line:{color:a[2],width:1.4}});s.addText(a[0],{x:1.0,y:y+0.18,w:1.2,h:0.25,fontSize:14,bold:true,color:C.navy,margin:0});s.addText(a[1],{x:2.1,y:y+0.15,w:1.4,h:0.5,fontSize:10.5,color:C.gray,margin:0});s.addShape(pptx.ShapeType.chevron,{x:4.05,y:y+0.22,w:0.65,h:0.48,fill:{color:'AAB6C5'},line:{color:'AAB6C5'}})});
  s.addShape(pptx.ShapeType.roundRect,{x:4.95,y:1.72,w:3.25,h:3.55,fill:{color:'E8F8F5'},line:{color:C.teal,width:2}});
  s.addText('정규화·정제', {x:5.4,y:2.05,w:2.35,h:0.4,fontSize:21,bold:true,color:C.navy,align:'center',margin:0});
  s.addText('① 클래스 매핑\n② 라벨 품질 점검\n③ 중복 이미지 제거\n④ 해상도/포맷 통일\n⑤ 도메인·클래스 균형화', {x:5.48,y:2.7,w:2.3,h:1.75,fontSize:13,color:C.ink,breakLine:false,margin:0.02,paraSpaceAfterPt:9});
  s.addShape(pptx.ShapeType.chevron,{x:8.45,y:3.15,w:0.75,h:0.55,fill:{color:C.teal},line:{color:C.teal}});
  s.addShape(pptx.ShapeType.roundRect,{x:9.45,y:1.72,w:3.1,h:3.55,fill:{color:C.navy},line:{color:C.navy}});
  s.addText('통합 학습셋', {x:9.85,y:2.1,w:2.3,h:0.45,fontSize:22,bold:true,color:C.white,align:'center',margin:0});
  ['PERSON','VEHICLE','HEAVY EQUIPMENT','TRAFFIC CONE'].forEach((t,i)=>addPill(s,t,9.85,2.9+i*0.48,2.3,[C.teal,C.cyan,C.orange,C.red][i]));
  s.addText('Train / Validation / Test는\n원천·장면 단위로 분리', {x:9.75,y:5.7,w:2.5,h:0.55,fontSize:11.5,bold:true,color:C.red,align:'center',margin:0});
}

// 5. Class policy & training
{
  const s=pptx.addSlide('MASTER'); addTitle(s,'클래스 정의 및 학습 전략','04  TRAINING STRATEGY');
  const rows=[['최종 클래스','person','vehicle','heavy equipment','traffic cone'],['통합 검출기','●','●','●','—'],['산업안전','●','●','—','●'],['ITS','●','●','—','—']];
  const xs=[0.7,3.0,4.9,7.05,9.65], ws=[2.2,1.7,1.9,2.4,2.35];
  rows.forEach((r,ri)=>r.forEach((v,ci)=>{const y=1.5+ri*0.65; s.addShape(pptx.ShapeType.rect,{x:xs[ci],y,w:ws[ci],h:0.56,fill:{color:ri===0?C.navy:(ci===0?'E8EDF3':C.white)},line:{color:'D7DEE8'}});s.addText(v,{x:xs[ci]+0.05,y:y+0.13,w:ws[ci]-0.1,h:0.25,fontSize:ri===0?10.5:12,bold:ri===0||ci===0,color:ri===0?C.white:(v==='●'?C.teal:C.ink),align:'center',margin:0})}));
  addCard(s,0.7,4.35,3.75,1.65,'데이터 균형','데이터셋·도메인·클래스별 샘플링 비율 관리\n희소 클래스 oversampling 및 증강',C.teal);
  addCard(s,4.8,4.35,3.75,1.65,'학습·검증 분리','동일 영상 프레임이 서로 다른 split에 섞이지 않도록 장면 단위 분리',C.cyan);
  addCard(s,8.9,4.35,3.75,1.65,'Hard Case 강화','터널 저조도, 원거리 객체, 가림, 밀집 장면을 별도 태깅하여 성능 추적',C.orange);
}

// 6. Schedule
{
  const s=pptx.addSlide('MASTER'); addTitle(s,'개발 일정 및 단계별 산출물','05  ROADMAP');
  const phases=[
    {n:'01',t:'YOLOv7 학습',d:'09/23 — 09/28',x:0.75,w:4.35,c:C.teal,desc:'통합 데이터셋 구성·검증\nBaseline 학습 및 튜닝',out:'산출물  |  YOLOv7 후보 모델'},
    {n:'02',t:'YOLOv7 Pruning',d:'09/28 — 10/02',x:5.0,w:3.75,c:C.cyan,desc:'Pruning 적용 및 재학습\n정확도–속도 trade-off 확인',out:'산출물  |  경량 후보 모델'},
    {n:'03',t:'성능 평가·품의',d:'10/05 — 10/06',x:8.65,w:3.93,c:C.orange,desc:'정확도·속도·용량 비교\n최종 모델 선정 및 품의',out:'산출물  |  평가서·품의안'}
  ];
  s.addShape(pptx.ShapeType.line,{x:1.0,y:2.25,w:11.2,h:0,line:{color:'B7C2D0',width:2}});
  phases.forEach((p,i)=>{
    s.addShape(pptx.ShapeType.ellipse,{x:p.x+0.05,y:2.0,w:0.48,h:0.48,fill:{color:p.c},line:{color:C.white,width:2}});
    s.addText(p.n,{x:p.x+0.08,y:2.12,w:0.42,h:0.14,fontFace:'Arial',fontSize:8,bold:true,color:C.white,align:'center',margin:0});
    s.addShape(pptx.ShapeType.roundRect,{x:p.x,y:2.75,w:p.w,h:2.65,fill:{color:C.white},line:{color:p.c,width:1.2}});
    s.addText(p.t,{x:p.x+0.3,y:3.05,w:p.w-0.6,h:0.35,fontSize:20,bold:true,color:C.navy,margin:0});
    s.addText(p.d,{x:p.x+0.3,y:3.55,w:p.w-0.6,h:0.28,fontFace:'Arial',fontSize:13,bold:true,color:p.c,margin:0});
    s.addText(p.desc,{x:p.x+0.3,y:4.05,w:p.w-0.6,h:0.62,fontSize:11.5,color:C.gray,margin:0});
    s.addText(p.out,{x:p.x+0.3,y:4.92,w:p.w-0.6,h:0.25,fontSize:10.5,bold:true,color:C.ink,margin:0});
  });
  s.addShape(pptx.ShapeType.roundRect,{x:0.75,y:5.85,w:11.83,h:0.62,fill:{color:'FFF3E6'},line:{color:'FFD5A5'}});
  s.addText('※ 09/28은 학습 결과 인계 및 Pruning 착수일로 두 단계가 연속 진행됩니다.', {x:1.0,y:6.05,w:11.3,h:0.25,fontSize:11.5,bold:true,color:'A85B00',margin:0});
}

// 7. Evaluation
{
  const s=pptx.addSlide('MASTER'); addTitle(s,'성능 평가 및 모델 선정 기준','06  EVALUATION');
  const metrics=[['정확도','mAP@0.5 / mAP@0.5:0.95\n클래스별 AP·Recall',C.teal],['효율','FPS / Latency\n모델 크기·연산량',C.cyan],['강건성','터널·고속도로·산업현장\n주·야간 및 원거리',C.orange],['운영 적합성','오탐·미탐 사례\n배포 환경 호환성',C.red]];
  metrics.forEach((m,i)=>{const x=0.7+i*3.05;s.addShape(pptx.ShapeType.roundRect,{x,y:1.55,w:2.75,h:2.0,fill:{color:C.white},line:{color:m[2],width:1.4}});s.addShape(pptx.ShapeType.ellipse,{x:x+0.22,y:1.83,w:0.48,h:0.48,fill:{color:m[2]},line:{color:m[2]}});s.addText(String(i+1),{x:x+0.22,y:1.95,w:0.48,h:0.15,fontFace:'Arial',fontSize:9,bold:true,color:C.white,align:'center',margin:0});s.addText(m[0],{x:x+0.88,y:1.87,w:1.5,h:0.3,fontSize:17,bold:true,color:C.navy,margin:0});s.addText(m[1],{x:x+0.25,y:2.55,w:2.25,h:0.58,fontSize:11.5,color:C.gray,align:'center',margin:0})});
  s.addShape(pptx.ShapeType.roundRect,{x:0.7,y:4.05,w:7.2,h:1.75,fill:{color:'E8F8F5'},line:{color:'BDEAE4'}});
  s.addText('선정 원칙', {x:1.0,y:4.38,w:1.15,h:0.3,fontSize:16,bold:true,color:C.teal,margin:0});
  s.addText('원본 대비 Pruned 모델의 정확도 하락폭을 관리하면서\n목표 추론 속도 및 모델 경량화 수준을 만족하는 후보를 최종 선정', {x:2.2,y:4.35,w:5.2,h:0.75,fontSize:14,bold:true,color:C.navy,margin:0});
  s.addShape(pptx.ShapeType.roundRect,{x:8.25,y:4.05,w:4.65,h:1.75,fill:{color:C.white},line:{color:'CED7E3',dash:'dash'}});
  s.addText('[BBOX: 동일 장면에서 원본 모델과 Pruned 모델의\n검출 결과를 비교한 Before/After 이미지]', {x:8.65,y:4.58,w:3.85,h:0.65,fontSize:10.5,italic:true,color:'79879A',align:'center',margin:0});
}

// 8. Risk
{
  const s=pptx.addSlide('MASTER'); addTitle(s,'주요 리스크 및 일정 변동 안내','07  RISK & DEPENDENCY');
  s.addShape(pptx.ShapeType.roundRect,{x:0.72,y:1.45,w:11.9,h:1.18,fill:{color:'FFF1F3'},line:{color:'FFC7D1',width:1.2}});
  s.addText('핵심 안내', {x:1.0,y:1.82,w:1.15,h:0.3,fontSize:14,bold:true,color:C.red,margin:0});
  s.addText('전체 일정은 데이터셋 확보 시점과 라벨 품질 점검 결과에 따라 변경될 수 있습니다.', {x:2.25,y:1.76,w:9.75,h:0.42,fontSize:19,bold:true,color:C.navy,margin:0});
  const risks=[
    ['데이터 확보 지연','원천 데이터 전달·접근 권한 지연','확보 현황 일일 점검 / 우선 확보분 선행 정제'],
    ['라벨 정책 불일치','vehicle·중장비 경계 및 클래스명 상이','통합 라벨 가이드 확정 / 샘플 교차 검수'],
    ['클래스·도메인 불균형','traffic cone·중장비 희소 / ITS 장면 편중','샘플링 비율 조정 / 증강 / 도메인별 성능 추적'],
    ['Pruning 성능 저하','경량화 과정에서 Recall 하락 가능','단계별 sparsity 실험 / 재학습 / 원본 모델 비교']
  ];
  risks.forEach((r,i)=>{const y=3.0+i*0.72;s.addShape(pptx.ShapeType.roundRect,{x:0.75,y,w:2.25,h:0.54,fill:{color:i===0?'FFE4E9':'E8EDF3'},line:{color:'D7DEE8'}});s.addText(r[0],{x:0.9,y:y+0.16,w:1.95,h:0.2,fontSize:11.5,bold:true,color:i===0?C.red:C.navy,align:'center',margin:0});s.addText(r[1],{x:3.25,y:y+0.14,w:3.65,h:0.25,fontSize:11,color:C.gray,margin:0});s.addShape(pptx.ShapeType.chevron,{x:7.02,y:y+0.13,w:0.38,h:0.28,fill:{color:'AAB6C5'},line:{color:'AAB6C5'}});s.addText(r[2],{x:7.65,y:y+0.1,w:4.6,h:0.34,fontSize:11,bold:true,color:C.ink,margin:0})});
  s.addText('Gate 1  데이터셋 확보·검수 완료  →  Gate 2  Baseline 성능 확인  →  Gate 3  Pruning 모델 승인', {x:1.15,y:6.25,w:11.0,h:0.35,fontSize:13,bold:true,color:C.teal,align:'center',margin:0});
}

pptx.writeFile({ fileName: '/home/snowa/mlops-mainserver/객체_검출_모델_개발_계획_2026.pptx' });
