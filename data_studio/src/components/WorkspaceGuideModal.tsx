import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

export type WorkspaceGuideKind = 'detector' | 'vlm';

type WorkspaceGuideModalProps = {
  kind: WorkspaceGuideKind | null;
  onClose: () => void;
};

type GuideStep = {
  title: string;
  detail: string;
};

type GuideContent = {
  flowLabels: string[];
  steps: GuideStep[];
  files?: { name: string; desc: string }[];
  workflow: { role: string; actions: string[] }[];
  tips: { label: string; keys?: string }[];
};

const DETECTOR_GUIDE: GuideContent = {
  flowLabels: ['폴더', '클래스', '박스', '저장', '검수'],
  steps: [
    { title: '폴더 열기', detail: '작업할 이미지 폴더를 선택합니다. 하위 폴더 이미지까지 모두 불러옵니다.' },
    { title: '클래스 세트', detail: 'txt 불러오기 · 직접 만들기 · 저장된 세트 중 하나를 적용해야 박스를 그릴 수 있습니다.' },
    { title: '라벨링', detail: '왼쪽에서 클래스 선택 → 캔버스에 박스. 1~9로 클래스 전환.' },
    { title: '저장', detail: '이미지와 같은 이름의 .txt (YOLO 좌표). 자동 저장 또는 Ctrl+S.' },
    { title: '검수', detail: '작업자: 검수 요청 · 검수자: 승인/반려. 상태는 *.meta.json.' },
  ],
  files: [
    { name: 'photo.jpg', desc: '원본 이미지' },
    { name: 'photo.txt', desc: 'YOLO 박스 라벨' },
    { name: 'photo.meta.json', desc: '작업중·검수대기·승인·반려' },
  ],
  workflow: [
    { role: '작업자', actions: ['라벨 저장', '검수 요청', '반려 시 수정 → 재검수'] },
    { role: '검수자', actions: ['검수대기 항목 열기', '승인 또는 반려'] },
  ],
  tips: [
    { label: '폴더 열기', keys: 'Ctrl+O' },
    { label: '저장', keys: 'Ctrl+S' },
    { label: '이전 / 다음', keys: 'A / D' },
    { label: 'Goto', keys: 'Ctrl+G' },
    { label: '클래스 txt', keys: 'Ctrl+L' },
  ],
};

const VLM_GUIDE: GuideContent = {
  flowLabels: ['폴더', '태그', '저장', '검수', '병합'],
  steps: [
    { title: '폴더 열기', detail: '이미지·영상이 있는 폴더를 선택합니다.' },
    { title: '질의·응답', detail: 'human(질의) / gpt(응답)을 편집합니다. 영상은 첫 재생 시 변환으로 지연될 수 있습니다.' },
    { title: '저장', detail: '같은 이름 .json (태그). image/video는 절대 경로로 저장됩니다.' },
    { title: '검수', detail: 'Detector와 동일한 역할·이름·검수 요청/승인/반려. *.meta.json.' },
    { title: '학습용 JSON 병합', detail: '승인 항목(기본) + GPT 응답 있는 .json만 하나의 배열로 내보냅니다.' },
  ],
  files: [
    { name: 'clip.mp4', desc: '원본 미디어' },
    { name: 'clip.json', desc: 'ShareGPT 태그 (conversations)' },
    { name: 'clip.meta.json', desc: '검수 워크플로 상태' },
  ],
  workflow: [
    { role: '작업자', actions: ['태그 저장', '검수 요청'] },
    { role: '검수자', actions: ['승인 / 반려', '학습용 JSON 병합 (승인분)'] },
  ],
  tips: [
    { label: '폴더 열기', keys: 'Ctrl+O' },
    { label: '저장', keys: 'Ctrl+S' },
    { label: '이전 / 다음', keys: 'A / D' },
    { label: 'Goto', keys: 'Ctrl+G' },
  ],
};

function guideMeta(kind: WorkspaceGuideKind): {
  title: string;
  accent: string;
  accentBg: string;
  borderClass: string;
  flowColor: string;
} {
  if (kind === 'detector') {
    return {
      title: 'Detector 작업 가이드',
      accent: 'text-[var(--accent-lime)]',
      accentBg: 'bg-[var(--accent-lime)]/15 border-[var(--accent-lime)]/35',
      borderClass: 'border-[var(--accent-lime)]/30',
      flowColor: 'var(--accent-lime)',
    };
  }
  return {
    title: 'VLM 작업 가이드',
    accent: 'text-[var(--accent-purple)]',
    accentBg: 'bg-[var(--accent-purple)]/15 border-[var(--accent-purple)]/35',
    borderClass: 'border-[var(--accent-purple)]/30',
    flowColor: 'var(--accent-purple)',
  };
}

