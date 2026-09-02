import React, { useMemo } from 'react';
import type { VlmBriefReport } from '../vlmFileIO';
import { formatVlmReviewBriefReportText } from '../vlmFileIO';
import { LOCAL_VLM_REVIEW_OPTIONS, VLM_REVIEW_OPTION_STYLE_PRESETS } from '../vlmReviewOptions';

type VlmBriefReportModalProps = {
  open: boolean;
  report: VlmBriefReport | null;
  busy: boolean;
  onClose: () => void;
  onCopy: (text: string) => void;
  onSaveText: (text: string) => void;
};

const VlmBriefReportModal: React.FC<VlmBriefReportModalProps> = ({
  open,
  report,
  busy,
  onClose,
  onCopy,
  onSaveText,
}) => {
  const reportText = useMemo(() => (report ? formatVlmReviewBriefReportText(report) : ''), [report]);

  if (!open || !report) return null;

  const reviewedPct =
    report.totalItems > 0 ? Math.round((report.explicitReviewCount / report.totalItems) * 1000) / 10 : 0;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-2xl border border-sky-500/25 bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vlm-report-title"
      >
        <div className="px-5 py-4 border-b border-slate-700 flex items-start justify-between gap-3">
          <div>
            <h2 id="vlm-report-title" className="text-lg font-bold text-white">
              검수 결과 리포트
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              원본: <span className="font-mono text-slate-300">{report.sourceFileName}</span>
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">{report.generatedAt}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-40"
            aria-label="닫기"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">총 항목</div>
              <div className="text-2xl font-black text-white tabular-nums mt-1">
                {report.totalItems.toLocaleString()}
              </div>
            </div>
            <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-amber-400/80 font-bold">수정필요</div>
              <div className="text-2xl font-black text-amber-200 tabular-nums mt-1">
                {report.needsFixTotal.toLocaleString()}
                <span className="text-sm font-semibold text-amber-400/80 ml-1">({report.needsFixPct}%)</span>
              </div>
            </div>
          </div>

          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">검수 결과</div>
            <ul className="space-y-2">
              {report.breakdown.map((row, idx) => {
                const style = VLM_REVIEW_OPTION_STYLE_PRESETS[idx % VLM_REVIEW_OPTION_STYLE_PRESETS.length];
                const opt = LOCAL_VLM_REVIEW_OPTIONS.find((o) => o.id === row.id);
                if (!opt) return null;
                return (
                  <li key={row.id} className="flex items-center gap-3">
                    <span
                      className={`shrink-0 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${style.className}`}
                    >
                      {row.label}
                    </span>
                    <div className="flex-1 h-2 bg-slate-950 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${row.id === 'NORMAL' ? 'bg-emerald-500' : 'bg-amber-500'}`}
                        style={{ width: `${Math.min(100, row.pct)}%` }}
                      />
                    </div>
                    <span className="text-xs font-mono tabular-nums text-slate-300 w-24 text-right shrink-0">
                      {row.count.toLocaleString()} ({row.pct}%)
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-950/40 px-3 py-2.5 text-xs text-slate-400 space-y-1">
            <div>
              명시 검수:{' '}
              <span className="text-slate-200 font-semibold tabular-nums">
                {report.explicitReviewCount.toLocaleString()}
              </span>{' '}
              / {report.totalItems.toLocaleString()} ({reviewedPct}%)
            </div>
            <div>
              미검수(기본 정상):{' '}
              <span className="text-slate-200 font-semibold tabular-nums">
                {report.implicitNormalCount.toLocaleString()}
              </span>
            </div>
            <div>
              GPT 응답 수정:{' '}
              <span className="text-slate-200 font-semibold tabular-nums">{report.editedCount.toLocaleString()}</span>
            </div>
            <div>
              검수 메모:{' '}
              <span className="text-slate-200 font-semibold tabular-nums">
                {report.withReviewerNotesCount.toLocaleString()}
              </span>
            </div>
          </div>

          <pre className="text-[11px] leading-relaxed text-slate-400 font-mono whitespace-pre-wrap bg-slate-950/60 border border-slate-800 rounded-xl p-3 max-h-48 overflow-auto">
            {reportText}
          </pre>
        </div>

        <div className="px-5 py-4 border-t border-slate-700 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-sm border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            닫기
          </button>
          <button
            type="button"
            onClick={() => onCopy(reportText)}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-sm border border-sky-500/40 text-sky-200 hover:bg-sky-500/10 disabled:opacity-40"
          >
            복사
          </button>
          <button
            type="button"
            onClick={() => onSaveText(reportText)}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-sm font-bold bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40"
          >
            {busy ? '저장 중…' : '텍스트 저장'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default VlmBriefReportModal;
