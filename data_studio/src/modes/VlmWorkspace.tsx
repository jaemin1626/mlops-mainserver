import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LabelHistoryPanel from '../components/LabelHistoryPanel';
import VlmReviewPanel from '../components/VlmReviewPanel';
import WorkflowNavigateModal from '../components/WorkflowNavigateModal';
import { useWorkflowNavGate } from '../useWorkflowNavGate';
import type { VlmLaunchRequest } from '../dashboardTypes';
import type { LabelAccessRole } from '../accessControl';
import WorkflowRoleSelect from '../components/WorkflowRoleSelect';
import type { OfflineImageItem } from '../electron.d';
import type { VlmDraftPayload } from '../vlmMerge';
import type { VlmOfflineTask } from '../vlmTypes';
import { buildPerImageJsonFileContent, parsePerImageJsonFile } from '../vlmPerImage';
import { inferVlmMediaType } from '../vlmMedia';
import {
  appendVlmJsonSaveHistory,
  canEditLabels,
  loadYoloMeta,
  saveYoloMeta,
  transitionApprove,
  transitionReject,
  transitionSubmit,
  workflowMetaPathForMedia,
  workflowStatusLabel,
  type YoloImageMeta,
  type YoloWorkflowRole,
  type YoloWorkflowStatus,
} from '../yoloMeta';

const VLM_AUTO_SAVE_STORAGE_KEY = 'vlm-auto-save-v1';
const WORKFLOW_ROLE_KEY = 'intellivixYolo.workflowRoleV1';
const WORKFLOW_USER_KEY = 'intellivixYolo.workflowUserV1';
const WORKFLOW_STATUS_FILTER_KEY = 'intellivixVlm.workflowStatusFilterV1';

const STATUS_FILTER_OPTIONS: { value: 'all' | YoloWorkflowStatus; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'draft', label: '작업중' },
  { value: 'submitted', label: '검수대기' },
  { value: 'approved', label: '승인' },
  { value: 'rejected', label: '반려' },
];

