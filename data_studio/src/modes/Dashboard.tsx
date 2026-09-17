import React, { useCallback, useEffect, useMemo, useState } from 'react';
import DashboardFolderTree from '../components/DashboardFolderTree';
import {
  DEFAULT_DETECTOR_ROOT,
  DEFAULT_VLM_ROOT,
  fetchVlmDashboard,
  fetchYoloDashboard,
} from '../dashboardApi';
import type {
  VlmDashboardSummary,
  VlmFolderStats,
  VlmLaunchRequest,
  YoloFolderStats,
  YoloLaunchRequest,
} from '../dashboardTypes';
import type { YoloWorkflowStatus } from '../yoloMeta';
import type { LabelAccessRole } from '../accessControl';
import { workflowStatusLabel } from '../yoloMeta';

const DASHBOARD_TAB_KEY = 'intellivixDashboard.tabV1';

type DashboardTab = 'yolo' | 'vlm';

interface DashboardSummaryView {
  scannedAt: string;
  folders: YoloFolderStats[];
  totals: {
    totalImages: number;
    labeledImages: number;
    labelRate: number;
    pendingReview: number;
    rejected: number;
  };
}

interface DashboardProps {
  accessRole: LabelAccessRole;
  availableRoles: LabelAccessRole[];
  onAccessRoleChange: (role: LabelAccessRole) => void;
  workflowUser: string;
  onOpenYolo: (request: YoloLaunchRequest) => void;
  onOpenVlm: (request: VlmLaunchRequest) => void;
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

const YoloFolderCard: React.FC<{
  folder: YoloFolderStats;
  onOpen: (path: string, filter?: YoloWorkflowStatus) => void;
}> = ({ folder, onOpen }) => {
  const accent = 'lime';
  const countLabel = '이미지';
  const hoverBorder = accent === 'lime' ? 'hover:border-[var(--accent-lime)]/50' : 'hover:border-[var(--accent-purple)]/50';
  const hoverShadow =
    accent === 'lime'
      ? 'hover:shadow-[0_0_24px_rgba(168,230,27,0.12)]'
      : 'hover:shadow-[0_0_24px_rgba(176,142,212,0.15)]';

  return (
    <button
      type="button"
      onClick={() => onOpen(folder.folderPath)}
      className={`glass-card text-left p-4 border border-white/10 ${hoverBorder} ${hoverShadow} transition-all flex flex-col gap-3 min-h-[9rem]`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-bold text-white truncate" title={folder.folderName}>
          {folder.folderName}
        </h3>
        <span className="text-xs tabular-nums text-slate-500 shrink-0">{folder.labelRate}%</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-white/5 px-2 py-1.5">
          <div className="text-slate-500">{countLabel}</div>
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
};

const VlmFolderCard: React.FC<{
  folder: VlmFolderStats;
  onOpen: (path: string, filter?: YoloWorkflowStatus) => void;
}> = ({ folder, onOpen }) => (
  <button
    type="button"
    onClick={() => onOpen(folder.folderPath)}
    className="glass-card text-left p-4 border border-white/10 hover:border-[var(--accent-purple)]/50 hover:shadow-[0_0_24px_rgba(176,142,212,0.15)] transition-all flex flex-col gap-3 min-h-[9rem]"
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
        <div className="font-bold tabular-nums text-[var(--accent-blue)]">{folder.imageCount}</div>
        <div className="text-[10px] text-slate-500 mt-0.5 tabular-nums">
          라벨 {folder.labeledImageCount} ({folder.imageLabelRate}%)
        </div>
      </div>
      <div className="rounded-lg bg-white/5 px-2 py-1.5">
        <div className="text-slate-500">영상</div>
        <div className="font-bold tabular-nums text-violet-300">{folder.videoCount}</div>
        <div className="text-[10px] text-slate-500 mt-0.5 tabular-nums">
          라벨 {folder.labeledVideoCount} ({folder.videoLabelRate}%)
        </div>
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

const LabelingDashboardPanel: React.FC<{
  summary: DashboardSummaryView | null;
  loading: boolean;
  error: string | null;
  emptyMessage: string;
  workflowRole: LabelAccessRole;
  accent: 'lime' | 'purple';
  countLabel: string;
  totalStatLabel: string;
  onOpenFolder: (folderPath: string, statusFilter?: YoloWorkflowStatus) => void;
}> = ({
  summary,
  loading,
  error,
  emptyMessage,
  workflowRole,
  accent,
  countLabel,
  totalStatLabel,
  onOpenFolder,
}) => {
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

  if (error) {
    return <div className="glass-card p-4 border border-red-400/30 text-red-300 text-sm">{error}</div>;
  }

  if (loading && !summary) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div
          className={`w-10 h-10 border-2 ${accent === 'lime' ? 'border-[var(--accent-lime)]' : 'border-[var(--accent-purple)]'} border-t-transparent rounded-full animate-spin`}
        />
        <p className="text-sm text-slate-400">폴더를 스캔하는 중…</p>
      </div>
    );
  }

  if (!summary) return null;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass-card p-4 border border-white/10">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">{totalStatLabel}</p>
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
                  onClick={() => onOpenFolder(folder.folderPath, 'submitted')}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl hover:bg-white/5 border border-transparent hover:border-amber-400/30 text-left transition-colors"
                >
                  <span className="font-medium text-white truncate">{folder.folderName}</span>
                  <span className="shrink-0 text-sm tabular-nums text-amber-200">{folder.byStatus.submitted}건</span>
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
                  onClick={() => onOpenFolder(folder.folderPath, 'rejected')}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl hover:bg-white/5 border border-transparent hover:border-red-400/30 text-left transition-colors"
                >
                  <span className="font-medium text-white truncate">{folder.folderName}</span>
                  <span className="shrink-0 text-sm tabular-nums text-red-300">{folder.byStatus.rejected}건</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-sm font-bold text-slate-300 mb-3">프로젝트 폴더</h2>
        {sortedFolders.length === 0 ? (
          <div className="glass-card p-8 text-center text-slate-400 text-sm">{emptyMessage}</div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {sortedFolders.map((folder) => (
              <YoloFolderCard key={folder.folderPath} folder={folder} onOpen={onOpenFolder} />
            ))}
          </div>
        )}
      </section>
    </>
  );
};

const VlmDashboardPanel: React.FC<{
  summary: VlmDashboardSummary | null;
  loading: boolean;
  error: string | null;
  emptyMessage: string;
  workflowRole: LabelAccessRole;
  onOpenFolder: (folderPath: string, statusFilter?: YoloWorkflowStatus) => void;
}> = ({ summary, loading, error, emptyMessage, workflowRole, onOpenFolder }) => {
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

  if (error) {
    return <div className="glass-card p-4 border border-red-400/30 text-red-300 text-sm">{error}</div>;
  }

  if (loading && !summary) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="w-10 h-10 border-2 border-[var(--accent-purple)] border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-slate-400">폴더를 스캔하는 중…</p>
      </div>
    );
  }

  if (!summary) return null;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="glass-card p-4 border border-white/10">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">총 이미지</p>
          <p className="text-2xl font-bold tabular-nums text-[var(--accent-blue)]">{summary.totals.imageCount}</p>
          <p className="text-[11px] text-slate-500 mt-1 tabular-nums">
            라벨 {summary.totals.labeledImageCount} ({summary.totals.imageLabelRate}%)
          </p>
        </div>
        <div className="glass-card p-4 border border-white/10">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">총 영상</p>
          <p className="text-2xl font-bold tabular-nums text-violet-300">{summary.totals.videoCount}</p>
          <p className="text-[11px] text-slate-500 mt-1 tabular-nums">
            라벨 {summary.totals.labeledVideoCount} ({summary.totals.videoLabelRate}%)
          </p>
        </div>
        <div className="glass-card p-4 border border-white/10">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">전체 라벨률</p>
          <p className="text-2xl font-bold tabular-nums text-[var(--accent-lime)]">{summary.totals.labelRate}%</p>
        </div>
        <div className="glass-card p-4 border border-white/10">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">검수 대기</p>
          <p className="text-2xl font-bold tabular-nums text-amber-300">{summary.totals.pendingReview}</p>
        </div>
        <div className="glass-card p-4 border border-white/10 col-span-2 sm:col-span-1">
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
                  onClick={() => onOpenFolder(folder.folderPath, 'submitted')}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl hover:bg-white/5 border border-transparent hover:border-amber-400/30 text-left transition-colors"
                >
                  <span className="font-medium text-white truncate">{folder.folderName}</span>
                  <span className="shrink-0 text-sm tabular-nums text-amber-200">{folder.byStatus.submitted}건</span>
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
                  onClick={() => onOpenFolder(folder.folderPath, 'rejected')}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl hover:bg-white/5 border border-transparent hover:border-red-400/30 text-left transition-colors"
                >
                  <span className="font-medium text-white truncate">{folder.folderName}</span>
                  <span className="shrink-0 text-sm tabular-nums text-red-300">{folder.byStatus.rejected}건</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-sm font-bold text-slate-300 mb-3">프로젝트 폴더</h2>
        {sortedFolders.length === 0 ? (
          <div className="glass-card p-8 text-center text-slate-400 text-sm">{emptyMessage}</div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {sortedFolders.map((folder) => (
              <VlmFolderCard key={folder.folderPath} folder={folder} onOpen={onOpenFolder} />
            ))}
          </div>
        )}
      </section>
    </>
  );
};

