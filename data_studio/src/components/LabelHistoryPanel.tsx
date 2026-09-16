import React, { useMemo, useState } from 'react';
import type { YoloChangeEntry } from '../yoloMeta';

interface LabelHistoryPanelProps {
  history: YoloChangeEntry[];
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function diffLines(before: string, after: string): { kind: 'same' | 'remove' | 'add'; text: string }[] {
  const beforeParts = before.split(/\r?\n/);
  const afterParts = after.split(/\r?\n/);
  const max = Math.max(beforeParts.length, afterParts.length);
  const rows: { kind: 'same' | 'remove' | 'add'; text: string }[] = [];
  for (let i = 0; i < max; i += 1) {
    const b = beforeParts[i];
    const a = afterParts[i];
    if (b === a) {
      if (b !== undefined && b !== '') rows.push({ kind: 'same', text: b });
      continue;
    }
    if (b !== undefined && b !== '') rows.push({ kind: 'remove', text: b });
    if (a !== undefined && a !== '') rows.push({ kind: 'add', text: a });
  }
  return rows;
}

const LabelHistoryPanel: React.FC<LabelHistoryPanelProps> = ({ history }) => {
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);

  const sorted = useMemo(
    () => [...history].sort((a, b) => b.revision - a.revision),
    [history]
  );

  const selected = sorted.find((entry) => entry.revision === selectedRevision) ?? null;

  const labelDiff = useMemo(() => {
    if (!selected) return null;
    const beforeTxt =
      typeof selected.before.labelTxt === 'string'
        ? selected.before.labelTxt
        : typeof selected.before.vlmJson === 'string'
          ? selected.before.vlmJson
          : '';
    const afterTxt =
      typeof selected.after.labelTxt === 'string'
        ? selected.after.labelTxt
        : typeof selected.after.vlmJson === 'string'
          ? selected.after.vlmJson
          : '';
    if (!beforeTxt && !afterTxt) return null;
    return diffLines(beforeTxt, afterTxt);
  }, [selected]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2.5 border-b border-white/10">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-slate-400">변경 이력</h3>
      </div>
      <div className="flex-1 overflow-auto min-h-0 p-2 space-y-1">
        {sorted.length === 0 ? (
          <p className="text-xs text-slate-500 px-1 py-4 text-center">아직 기록된 이력이 없습니다.</p>
        ) : (
          sorted.map((entry) => {
            const active = selectedRevision === entry.revision;
            return (
              <button
                key={entry.revision}
                type="button"
                onClick={() => setSelectedRevision(active ? null : entry.revision)}
                className={`w-full text-left px-2.5 py-2 rounded-xl border transition-colors ${
                  active
                    ? 'border-[var(--accent-purple)]/60 bg-[var(--accent-purple)]/15'
                    : 'border-transparent hover:border-white/10 hover:bg-white/5'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-500 tabular-nums">{formatWhen(entry.at)}</span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">rev {entry.revision}</span>
                </div>
                <div className="mt-0.5 text-sm text-slate-200 truncate" title={entry.summary}>
                  <span className="text-slate-400">{entry.by || '—'}</span>
                  <span className="mx-1 text-slate-600">·</span>
                  {entry.summary}
                </div>
              </button>
            );
          })
        )}
      </div>
      {selected && (
        <div className="border-t border-white/10 p-3 max-h-[45%] overflow-auto shrink-0">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-2">
            Before / After — rev {selected.revision}
          </div>
          {labelDiff ? (
            <pre className="text-[11px] leading-relaxed font-mono rounded-lg bg-black/40 p-2 border border-white/10 whitespace-pre-wrap break-all">
              {labelDiff.map((row, idx) => (
                <div
                  key={`${row.kind}-${idx}`}
                  className={
                    row.kind === 'remove'
                      ? 'text-red-300 bg-red-500/10'
                      : row.kind === 'add'
                        ? 'text-emerald-300 bg-emerald-500/10'
                        : 'text-slate-400'
                  }
                >
                  {row.kind === 'remove' ? '- ' : row.kind === 'add' ? '+ ' : '  '}
                  {row.text}
                </div>
              ))}
            </pre>
          ) : (
            <div className="text-xs text-slate-400 space-y-2">
              <div>
                <div className="text-slate-500 mb-0.5">Before</div>
                <pre className="rounded-lg bg-black/30 p-2 border border-white/10 whitespace-pre-wrap break-all">
                  {JSON.stringify(selected.before, null, 2)}
                </pre>
              </div>
              <div>
                <div className="text-slate-500 mb-0.5">After</div>
                <pre className="rounded-lg bg-black/30 p-2 border border-white/10 whitespace-pre-wrap break-all">
                  {JSON.stringify(selected.after, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LabelHistoryPanel;