function workflowStatusBadgeClass(status: YoloWorkflowStatus): string {
  switch (status) {
    case 'draft':
      return 'border-slate-500/40 bg-slate-500/15 text-slate-300';
    case 'submitted':
      return 'border-amber-400/40 bg-amber-400/15 text-amber-200';
    case 'approved':
      return 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200';
    case 'rejected':
      return 'border-red-400/40 bg-red-400/15 text-red-300';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

interface VlmWorkspaceProps {
  accessRole: LabelAccessRole;
  availableRoles: LabelAccessRole[];
  onAccessRoleChange: (role: LabelAccessRole) => void;
  workflowUser: string;
  launchRequest?: VlmLaunchRequest | null;
  onLaunchConsumed?: () => void;
}

const VlmWorkspace: React.FC<VlmWorkspaceProps> = ({
  accessRole,
  availableRoles,
  onAccessRoleChange,
  workflowUser,
  launchRequest = null,
  onLaunchConsumed,
}) => {
  const [workFolderPath, setWorkFolderPath] = useState<string | null>(null);
  const [imageList, setImageList] = useState<OfflineImageItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [task, setTask] = useState<VlmOfflineTask | null>(null);
  const [displayMeta, setDisplayMeta] = useState<YoloImageMeta | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [gotoInput, setGotoInput] = useState('');
  const [autoSave, setAutoSave] = useState(() => {
    try {
      return localStorage.getItem(VLM_AUTO_SAVE_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  });

  const workflowRole: YoloWorkflowRole = accessRole === 'reviewer' ? 'reviewer' : 'worker';
  const [statusFilter, setStatusFilter] = useState<'all' | YoloWorkflowStatus>(() => {
    try {
      const stored = localStorage.getItem(WORKFLOW_STATUS_FILTER_KEY);
      if (stored === 'draft' || stored === 'submitted' || stored === 'approved' || stored === 'rejected') {
        return stored;
      }
      return 'all';
    } catch {
      return 'all';
    }
  });
  const [statusFilteredNavIndices, setStatusFilteredNavIndices] = useState<number[] | null>(null);
  const [statusFilterLoading, setStatusFilterLoading] = useState(false);
  const [statusFilterScanKey, setStatusFilterScanKey] = useState(0);

  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mergeFilterApproved, setMergeFilterApproved] = useState(true);
  const [isMergeExporting, setIsMergeExporting] = useState(false);
  const [mergeProgress, setMergeProgress] = useState<{ done: number; total: number } | null>(null);

  const draftRef = useRef<VlmDraftPayload | null>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);
  const imageListRef = useRef(imageList);
  const currentIndexRef = useRef(currentIndex);
  const lastSavedJsonRef = useRef('');
  const taskSourceRef = useRef('');
  imageListRef.current = imageList;
  currentIndexRef.current = currentIndex;

  const imageListScanKey = useMemo(
    () => `${imageList.length}\n${imageList.map((item) => item.imagePath).join('\n')}`,
    [imageList]
  );

  const navIndices = useMemo(() => {
    if (statusFilter === 'all') return imageList.map((_, i) => i);
    if (statusFilteredNavIndices === null) return [];
    return statusFilteredNavIndices;
  }, [imageList, statusFilter, statusFilteredNavIndices]);

  const isStatusFilterScanning = statusFilter !== 'all' && (statusFilterLoading || statusFilteredNavIndices === null);
  const navCount = navIndices.length;
  const absoluteIndex = navCount > 0 ? (navIndices[Math.min(currentIndex, navCount - 1)] ?? 0) : -1;
  const currentItem = absoluteIndex >= 0 ? (imageList[absoluteIndex] ?? null) : null;

  useEffect(() => {
    try {
      localStorage.setItem(VLM_AUTO_SAVE_STORAGE_KEY, autoSave ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [autoSave]);



  useEffect(() => {
    try {
      localStorage.setItem(WORKFLOW_STATUS_FILTER_KEY, statusFilter);
    } catch {
      /* ignore */
    }
  }, [statusFilter]);

  useEffect(() => {
    if (statusFilter === 'all') {
      setStatusFilteredNavIndices(null);
      setStatusFilterLoading(false);
      return;
    }
    const list = imageListRef.current;
    if (!window.electron || list.length === 0) {
      setStatusFilteredNavIndices([]);
      setStatusFilterLoading(false);
      setCurrentIndex(0);
      return;
    }
    let cancelled = false;
    setStatusFilteredNavIndices(null);
    setStatusFilterLoading(true);
    (async () => {
      const indices: number[] = [];
      for (let i = 0; i < list.length; i++) {
        if (cancelled) return;
        try {
          const meta = await loadYoloMeta((p) => window.electron!.readJsonFile(p), list[i].imagePath);
          if (meta.workflowStatus === statusFilter) indices.push(i);
        } catch {
          if (statusFilter === 'draft') indices.push(i);
        }
      }
      if (cancelled) return;
      setStatusFilteredNavIndices(indices);
      setStatusFilterLoading(false);
      setCurrentIndex((prev) => Math.min(prev, Math.max(0, indices.length - 1)));
    })();
    return () => {
      cancelled = true;
    };
  }, [statusFilter, imageListScanKey, statusFilterScanKey]);

  useEffect(() => {
    if (navCount === 0) return;
    if (currentIndex >= navCount) setCurrentIndex(navCount - 1);
  }, [navCount, currentIndex]);

  const loadTaskForIndex = useCallback(async (index: number, list: OfflineImageItem[]) => {
    const item = list[index];
    if (!item || !window.electron) return;
    let sourceData = parsePerImageJsonFile('', item.imagePath, index);
    const jsonRes = await window.electron.readJsonFile(item.jsonPath);
    if (jsonRes.ok && jsonRes.text) {
      sourceData = parsePerImageJsonFile(jsonRes.text, item.imagePath, index);
    }
    const meta = await loadYoloMeta((p) => window.electron!.readJsonFile(p), item.imagePath);
    lastSavedJsonRef.current = jsonRes.ok && jsonRes.text ? jsonRes.text : '';
    taskSourceRef.current = sourceData;
    setDisplayMeta(meta);
    setTask({
      id: item.jsonPath,
      name: item.name,
      sourceData,
      listItemIndex: String(index).padStart(7, '0'),
      sourceRefId: item.name,
      sourceFile: item.jsonPath,
    });
    setStatusMessage(`${index + 1}/${list.length}: ${item.name}`);
  }, []);

  useEffect(() => {
    if (!workFolderPath || !currentItem || !window.electron || absoluteIndex < 0) return;
    let cancelled = false;
    void loadTaskForIndex(absoluteIndex, imageList).then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [workFolderPath, absoluteIndex, currentItem?.imagePath, imageList, loadTaskForIndex]);

  useEffect(() => {
    if (imageList.length === 0) {
      setTask(null);
      setDisplayMeta(null);
      lastSavedJsonRef.current = '';
    }
  }, [imageList]);

  const persistCurrent = useCallback(
    async (payload: VlmDraftPayload, index = absoluteIndex >= 0 ? absoluteIndex : currentIndexRef.current): Promise<boolean> => {
      const list = imageListRef.current;
      const item = list[index];
      if (!item || !window.electron) return false;
      const beforeJson = lastSavedJsonRef.current;
      const body = buildPerImageJsonFileContent(taskSourceRef.current || task?.sourceData || '', payload, item.imagePath, index);
      const ok = await window.electron.writeJsonFile(item.jsonPath, body);
      if (!ok) {
        setStatusMessage(`저장 실패: ${item.name}`);
        window.alert(
          [
            `JSON 저장에 실패했습니다: ${item.name}`,
            '작업 폴더에 쓰기 권한이 없거나 읽기 전용일 수 있습니다.',
            '',
            `대상 파일: ${item.jsonPath}`,
          ].join('\n')
        );
        return false;
      }
      const actor = workflowUser.trim();
      if (actor && beforeJson !== body) {
        try {
          const meta = await loadYoloMeta((p) => window.electron!.readJsonFile(p), item.imagePath);
          const updated = appendVlmJsonSaveHistory(meta, actor, workflowRole, beforeJson, body);
          if (updated) {
            const metaOk = await saveYoloMeta(
              (p, c) => window.electron!.writeJsonFile(p, c),
              item.imagePath,
              updated
            );
            if (metaOk) setDisplayMeta(updated);
          }
        } catch {
          /* best-effort */
        }
      }
      lastSavedJsonRef.current = body;
      taskSourceRef.current = parsePerImageJsonFile(body, item.imagePath, index);
      setStatusMessage(`저장됨: ${item.name}`);
      return true;
    },
    [absoluteIndex, task?.sourceData, workflowRole, workflowUser]
  );

  const handleSave = useCallback(
    async (payload: VlmDraftPayload) => {
      setIsSaving(true);
      try {
        await persistCurrent(payload);
      } finally {
        setIsSaving(false);
      }
    },
    [persistCurrent]
  );

  const saveBeforeNavigate = useCallback(async () => {
    if (!autoSave || !draftRef.current) return true;
    return persistCurrent(draftRef.current);
  }, [autoSave, persistCurrent]);

  const requireWorkflowUser = useCallback((): string | null => {
    const name = workflowUser.trim();
    if (!name) {
      window.alert('역할 옆에 이름을 입력해 주세요.');
      return null;
    }
    return name;
  }, [workflowUser]);

  const persistWorkflowMeta = useCallback(
    async (next: YoloImageMeta) => {
      if (!window.electron || !currentItem) return false;
      const ok = await saveYoloMeta(
        (p, c) => window.electron!.writeJsonFile(p, c),
        currentItem.imagePath,
        next
      );
      if (!ok) {
        setStatusMessage('메타 저장 실패 (.meta.json)');
        return false;
      }
      setDisplayMeta(next);
      if (statusFilter !== 'all') setStatusFilterScanKey((k) => k + 1);
      return true;
    },
    [currentItem, statusFilter]
  );

  const handleSubmitForReview = useCallback(async (): Promise<boolean> => {
    if (!currentItem || !window.electron) return false;
    const actor = requireWorkflowUser();
    if (!actor) return false;
    if (autoSave && draftRef.current) {
      const ok = await persistCurrent(draftRef.current);
      if (!ok) return false;
    }
    const meta = await loadYoloMeta((p) => window.electron!.readJsonFile(p), currentItem.imagePath);
    const next = transitionSubmit(meta, actor);
    if (next.workflowStatus === meta.workflowStatus) {
      setStatusMessage('검수 요청할 수 없는 상태입니다.');
      return false;
    }
    if (await persistWorkflowMeta(next)) {
      setStatusMessage('검수 요청됨');
      return true;
    }
    return false;
  }, [autoSave, currentItem, persistCurrent, persistWorkflowMeta, requireWorkflowUser]);

  const handleApprove = useCallback(async (): Promise<boolean> => {
    if (!currentItem || !window.electron) return false;
    const actor = requireWorkflowUser();
    if (!actor) return false;
    const meta = await loadYoloMeta((p) => window.electron!.readJsonFile(p), currentItem.imagePath);
    const next = transitionApprove(meta, actor);
    if (next.workflowStatus === meta.workflowStatus) {
      setStatusMessage('승인할 수 없는 상태입니다.');
      return false;
    }
    if (await persistWorkflowMeta(next)) {
      setStatusMessage('승인됨');
      return true;
    }
    return false;
  }, [currentItem, persistWorkflowMeta, requireWorkflowUser]);

  const handleReject = useCallback(async () => {
    if (!currentItem || !window.electron) return;
    const actor = requireWorkflowUser();
    if (!actor) return;
    const reason = window.prompt('반려 사유를 입력하세요 (선택)');
    if (reason === null) return;
    const meta = await loadYoloMeta((p) => window.electron!.readJsonFile(p), currentItem.imagePath);
    const next = transitionReject(meta, actor, reason);
    if (next.workflowStatus === meta.workflowStatus) {
      setStatusMessage('반려할 수 없는 상태입니다.');
      return;
    }
    if (await persistWorkflowMeta(next)) setStatusMessage('반려됨');
  }, [currentItem, persistWorkflowMeta, requireWorkflowUser]);

  const labelsReadOnly = useMemo(() => {
    if (accessRole === 'viewer' || workflowRole === 'reviewer') return true;
    if (!displayMeta) return false;
    return !canEditLabels(workflowRole, displayMeta.workflowStatus);
  }, [accessRole, displayMeta, workflowRole]);

  const finishNavigate = useCallback(
    async (nextIndex: number) => {
      if (isStatusFilterScanning || navCount <= 0) return;
      if (nextIndex < 0 || nextIndex >= navCount || nextIndex === currentIndex) return;
      const saved = await saveBeforeNavigate();
      if (!saved) return;
      setCurrentIndex(nextIndex);
    },
    [currentIndex, isStatusFilterScanning, navCount, saveBeforeNavigate]
  );

  const {
    navPrompt,
    navBusy,
    navPromptRef,
    requestNavigate,
    handleNavCancel,
    handleNavConfirm,
  } = useWorkflowNavGate({
    workflowRole,
    workflowStatus: displayMeta?.workflowStatus,
    currentIndex,
    onNavigate: finishNavigate,
    onSubmitForReview: handleSubmitForReview,
    onApprove: handleApprove,
  });

  const goToIndex = useCallback(
    (nextIndex: number) => {
      void requestNavigate(nextIndex);
    },
    [requestNavigate]
  );

  const goPrev = useCallback(() => {
    void requestNavigate(currentIndex - 1);
  }, [currentIndex, requestNavigate]);

  const goNext = useCallback(() => {
    void requestNavigate(currentIndex + 1);
  }, [currentIndex, requestNavigate]);

  const openFolderByPath = useCallback(
    async (folderPath: string, options?: { statusFilter?: YoloWorkflowStatus }) => {
      if (!window.electron) return;
      await window.electron.setWorkspaceRoot(folderPath);
      await window.electron.setMediaBaseRoot(folderPath);
      const list = await window.electron.scanMediaFolder(folderPath);
      setWorkFolderPath(folderPath);
      setImageList(list);
      setCurrentIndex(0);
      if (options?.statusFilter) {
        setStatusFilter(options.statusFilter);
        setStatusFilterScanKey((k) => k + 1);
      } else {
        setStatusFilter('all');
        setStatusFilteredNavIndices(null);
      }
      if (list.length === 0) setTask(null);
      const videoCount = list.filter((item) => item.mediaType === 'video').length;
      setStatusMessage(`폴더 열림: ${folderPath} — 이미지 ${list.length - videoCount}개, 영상 ${videoCount}개`);
    },
    []
  );

  const handleOpenFolder = useCallback(async () => {
    if (!window.electron) return;
    try {
      const path = await window.electron.openFolderDialog({
        initialPath: '/data/datasets/vlm',
        pickerRoot: '/data/datasets/vlm',
      });
      if (!path) return;
      await openFolderByPath(path);
    } catch (e) {
      setStatusMessage('폴더 열기 실패: ' + (e as Error).message);
    }
  }, [openFolderByPath]);

  useEffect(() => {
    if (!launchRequest?.folderPath) return;
    void openFolderByPath(launchRequest.folderPath, { statusFilter: launchRequest.statusFilter }).finally(() => {
      onLaunchConsumed?.();
    });
  }, [launchRequest, onLaunchConsumed, openFolderByPath]);

  const handleRefresh = useCallback(async () => {
    if (!workFolderPath || absoluteIndex < 0) return;
    await loadTaskForIndex(absoluteIndex, imageList);
  }, [workFolderPath, absoluteIndex, imageList, loadTaskForIndex]);

  const handleDraftChange = useCallback((p: VlmDraftPayload) => {
    draftRef.current = p;
  }, []);

  const handleGotoSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const num = Number.parseInt(gotoInput.trim(), 10);
      if (!Number.isFinite(num) || num < 1 || num > navCount) {
        setStatusMessage(`1~${navCount} 사이 순번을 입력하세요.`);
        return;
      }
      await goToIndex(num - 1);
      setGotoInput('');
    },
    [gotoInput, navCount, goToIndex]
  );

  /** 이미지별 JSON → vlm_merged.json 병합 내보내기 */
  const handleMergeExport = useCallback(async (approvedOnly: boolean) => {
    if (!window.electron || imageList.length === 0) return;
    const defaultPath = workFolderPath ? `${workFolderPath}/vlm_merged.json` : undefined;
    const savePath = await window.electron.saveJsonFileDialog(defaultPath);
    if (!savePath) return;

    setShowMergeModal(false);
    setIsMergeExporting(true);
    setMergeProgress({ done: 0, total: imageList.length });
    setStatusMessage('병합 중…');

    try {
      const merged: Record<string, unknown>[] = [];
      const list = imageListRef.current;

      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        setMergeProgress({ done: i + 1, total: list.length });

        // 상태 필터
        if (approvedOnly) {
          try {
            const meta = await loadYoloMeta((p) => window.electron!.readJsonFile(p), item.imagePath);
            if (meta.workflowStatus !== 'approved') continue;
          } catch {
            continue;
          }
        }

        // 이미지별 JSON 읽기
        let parsed: Record<string, unknown>;
        try {
          const res = await window.electron.readJsonFile(item.jsonPath);
          if (!res.ok || !res.text?.trim()) continue;
          const raw = JSON.parse(res.text) as unknown;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
          parsed = raw as Record<string, unknown>;
        } catch {
          continue;
        }

        // GPT 응답이 있는 항목만 포함
        const conversations = Array.isArray(parsed.conversations) ? parsed.conversations : [];
        const hasGptResponse = conversations.some((c: unknown) => {
          if (!c || typeof c !== 'object') return false;
          const from = String((c as Record<string, unknown>).from ?? '').toLowerCase();
          const value = String((c as Record<string, unknown>).value ?? '').trim();
          return (from === 'gpt' || from === 'assistant' || from === 'model') && value.length > 0;
        });
        if (!hasGptResponse) continue;

        // image/video 필드를 서버가 제공한 절대 경로로 교정
        const absPath = item.imagePath.replace(/\\/g, '/');
        const mediaType = inferVlmMediaType(absPath, parsed.mediaType);
        const out = { ...parsed };
        delete out.media;
        delete out.image;
        delete out.video;
        if (mediaType === 'video') out.video = absPath;
        else out.image = absPath;
        out.mediaType = mediaType;

        merged.push(out);
      }

      const content = `${JSON.stringify(merged, null, 2)}\n`;
      const ok = await window.electron.writeJsonFile(savePath, content);
      setStatusMessage(ok
        ? `병합 완료: ${merged.length}건 저장 → ${savePath.replace(/^.*[/\\]/, '')}`
        : '병합 저장 실패: 파일 쓰기 오류'
      );
    } catch (e) {
      setStatusMessage('병합 내보내기 실패: ' + (e as Error).message);
    } finally {
      setIsMergeExporting(false);
      setMergeProgress(null);
    }
  }, [imageList, workFolderPath]);

  const openFolderRef = useRef(handleOpenFolder);
  openFolderRef.current = handleOpenFolder;
  const goPrevRef = useRef(goPrev);
  const goNextRef = useRef(goNext);
  goPrevRef.current = goPrev;
  goNextRef.current = goNext;
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  useEffect(() => {
    if (navCount > 0) setGotoInput(String(currentIndex + 1));
    else setGotoInput('');
  }, [currentIndex, navCount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openFolderRef.current();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (draftRef.current) void handleSaveRef.current(draftRef.current);
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        gotoInputRef.current?.focus();
        gotoInputRef.current?.select();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (navPromptRef.current) return;

      const key = e.key.toLowerCase();
      if (key === 'a' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        void goPrevRef.current();
        return;
      }
      if (key === 'd' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        void goNextRef.current();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  if (!window.electron) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 bg-slate-950 text-slate-400 p-8">
        <p className="text-sm font-medium text-slate-300">Electron 또는 웹 브리지로 실행해 주세요</p>
      </div>
    );
  }

  const atStart = currentIndex <= 0;
  const atEnd = currentIndex >= navCount - 1;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <header className="glass flex-shrink-0 border-b border-white/10 px-5 py-3 flex flex-wrap items-center gap-3 rounded-none">
        <button
          type="button"
          onClick={() => void handleOpenFolder()}
          className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-purple)]"
          style={{ color: 'var(--accent-purple)' }}
        >
          폴더 열기
        </button>
        {workFolderPath && (
          <span className="text-xs text-slate-400 truncate max-w-[160px] sm:max-w-md font-mono" title={workFolderPath}>
            {workFolderPath.replace(/^.*[/\\]/, '')}
          </span>
        )}
        {displayMeta ? (
          <span
            className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-lg text-xs font-semibold border ${workflowStatusBadgeClass(displayMeta.workflowStatus)}`}
          >
            {workflowStatusLabel(displayMeta.workflowStatus)}
          </span>
        ) : null}
        {statusFilter !== 'all' ? (
          <span className="text-xs text-amber-200/90">
            필터: {STATUS_FILTER_OPTIONS.find((o) => o.value === statusFilter)?.label}
            <button type="button" onClick={() => setStatusFilter('all')} className="ml-1.5 underline hover:text-white">
              해제
            </button>
          </span>
        ) : null}
        <label className="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoSave}
            onChange={(e) => setAutoSave(e.target.checked)}
            className="rounded border-slate-600"
          />
          이동 시 자동 저장
        </label>
        {imageList.length > 0 && (
          <button
            type="button"
            onClick={() => setShowMergeModal(true)}
            disabled={isMergeExporting}
            className="px-3 py-1.5 rounded-xl glass border border-[var(--accent-purple)]/40 text-xs font-medium text-[var(--accent-purple)] hover:border-[var(--accent-purple)] hover:bg-[var(--accent-purple)]/10 disabled:opacity-40 transition-all shrink-0"
            title="이미지별 JSON 파일을 하나의 학습용 JSON으로 병합 내보내기"
          >
            {isMergeExporting
              ? `병합 중… ${mergeProgress ? `(${mergeProgress.done}/${mergeProgress.total})` : ''}`
              : '학습용 JSON 병합'}
          </button>
        )}
        <div className="flex-1 min-w-[120px] text-sm text-slate-400 truncate">{statusMessage}</div>
      </header>

      <div className="glass flex-shrink-0 border-b border-white/10 px-5 py-2 flex flex-wrap items-center gap-3">
        <WorkflowRoleSelect
          id="workflow-role-select-vlm"
          role={accessRole}
          availableRoles={availableRoles}
          onRoleChange={onAccessRoleChange}
          size="sm"
        />
        {workflowUser ? <span className="text-xs text-slate-400">{workflowUser}</span> : null}
        <div className="flex flex-wrap items-center gap-1">
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatusFilter(opt.value)}
              disabled={imageList.length === 0 || isStatusFilterScanning}
              className={`px-2 py-0.5 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-40 ${
                statusFilter === opt.value
                  ? 'border-[var(--accent-purple)]/60 bg-[var(--accent-purple)]/15 text-[var(--accent-purple)]'
                  : 'border-transparent bg-white/5 text-slate-400 hover:text-slate-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-slate-600 hidden sm:inline" title={workflowMetaPathForMedia('example/media.jpg')}>
          meta: 미디어와 같은 폴더의 *.meta.json
        </span>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {isStatusFilterScanning ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
              <div className="w-8 h-8 border-2 border-[var(--accent-purple)] border-t-transparent rounded-full animate-spin" />
              <p className="text-xs text-slate-400">상태 필터 적용 중…</p>
            </div>
          ) : statusFilter !== 'all' && navCount === 0 && imageList.length > 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
              <p className="text-sm text-slate-300">필터 조건에 맞는 항목이 없습니다.</p>
              <button
                type="button"
                onClick={() => setStatusFilter('all')}
                className="px-3 py-1.5 rounded-xl glass border border-white/10 text-xs text-[var(--accent-purple)]"
              >
                필터 해제
              </button>
            </div>
          ) : !task ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="text-slate-300 text-sm font-medium">VLM 작업: 미디어 폴더를 열어 주세요 (Ctrl+O)</p>
              <p className="text-slate-500 text-xs max-w-md">
                태그 JSON은 미디어와 같은 폴더의 <code className="text-slate-400">같은이름.json</code>, 검수 상태는{' '}
                <code className="text-slate-400">같은이름.meta.json</code>
              </p>
            </div>
          ) : (
            <div className="h-full flex flex-col min-h-0">
              <div className="flex-1 min-h-0 overflow-hidden">
                <VlmReviewPanel
                  key={task.id}
                  task={task}
                  mediaAnchorDir={workFolderPath}
                  mediaBasePath={workFolderPath}
                  directMediaSrc={currentItem?.imageUrl ?? null}
                  readOnly={labelsReadOnly}
                  positionLabel={navCount > 0 ? `${currentIndex + 1} / ${navCount}` : ''}
                  isSaving={isSaving}
                  onRefreshTask={() => void handleRefresh()}
                  onSave={handleSave}
                  onDraftChange={handleDraftChange}
                />
              </div>
              {navCount > 0 && (
                <footer className="glass flex-shrink-0 border-t border-white/10 px-4 py-2.5 flex flex-wrap items-center justify-center gap-2 sm:gap-3">
                  <button
                    type="button"
                    onClick={() => void goPrev()}
                    disabled={atStart || isSaving || isStatusFilterScanning}
                    className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 text-sm font-medium transition-all hover:border-[var(--accent-blue)]"
                    style={{ color: 'var(--accent-blue)' }}
                  >
                    이전 (A)
                  </button>
                  <form className="flex items-center gap-2" onSubmit={(e) => void handleGotoSubmit(e)}>
                    <label htmlFor="vlm-goto-input" className="text-xs text-slate-500 whitespace-nowrap">
                      GOTO
                    </label>
                    <input
                      id="vlm-goto-input"
                      ref={gotoInputRef}
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder="순번"
                      value={gotoInput}
                      onChange={(e) => setGotoInput(e.target.value)}
                      disabled={isSaving || isStatusFilterScanning}
                      className="w-16 px-2 py-1.5 rounded-lg bg-slate-900/80 border border-white/15 text-sm text-slate-200 text-center tabular-nums outline-none focus:border-[var(--accent-purple)] disabled:opacity-50"
                    />
                    <span className="text-slate-500 text-sm">/ {navCount}</span>
                  </form>
                  {displayMeta && currentItem ? (
                    <div className="flex items-center gap-1.5">
                      {workflowRole === 'worker' &&
                        (displayMeta.workflowStatus === 'draft' || displayMeta.workflowStatus === 'rejected') && (
                          <button
                            type="button"
                            onClick={() => void handleSubmitForReview()}
                            className="px-2.5 py-1 rounded-lg text-xs font-medium border border-amber-400/50 bg-amber-400/15 text-amber-100"
                          >
                            {displayMeta.workflowStatus === 'rejected' ? '재검수' : '검수 요청'}
                          </button>
                        )}
                      {workflowRole === 'reviewer' && displayMeta.workflowStatus === 'submitted' && (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleApprove()}
                            className="px-2.5 py-1 rounded-lg text-xs font-medium border border-emerald-400/50 bg-emerald-400/15 text-emerald-100"
                          >
                            승인
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleReject()}
                            className="px-2.5 py-1 rounded-lg text-xs font-medium border border-red-400/50 bg-red-400/15 text-red-200"
                          >
                            반려
                          </button>
                        </>
                      )}
                      {labelsReadOnly ? <span className="text-[11px] text-slate-500">읽기 전용</span> : null}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void goNext()}
                    disabled={atEnd || isSaving || isStatusFilterScanning}
                    className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 text-sm font-medium transition-all hover:border-[var(--accent-blue)]"
                    style={{ color: 'var(--accent-blue)' }}
                  >
                    다음 (D)
                  </button>
                </footer>
              )}
            </div>
          )}
        </main>

        {task && displayMeta ? (
          <aside className="glass w-72 flex-shrink-0 border-l border-white/10 overflow-hidden flex flex-col min-h-0 hidden md:flex">
            <LabelHistoryPanel history={displayMeta.changeHistory} />
          </aside>
        ) : null}
      </div>

      <WorkflowNavigateModal
        prompt={navPrompt}
        itemLabel={currentItem?.name}
        busy={navBusy}
        onCancel={() => void handleNavCancel()}
        onConfirm={() => void handleNavConfirm()}
      />

      {/* JSON 병합 내보내기 모달 */}
      {showMergeModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setShowMergeModal(false)}
        >
          <div
            className="glass-card w-full max-w-sm border border-[var(--accent-purple)]/25 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <h2 className="text-base font-bold text-white">학습용 JSON 병합</h2>
              <button
                type="button"
                onClick={() => setShowMergeModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                aria-label="닫기"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="px-5 py-4 space-y-3">
              <p className="text-xs text-slate-400">
                현재 폴더의 이미지별 <code className="text-slate-300">.json</code> 파일을 읽어
                GPT 응답이 있는 항목만 하나의 배열로 병합합니다.
              </p>
              <div className="glass rounded-xl p-3 border border-white/10 text-xs text-slate-400 space-y-1">
                <div>대상 항목: <span className="text-white font-semibold tabular-nums">{imageList.length}개</span></div>
                <div>출력 위치: <span className="text-[var(--accent-purple)] font-mono">{workFolderPath ? `${workFolderPath.replace(/^.*[/\\]/, '')}/vlm_merged.json` : '저장 대화상자에서 선택'}</span></div>
              </div>
              <label className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${mergeFilterApproved ? 'border-emerald-400/40 bg-emerald-400/5' : 'border-white/10 bg-white/5'}`}>
                <input
                  type="checkbox"
                  checked={mergeFilterApproved}
                  onChange={(e) => setMergeFilterApproved(e.target.checked)}
                  className="mt-0.5 shrink-0 rounded border-white/20"
                />
                <div>
                  <p className="text-sm text-slate-200 font-medium">승인 항목만 포함</p>
                  <p className="text-xs text-slate-500 mt-0.5">체크 해제 시 라벨이 있는 모든 항목 (draft·submitted·approved·rejected) 포함</p>
                </div>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/10">
              <button
                type="button"
                onClick={() => setShowMergeModal(false)}
                className="px-4 py-2 rounded-xl glass border border-white/10 text-sm text-slate-300 hover:text-white"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => void handleMergeExport(mergeFilterApproved)}
                className="px-5 py-2 rounded-xl text-sm font-semibold border border-[var(--accent-purple)]/50 bg-[var(--accent-purple)]/20 text-[var(--accent-purple)] hover:bg-[var(--accent-purple)]/30 transition-all"
              >
                내보내기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VlmWorkspace;
