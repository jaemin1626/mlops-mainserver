import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { WorkflowNavPrompt } from '../workflowNavigate';

interface WorkflowNavigateModalProps {
  prompt: WorkflowNavPrompt | null;
  itemLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const WorkflowNavigateModal: React.FC<WorkflowNavigateModalProps> = ({
  prompt,
  itemLabel,
  busy = false,
  onCancel,
  onConfirm,
}) => {
  useEffect(() => {
    if (!prompt || busy) return;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key !== 'a' && key !== 'd' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      e.preventDefault();
      e.stopPropagation();
      if (key === 'a' || e.key === 'ArrowLeft') onCancel();
      else onConfirm();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [prompt, busy, onCancel, onConfirm]);

  if (!prompt) return null;

  const isWorker = prompt.kind === 'worker_submit';
  const title = isWorker ? '검수 요청' : '검수 승인';
  const message = isWorker
    ? '다른 항목으로 이동합니다. 현재 항목을 검수 요청하시겠습니까?'
    : '다른 항목으로 이동합니다. 현재 항목을 승인하시겠습니까?';

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={busy ? undefined : onCancel}
      role="presentation"
    >
      <div
        className="glass-card w-full max-w-md border border-white/10 shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-nav-modal-title"
      >
        <h2 id="workflow-nav-modal-title" className="text-lg font-bold text-white">
          {title}
        </h2>
        {itemLabel ? (
          <p className="text-xs font-mono text-slate-400 mt-1 truncate" title={itemLabel}>
            {itemLabel}
          </p>
        ) : null}
        <p className="text-sm text-slate-300 mt-3">{message}</p>
        <p className="text-xs text-slate-500 mt-2">
          <kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono">A</kbd> 취소 ·{' '}
          <kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono">D</kbd>{' '}
          {isWorker ? '검수 요청' : '승인'}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2 mt-5">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="px-4 py-2 rounded-xl glass border border-white/10 text-sm text-slate-300 hover:bg-white/5 disabled:opacity-40"
          >
            취소 (A)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`px-4 py-2 rounded-xl text-sm font-semibold border disabled:opacity-40 ${
              isWorker
                ? 'border-amber-400/50 bg-amber-400/15 text-amber-100 hover:bg-amber-400/25'
                : 'border-emerald-400/50 bg-emerald-400/15 text-emerald-100 hover:bg-emerald-400/25'
            }`}
          >
            {busy ? '처리 중…' : isWorker ? '검수 요청 (D)' : '승인 (D)'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default WorkflowNavigateModal;