const Dashboard: React.FC<DashboardProps> = ({ accessRole, availableRoles, onAccessRoleChange, workflowUser, onOpenYolo, onOpenVlm }) => {
  const [tab, setTab] = useState<DashboardTab>(() => {
    try {
      return localStorage.getItem(DASHBOARD_TAB_KEY) === 'vlm' ? 'vlm' : 'yolo';
    } catch {
      return 'yolo';
    }
  });
  const [yoloLoading, setYoloLoading] = useState(true);
  const [vlmLoading, setVlmLoading] = useState(true);
  const [yoloError, setYoloError] = useState<string | null>(null);
  const [vlmError, setVlmError] = useState<string | null>(null);
  const [yoloSummary, setYoloSummary] = useState<DashboardSummaryView | null>(null);
  const [vlmSummary, setVlmSummary] = useState<VlmDashboardSummary | null>(null);
  const [yoloScanRoot, setYoloScanRoot] = useState(DEFAULT_DETECTOR_ROOT);
  const [vlmScanRoot, setVlmScanRoot] = useState(DEFAULT_VLM_ROOT);
  const workflowRole = accessRole;


  const loadYolo = useCallback(async () => {
    setYoloLoading(true);
    setYoloError(null);
    try {
      const data = await fetchYoloDashboard(yoloScanRoot);
      setYoloSummary(data);
    } catch (err) {
      setYoloError((err as Error).message || 'Detector 대시보드 로드 실패');
      setYoloSummary(null);
    } finally {
      setYoloLoading(false);
    }
  }, [yoloScanRoot]);

  const loadVlm = useCallback(async () => {
    setVlmLoading(true);
    setVlmError(null);
    try {
      const data = await fetchVlmDashboard(vlmScanRoot);
      setVlmSummary(data);
    } catch (err) {
      setVlmError((err as Error).message || 'VLM 대시보드 로드 실패');
      setVlmSummary(null);
    } finally {
      setVlmLoading(false);
    }
  }, [vlmScanRoot]);

  const loadAll = useCallback(async () => {
    await Promise.all([loadYolo(), loadVlm()]);
  }, [loadYolo, loadVlm]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    try {
      localStorage.setItem(DASHBOARD_TAB_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);



  const activeSummary = tab === 'yolo' ? yoloSummary : vlmSummary;
  const activeLoading = tab === 'yolo' ? yoloLoading : vlmLoading;
  const activeScanRoot = tab === 'yolo' ? yoloScanRoot : vlmScanRoot;

  const openYoloFolder = (folderPath: string, statusFilter?: YoloWorkflowStatus) => {
    onOpenYolo({ folderPath, statusFilter });
  };

  const openVlmFolder = (folderPath: string, statusFilter?: YoloWorkflowStatus) => {
    onOpenVlm({ folderPath, statusFilter });
  };

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <DashboardFolderTree
        key={tab}
        rootPath={tab === 'yolo' ? DEFAULT_DETECTOR_ROOT : DEFAULT_VLM_ROOT}
        selectedPath={activeScanRoot}
        onSelect={tab === 'yolo' ? setYoloScanRoot : setVlmScanRoot}
        accent={tab === 'yolo' ? 'lime' : 'purple'}
      />
      <div className="flex-1 min-h-0 overflow-auto">
      <div className="max-w-6xl mx-auto p-5 sm:p-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-white">라벨링 현황</h1>
            <p className="text-sm text-slate-400 mt-1">
              {tab === 'yolo'
                ? `${activeScanRoot} 하위 폴더별 작업·검수 상태`
                : `${activeScanRoot} 하위 카테고리·폴더별 작업·검수 상태`}
            </p>
            {activeSummary?.scannedAt ? (
              <p className="text-xs text-slate-500 mt-1">마지막 스캔: {formatWhen(activeSummary.scannedAt)}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {availableRoles.length > 1 ? (
              <label className="sr-only" htmlFor="workflow-role-select">작업 역할 선택</label>
            ) : null}
            {availableRoles.length > 1 ? (
              <select
                id="workflow-role-select"
                value={workflowRole}
                onChange={(event) => onAccessRoleChange(event.target.value as LabelAccessRole)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 border border-white/10 text-sm text-white"
                aria-label="작업 역할 선택"
              >
                {availableRoles.includes('worker') ? <option value="worker">작업자</option> : null}
                {availableRoles.includes('reviewer') ? <option value="reviewer">검수자</option> : null}
              </select>
            ) : (
              <span className="px-3 py-1.5 rounded-lg bg-slate-800 border border-white/10 text-sm text-white">
                {workflowRole === 'reviewer' ? '검수자' : workflowRole === 'worker' ? '작업자' : '조회 전용'}
              </span>
            )}
            {workflowUser ? <span className="text-sm text-slate-400">{workflowUser}</span> : null}
            <button
              type="button"
              onClick={() => void loadAll()}
              disabled={yoloLoading || vlmLoading}
              className="px-3 py-1.5 rounded-xl glass border border-white/10 text-sm text-[var(--accent-blue)] hover:border-[var(--accent-blue)] disabled:opacity-40"
            >
              {yoloLoading || vlmLoading ? '스캔 중…' : '새로고침'}
            </button>
          </div>
        </div>

        <div className="flex rounded-xl p-0.5 glass border border-white/10 w-fit" role="tablist" aria-label="대시보드 종류">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'yolo'}
            onClick={() => setTab('yolo')}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${tab === 'yolo' ? 'bg-[var(--accent-lime)] text-[#1A1A2E]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
          >
            Detector
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'vlm'}
            onClick={() => setTab('vlm')}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${tab === 'vlm' ? 'bg-[var(--accent-purple)]/90 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
          >
            VLM
          </button>
        </div>

        {tab === 'yolo' ? (
          <LabelingDashboardPanel
            summary={yoloSummary}
            loading={yoloLoading}
            error={yoloError}
            emptyMessage={`${DEFAULT_DETECTOR_ROOT} 아래 프로젝트 폴더가 없습니다.`}
            workflowRole={workflowRole}
            accent="lime"
            countLabel="이미지"
            totalStatLabel="총 이미지"
            onOpenFolder={openYoloFolder}
          />
        ) : (
          <VlmDashboardPanel
            summary={vlmSummary}
            loading={vlmLoading}
            error={vlmError}
            emptyMessage={`${DEFAULT_VLM_ROOT} 아래 images/videos/generated 카테고리가 없습니다.`}
            workflowRole={workflowRole}
            onOpenFolder={openVlmFolder}
          />
        )}
      </div>
      </div>
    </div>
  );
};

export default Dashboard;
