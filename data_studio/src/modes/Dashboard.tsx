import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_DETECTOR_ROOT, fetchYoloDashboard } from '../dashboardApi';
import type { YoloFolderStats, YoloLaunchRequest } from '../dashboardTypes';
import type { YoloWorkflowRole, YoloWorkflowStatus } from '../yoloMeta';
import { workflowStatusLabel } from '../yoloMeta';

const WORKFLOW_ROLE_KEY = 'intellivixYolo.workflowRoleV1';
const WORKFLOW_USER_KEY = 'intellivixYolo.workflowUserV1';

interface DashboardProps {
  onOpenYolo: (request: YoloLaunchRequest) => void;
}

function statusTone(status: YoloWorkflowStatus): string {
  switch (status) {
    case 'draft':
      return 'text-slate-300 bg-slate-500/15 border-slate-500/30';
    case 'submitted':
      return 'text-amber-200 bg-amber-400/15 border-amber-400/30';
    case 'approved':
      return 'text-emerald-200 bg-emerald-400/15 border-emerald-400/30';
    case 'rejected':
      return 'text-red-300 bg-red-400/15 border-red-400/30';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
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

const FolderCard: React.FC<{
  folder: YoloFolderStats;
  onOpen: (path: string, filter?: YoloWorkflowStatus) => void;
}> = ({ folder, onOpen }) => (
  <button
    type="button"
    onClick={() => onOpen(folder.folderPath)}
    className="glass-card text-left p-4 border border-white/10 hover:border-[var(--accent-lime)]/50 hover:shadow-[0_0_24px_rgba(168,230,27,0.12)] transition-all flex flex-col gap-3 min-h-[9rem]"
  >
    <div className="flex items-start justify-between gap-2">
      <h3 className="font-bold text-white truncate" title={folder.folderName}>
        {folder.folderName}
      </h3>
      <span className="text-xs tabular-nums text-slate-500 shrink-0">{folder.labelRate}%</span>
    </div>
    <div className="grid grid-cols-2 gap-2 text-xs">
      <div className="rounded-lg bg-white/5 px-2 py-1.5">
        <div className="text-slate-500">이미지</div>
        <div className="font-bold tabular-nums text-[var(--accent-blue)]">{folder.totalImages}</div>
      </div>
      <div className="rounded-lg bg-white/5 px-2 py-1.5">
        <div className="text-slate-500">라벨 있음</div>
        <div className="font-bold tabular-nums text-emerald-300">{folder.labeledImages}</div>
      </div>
    </div>
    <div className="flex flex-wrap gap-1.5">
      {(['draft', 'submitted', 'approved', 'rejected'] as const).map((status) => {
        const count = folder.byStatus[status] ?? 0;
        if (count === 0) return null;
        return (
          <span
            key={status}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium ${statusTone(status)}`}
          >
            {workflowStatusLabel(status)}
            <span className="tabular-nums">{count}</span>
          </span>
        );
      })}
    </div>
    <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
      {(folder.byStatus.submitted ?? 0) > 0 ? (
        <span
          role="presentation"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(folder.folderPath, 'submitted');
          }}
          className="text-[11px] px-2 py-0.5 rounded-md border border-amber-400/40 text-amber-200 hover:bg-amber-400/10 cursor-pointer"
        >
          검수대기 열기
        </span>
      ) : null}
      {(folder.byStatus.rejected ?? 0) > 0 ? (
        <span
          role="presentation"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(folder.folderPath, 'rejected');
          }}
          className="text-[11px] px-2 py-0.5 rounded-md border border-red-400/40 text-red-300 hover:bg-red-400/10 cursor-pointer"
        >
          반려 열기
        </span>
      ) : null}
    </div>
  </button>
);

const Dashboard: React.FC<DashboardProps> = ({ onOpenYolo }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof fetchYoloDashboard>> | null>(null);
  const [workflowRole, setWorkflowRole] = useState<YoloWorkflowRole>(() => {
    try {
      return localStorage.getItem(WORKFLOW_ROLE_KEY) === 'reviewer' ? 'reviewer' : 'worker';
    } catch {
      return 'worker';
    }
  });
  const [workflowUser, setWorkflowUser] = useState(() => {
    try {
      return localStorage.getItem(WORKFLOW_USER_KEY) || '';
    } catch {
      return '';
    }
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchYoloDashboard(DEFAULT_DETECTOR_ROOT);
      setSummary(data);
    } catch (err) {
      setError((err as Error).message || '대시보드 로드 실패');
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    try {
      localStorage.setItem(WORKFLOW_ROLE_KEY, workflowRole);
    } catch {
      /* ignore */
    }
  }, [workflowRole]);

  useEffect(() => {
    try {
      localStorage.setItem(WORKFLOW_USER_KEY, workflowUser);
    } catch {
      /* ignore */
    }
  }, [workflowUser]);

  const pendingFolders = useMemo(
    () => (summary?.folders ?? []).filter((f) => (f.byStatus.submitted ?? 0) > 0),
    [summary]
  );

  const rejectedFolders = useMemo(
    () => (summary?.folders ?? []).filter((f) => (f.byStatus.rejected ?? 0) > 0),
    [summary]
  );

  const sortedFolders = useMemo(() => {
    const folders = [...(summary?.folders ?? [])];
    if (workflowRole === 'reviewer') {
      return folders.sort(
        (a, b) =>
          (b.byStatus.submitted ?? 0) - (a.byStatus.submitted ?? 0) ||
          a.folderName.localeCompare(b.folderName, undefined, { numeric: true })
      );
    }
    if (workflowRole === 'worker') {
      return folders.sort(
        (a, b) =>
          (b.byStatus.rejected ?? 0) - (a.byStatus.rejected ?? 0) ||
          a.folderName.localeCompare(b.folderName, undefined, { numeric: true })
      );
    }
    return folders.sort((a, b) => a.folderName.localeCompare(b.folderName, undefined, { numeric: true }));
  }, [summary, workflowRole]);

  const openFolder = (folderPath: string, statusFilter?: YoloWorkflowStatus) => {
    onOpenYolo({ folderPath, statusFilter });
  };

  return (
    <div className="flex-1 min-h-0 overflow-auto" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <div className="max-w-6xl mx-auto p-5 sm:p-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-white">YOLO 라벨링 현황</h1>
            <p className="text-sm text-slate-400 mt-1">
              {DEFAULT_DETECTOR_ROOT} 하위 프로젝트 폴더별 작업·검수 상태
            </p>
            {summary?.scannedAt ? (
              <p className="text-xs text-slate-500 mt-1">마지막 스캔: {formatWhen(summary.scannedAt)}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={workflowRole}
              onChange={(e) => setWorkflowRole(e.target.value === 'reviewer' ? 'reviewer' : 'worker')}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 border border-white/10 text-sm text-white"
            >
              <option value="worker">작업자</option>
              <option value="reviewer">검수자</option>
            </select>
            <input
              type="text"
              value={workflowUser}
              onChange={(e) => setWorkflowUser(e.target.value)}
              placeholder="이름"
              className="w-28 px-2.5 py-1.5 rounded-lg bg-slate-800 border border-white/10 text-sm text-white placeholder:text-slate-600"
            />
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="px-3 py-1.5 rounded-xl glass border border-white/10 text-sm text-[var(--accent-blue)] hover:border-[var(--accent-blue)] disabled:opacity-40"
            >
              {loading ? '스캔 중…' : '새로고침'}
            </button>
          </div>
        </div>

        {error ? (
          <div className="glass-card p-4 border border-red-400/30 text-red-300 text-sm">{error}</div>
        ) : null}

        {loading && !summary ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-10 h-10 border-2 border-[var(--accent-lime)] border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-slate-400">폴더를 스캔하는 중…</p>
          </div>
        ) : summary ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="glass-card p-4 border border-white/10">
                <p className="text-[11px] uppercase tracking-wider text-slate-500">총 이미지</p>
                <p className="text-2xl font-bold tabular-nums text-[var(--accent-blue)]">{summary.totals.totalImages}</p>
              </div>
              <div className="glass-card p-4 border border-white/10">
                <p className="text-[11px] uppercase tracking-wider text-slate-500">라벨률</p>
                <p className="text-2xl font-bold tabular-nums text-[var(--accent-lime)]">{summary.totals.labelRate}%</p>
              </div>
              <div className="glass-card p-4 border border-white/10">
                <p className="text-[11px] uppercase tracking-wider text-slate-500">검수 대기</p>
                <p className="text-2xl font-bold tabular-nums text-amber-300">{summary.totals.pendingReview}</p>
              </div>
              <div className="glass-card p-4 border border-white/10">
                <p className="text-[11px] uppercase tracking-wider text-slate-500">반려</p>
                <p className="text-2xl font-bold tabular-nums text-red-300">{summary.totals.rejected}</p>
              </div>
            </div>

            {workflowRole === 'reviewer' && pendingFolders.length > 0 ? (
              <section className="glass-card p-4 border border-amber-400/25">
                <h2 className="text-sm font-bold text-amber-200 mb-3">검수 대기 ({summary.totals.pendingReview}건)</h2>
                <ul className="space-y-2">
                  {pendingFolders.map((folder) => (
                    <li key={folder.folderPath}>
                      <button
                        type="button"
                        onClick={() => openFolder(folder.folderPath, 'submitted')}
                        className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl hover:bg-white/5 border border-transparent hover:border-amber-400/30 text-left transition-colors"
                      >
                        <span className="font-medium text-white truncate">{folder.folderName}</span>
                        <span className="shrink-0 text-sm tabular-nums text-amber-200">
                          {folder.byStatus.submitted}건
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {workflowRole === 'worker' && rejectedFolders.length > 0 ? (
              <section className="glass-card p-4 border border-red-400/25">
                <h2 className="text-sm font-bold text-red-300 mb-3">반려된 작업 ({summary.totals.rejected}건)</h2>
                <ul className="space-y-2">
                  {rejectedFolders.map((folder) => (
                    <li key={folder.folderPath}>
                      <button
                        type="button"
                        onClick={() => openFolder(folder.folderPath, 'rejected')}
                        className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl hover:bg-white/5 border border-transparent hover:border-red-400/30 text-left transition-colors"
                      >
                        <span className="font-medium text-white truncate">{folder.folderName}</span>
                        <span className="shrink-0 text-sm tabular-nums text-red-300">
                          {folder.byStatus.rejected}건
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section>
              <h2 className="text-sm font-bold text-slate-300 mb-3">프로젝트 폴더</h2>
              {sortedFolders.length === 0 ? (
                <div className="glass-card p-8 text-center text-slate-400 text-sm">
                  {DEFAULT_DETECTOR_ROOT} 아래 프로젝트 폴더가 없습니다.
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {sortedFolders.map((folder) => (
                    <FolderCard key={folder.folderPath} folder={folder} onOpen={openFolder} />
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
};

export default Dashboard;