const FlowStrip: React.FC<{ labels: string[]; color: string }> = ({ labels, color }) => (
  <div className="flex flex-wrap items-center gap-1 sm:gap-0 justify-center sm:justify-start">
    {labels.map((label, i) => (
      <React.Fragment key={label}>
        <div
          className="px-2.5 py-1.5 rounded-lg border border-white/10 bg-slate-800/80 text-xs font-semibold text-white text-center min-w-[3.5rem]"
          style={{ boxShadow: i === 0 ? `0 0 12px ${color}33` : undefined }}
        >
          {label}
        </div>
        {i < labels.length - 1 ? (
          <span className="text-slate-600 px-0.5 sm:px-1 text-sm hidden sm:inline" aria-hidden>
            →
          </span>
        ) : null}
      </React.Fragment>
    ))}
  </div>
);

const StatusLegend: React.FC = () => (
  <div className="flex flex-wrap gap-1.5 text-[11px] font-medium">
    <span className="px-2 py-0.5 rounded-md border border-slate-500/40 bg-slate-500/15 text-slate-300">작업중</span>
    <span className="px-2 py-0.5 rounded-md border border-amber-400/40 bg-amber-400/15 text-amber-200">검수대기</span>
    <span className="px-2 py-0.5 rounded-md border border-emerald-400/40 bg-emerald-400/15 text-emerald-200">승인</span>
    <span className="px-2 py-0.5 rounded-md border border-red-400/40 bg-red-400/15 text-red-300">반려</span>
  </div>
);

const FileTree: React.FC<{ rows: { name: string; desc: string }[] }> = ({ rows }) => (
  <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3 font-mono text-xs space-y-2">
    <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">같은 폴더 · 같은 이름</div>
    {rows.map((row, i) => (
      <div key={row.name} className="flex items-start gap-2">
        <span className="text-slate-600 select-none">{i === rows.length - 1 ? '└' : '├'}</span>
        <div className="min-w-0 flex-1">
          <span className="text-[var(--accent-blue)]">{row.name}</span>
          <span className="text-slate-500 ml-2 font-sans">{row.desc}</span>
        </div>
      </div>
    ))}
  </div>
);

const WorkspaceGuideModal: React.FC<WorkspaceGuideModalProps> = ({ kind, onClose }) => {
  useEffect(() => {
    if (!kind) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kind, onClose]);

  if (!kind) return null;

  const meta = guideMeta(kind);
  const guide = kind === 'detector' ? DETECTOR_GUIDE : VLM_GUIDE;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`bg-slate-900 border ${meta.borderClass} rounded-3xl shadow-2xl w-full max-w-2xl max-h-[min(90vh,720px)] overflow-hidden flex flex-col`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-guide-title"
      >
        <div className="p-5 sm:px-6 border-b border-white/5 flex justify-between items-center bg-slate-800/20 shrink-0">
          <div>
            <h3 id="workspace-guide-title" className={`font-bold text-lg text-white ${meta.accent}`}>
              {meta.title}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">한 번에 훑어보는 순서 · 아래에서 자세히</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-500 hover:text-white hover:bg-white/10 transition-colors shrink-0"
            aria-label="닫기"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 sm:p-6 overflow-y-auto min-h-0 space-y-5">
          <section className={`rounded-2xl border p-4 ${meta.accentBg}`}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">작업 흐름</div>
            <FlowStrip labels={guide.flowLabels} color={meta.flowColor} />
          </section>

          {guide.files ? (
            <section>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">파일 구조</div>
              <FileTree rows={guide.files} />
            </section>
          ) : null}

          <section>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">단계별</div>
            <ol className="space-y-2">
              {guide.steps.map((step, i) => (
                <li
                  key={step.title}
                  className="flex gap-3 p-3 rounded-xl border border-white/8 bg-slate-800/40 hover:bg-slate-800/60 transition-colors"
                >
                  <span
                    className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold ${meta.accent} ${meta.accentBg}`}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="font-semibold text-white text-sm">{step.title}</div>
                    <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="grid sm:grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">역할별</div>
              <div className="space-y-2">
                {guide.workflow.map((w) => (
                  <div key={w.role} className="rounded-xl border border-white/10 p-3 bg-slate-950/40">
                    <div className={`text-xs font-bold mb-1.5 ${meta.accent}`}>{w.role}</div>
                    <ul className="text-xs text-slate-400 space-y-1">
                      {w.actions.map((a) => (
                        <li key={a} className="flex gap-1.5">
                          <span className="text-slate-600">·</span>
                          <span>{a}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">검수 상태</div>
              <StatusLegend />
              <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                화면 상단·왼쪽 Goto 영역의 배지와 [상태 필터] chip 과 동일합니다.
              </p>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2 mt-4">단축키</div>
              <div className="space-y-1.5">
                {guide.tips.map((t) => (
                  <div key={t.label} className="flex justify-between gap-2 text-xs">
                    <span className="text-slate-400">{t.label}</span>
                    {t.keys ? (
                      <kbd className="font-mono px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-200 shrink-0">
                        {t.keys}
                      </kbd>
                    ) : null}
                  </div>
                ))}
              </div>
              {kind === 'detector' ? (
                <p className="text-[11px] text-slate-500 mt-2">캔버스 단축키는 우측 상단 [단축키] 버튼을 참고하세요.</p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default WorkspaceGuideModal;
