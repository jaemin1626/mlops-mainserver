import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface YoloShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

const Row: React.FC<{ label: string; keys: React.ReactNode }> = ({ label, keys }) => (
  <div className="flex justify-between items-start gap-3 text-sm">
    <span className="text-slate-400 font-medium shrink-0 pt-0.5">{label}</span>
    <span className="text-white font-mono bg-slate-800 px-2 py-1 rounded-lg border border-slate-700 shadow-sm text-xs text-right leading-relaxed">
      {keys}
    </span>
  </div>
);

const YoloShortcutsModal: React.FC<YoloShortcutsModalProps> = ({ open, onClose }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-200"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-slate-900 border border-white/10 rounded-3xl shadow-2xl w-full max-w-4xl max-h-[min(90vh,720px)] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="단축키 안내"
      >
        <div className="p-5 sm:px-6 border-b border-white/5 flex justify-between items-center bg-slate-800/20 shrink-0">
          <h3 className="font-bold text-lg sm:text-xl text-white">단축키 안내</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="닫기"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 sm:p-6 overflow-y-auto min-h-0">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
            <section className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">보기 · 도구</h4>
              <Row label="확대" keys="마우스 휠" />
              <Row label="이미지 이동(잡고 드래그)" keys="스페이스바 누른 채 · 가운데 버튼 · Shift+빈곳" />
              <Row label="캔버스 도구 패널 표시/숨김" keys="]" />
              <Row label="손 도구(팬) ↔ 박스 생성" keys="H · 상단 손 아이콘" />
              <Row label="박스 생성(기본)" keys="클릭 두 번(대각)" />
              <div className="flex justify-between items-start gap-3 text-sm">
                <span className="text-slate-400 font-medium shrink-0 pt-0.5">박스 선택/이동/크기조절</span>
                <div className="text-right text-xs text-slate-300 space-y-1.5 max-w-[16rem]">
                  <div>박스 클릭으로 선택·이동 · 단일 선택 시 모서리/핸들로 크기</div>
                  <div>
                    <span className="font-mono text-blue-300">F</span> 호버 중인 박스 선택 ·{' '}
                    <span className="font-mono text-blue-300">Shift+F</span> 다중에 토글
                  </div>
                  <div>
                    <span className="font-mono text-blue-300">Shift+클릭</span> 겹침 시 순환 · 다중 토글
                  </div>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">편집 · 탐색</h4>
              <Row label="단일 박스 삭제" keys="Bksp / R / 우클릭 (이미지 삭제: Del)" />
              <Row label="클래스 변경 (선택된/호버 객체)" keys="E" />
              <Row label="클래스 숫자 단축키" keys="1 - 9" />
              <Row label="Active class 이전/다음" keys="W / S" />
              <Row label="다중 선택 추가 (호버 객체)" keys="Shift+X" />
              <Row label="박스 표시 토글 (흐리게)" keys="B" />
              <Row label="모든 객체 표시/숨김 토글" keys="` (백틱)" />
              <Row label="제출 & 다음 이미지" keys="D" />
              <Row label="제출 & 이전 이미지" keys="A" />
              <Row label="작업 되돌리기/재실행" keys="Ctrl+Z / Ctrl+Y" />
              <Row label="선택 박스 복사 / 붙여넣기" keys="C / V" />
              <Row label="모든 박스 복사" keys="X" />
            </section>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default YoloShortcutsModal;
