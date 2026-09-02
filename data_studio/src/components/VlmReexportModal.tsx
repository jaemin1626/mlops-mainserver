import React, { useMemo } from 'react';
import type { VlmExportRowMeta } from '../vlmFileIO';
import { LOCAL_VLM_REVIEW_OPTIONS, VLM_REVIEW_OPTION_STYLE_PRESETS } from '../vlmReviewOptions';

type VlmReexportModalProps = {
  open: boolean;
  rows: VlmExportRowMeta[];
  selectedSlots: Set<number>;
  reviewFilter: string[];
  exporting: boolean;
  sourceFileName: string;
  onClose: () => void;
  onToggleReviewFilter: (id: string) => void;
  onToggleSlot: (slot: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onSelectVisible: () => void;
  onExport: () => void;
};

const VlmReexportModal: React.FC<VlmReexportModalProps> = ({
  open,
  rows,
  selectedSlots,
  reviewFilter,
  exporting,
  sourceFileName,
  onClose,
  onToggleReviewFilter,
  onToggleSlot,
  onSelectAll,
  onSelectNone,
  onSelectVisible,
  onExport,
}) => {
  const visibleRows = useMemo(() => {
    if (reviewFilter.length === 0) return rows;
    return rows.filter((row) => reviewFilter.includes(row.reviewResultId));
  }, [rows, reviewFilter]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-2xl border border-purple-500/25 bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vlm-reexport-title"
      >
        <div className="px-5 py-4 border-b border-slate-700 flex items-start justify-between gap-3">
          <div>
            <h2 id="vlm-reexport-title" className="text-lg font-bold text-white">
              JSON Export
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              원본: <span className="font-mono text-slate-300">{sourceFileName}</span> · 선택 항목만 ShareGPT 형식 배열로 저장
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={exporting}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-40"
            aria-label="닫기"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-3 border-b border-slate-800 space-y-3">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">검수 결과 필터</div>
            <div className="flex flex-wrap gap-1.5">
              {LOCAL_VLM_REVIEW_OPTIONS.map((opt, idx) => {
                const selected = reviewFilter.includes(opt.id);
                const style = VLM_REVIEW_OPTION_STYLE_PRESETS[idx % VLM_REVIEW_OPTION_STYLE_PRESETS.length];
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onToggleReviewFilter(opt.id)}
                    disabled={exporting}
                    className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold transition-all disabled:opacity-40 ${
                      selected
                        ? `${style.activeClass} ring-1 ${style.ring}`
                        : `${style.className} opacity-50 hover:opacity-80`
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-500 mt-1.5">
              목록 표시만 좁힙니다. 여러 개 선택 시 OR. 비우면 전체 표시.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onSelectAll}
              disabled={exporting}
              className="px-2.5 py-1 rounded-lg text-xs border border-white/15 text-slate-300 hover:bg-white/5 disabled:opacity-40"
            >
              전체 선택
            </button>
            <button
              type="button"
              onClick={onSelectNone}
              disabled={exporting}
              className="px-2.5 py-1 rounded-lg text-xs border border-white/15 text-slate-300 hover:bg-white/5 disabled:opacity-40"
            >
              전체 해제
            </button>
            <button
              type="button"
              onClick={onSelectVisible}
              disabled={exporting || visibleRows.length === 0}
              className="px-2.5 py-1 rounded-lg text-xs border border-purple-500/40 text-purple-200 hover:bg-purple-500/10 disabled:opacity-40"
            >
              표시 항목만 선택
            </button>
            <span className="text-xs text-slate-400 ml-auto font-mono tabular-nums">
              선택 {selectedSlots.size} / 전체 {rows.length}
              {reviewFilter.length > 0 ? ` · 표시 ${visibleRows.length}` : ''}
            </span>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-5 py-2">
          {visibleRows.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center">표시할 항목이 없습니다.</p>
          ) : (
            <ul className="space-y-1.5">
              {visibleRows.map((row) => {
                const checked = selectedSlots.has(row.slot);
                return (
                  <li key={row.slot}>
                    <label
                      className={`flex items-start gap-3 p-2.5 rounded-xl border cursor-pointer transition-colors ${
                        checked
                          ? 'border-purple-500/40 bg-purple-500/10'
                          : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleSlot(row.slot)}
                        disabled={exporting}
                        className="mt-1 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="text-xs font-mono text-slate-400">#{row.listIndex}</span>
                          <span className="text-[11px] font-semibold text-purple-200">{row.reviewLabel}</span>
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono truncate" title={row.mediaPath}>
                          {row.mediaPath || '(미디어 경로 없음)'}
                        </div>
                        {row.promptPreview && (
                          <div className="text-[11px] text-slate-400 mt-1 line-clamp-2" title={row.promptPreview}>
                            {row.promptPreview}
                          </div>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-700 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={exporting}
            className="px-4 py-2 rounded-xl text-sm border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            취소
          </button>
          <button
            type="button"
            onClick={onExport}
            disabled={exporting || selectedSlots.size === 0}
            className="px-4 py-2 rounded-xl text-sm font-bold bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-40"
          >
            {exporting ? '저장 중…' : `JSON Export (${selectedSlots.size}건)`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default VlmReexportModal;
