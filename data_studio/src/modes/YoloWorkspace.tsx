/// <reference types="vite/client" />
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { BoundingBox, YoloClass } from '../types';
import { COLOR_PALETTE } from '../constants';
import { parseYoloTxt, generateYoloTxt } from '../yoloFormat';
import { newId } from '../newId';
import AnnotationCanvas from '../components/AnnotationCanvas';
import LabelHistoryPanel from '../components/LabelHistoryPanel';
import WorkflowNavigateModal from '../components/WorkflowNavigateModal';
import { useWorkflowNavGate } from '../useWorkflowNavGate';
import type { YoloLaunchRequest } from '../dashboardTypes';
import {
  appendLabelSaveHistory,
  canEditLabels,
  loadYoloMeta,
  saveYoloMeta,
  transitionApprove,
  transitionReject,
  transitionSubmit,
  workflowStatusLabel,
  yoloMetaPathForImage,
  type YoloImageMeta,
  type YoloWorkflowRole,
  type YoloWorkflowStatus,
} from '../yoloMeta';

interface YoloWorkspaceProps {
  launchRequest?: YoloLaunchRequest | null;
  onLaunchConsumed?: () => void;
}

interface OfflineImageItem {
  name: string;
  imagePath: string;
  txtPath: string;
  imageUrl: string;
}

interface FolderStats {
  totalImages: number;
  imagesWithLabels: number;
  imagesWithoutLabels: number;
  totalBoxes: number;
  byClass: { classId: number; name: string; count: number }[];
}

/** 툴에 저장된 클래스 세트 (txt 내용 + 표시 이름) */
interface SavedClassSet {
  id: string;
  displayName: string;
  classNames: string[];
}

const SAVED_SETS_STORAGE_KEY = 'intellivixYolo.savedClassSetsV1';
const AUTO_SAVE_STORAGE_KEY = 'intellivixYolo.autoSaveV1';
const WORKFLOW_ROLE_KEY = 'intellivixYolo.workflowRoleV1';
const WORKFLOW_USER_KEY = 'intellivixYolo.workflowUserV1';
const WORKFLOW_STATUS_FILTER_KEY = 'intellivixYolo.workflowStatusFilterV1';

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

function classNamesToYoloClasses(classNames: string[]): YoloClass[] {
  return classNames.map((name, index) => ({
    id: index,
    name,
    color: COLOR_PALETTE[index % COLOR_PALETTE.length],
  }));
}

const YoloWorkspace: React.FC<YoloWorkspaceProps> = ({ launchRequest = null, onLaunchConsumed }) => {
  const [workFolderPath, setWorkFolderPath] = useState<string | null>(null);
  const [imageList, setImageList] = useState<OfflineImageItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [classes, setClasses] = useState<YoloClass[]>([]);
  const [selectedClass, setSelectedClass] = useState<YoloClass | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [undoSignal, setUndoSignal] = useState(0);
  const [redoSignal, setRedoSignal] = useState(0);
  const [hiddenClassIds, setHiddenClassIds] = useState<number[]>([]);
  const [customClassColors, setCustomClassColors] = useState<Record<number, string>>({});

  const [savedClassSets, setSavedClassSets] = useState<SavedClassSet[]>([]);
  const [activeClassSetId, setActiveClassSetId] = useState<string | null>(null);
  const [storageRestored, setStorageRestored] = useState(false);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const labelMenuRef = useRef<HTMLDivElement>(null);
  const labelTriggerRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);
  const [labelDropdownRect, setLabelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [gotoValue, setGotoValue] = useState('');
  const [autoSave, setAutoSave] = useState(() => {
    try {
      return localStorage.getItem(AUTO_SAVE_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  });

  // 화면에 실제로 그리는 항목
  const [displayItem, setDisplayItem] = useState<OfflineImageItem | null>(null);
  const [displayAnnotations, setDisplayAnnotations] = useState<BoundingBox[]>([]);
  const [displayMeta, setDisplayMeta] = useState<YoloImageMeta | null>(null);

  const [workflowRole, setWorkflowRole] = useState<YoloWorkflowRole>(() => {
    try {
      const stored = localStorage.getItem(WORKFLOW_ROLE_KEY);
      return stored === 'reviewer' ? 'reviewer' : 'worker';
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

  const [showStatsModal, setShowStatsModal] = useState(false);
  const [folderStats, setFolderStats] = useState<FolderStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  /** null이면 전체 이미지 순회, 숫자면 해당 classId가 한 개 이상 있는 이미지만 */
  const [browseFilterClassId, setBrowseFilterClassId] = useState<number | null>(null);
  const [filteredNavIndices, setFilteredNavIndices] = useState<number[] | null>(null);
  const [browseFilterLoading, setBrowseFilterLoading] = useState(false);
  /** 라벨 스캔 진행 (필터 적용 중에만) */
  const [browseFilterScanProgress, setBrowseFilterScanProgress] = useState<{ done: number; total: number } | null>(null);
  const pendingAbsoluteIndexRef = useRef(0);
  /** 삭제 후 재스캔 시 필터 목록 내 위치 유지 */
  const navigateAfterFilterScanRef = useRef<{ type: 'filteredSlot'; slot: number } | null>(null);
  const imageListRef = useRef(imageList);
  imageListRef.current = imageList;
  const lastWriteWarningRef = useRef<{ path: string; at: number } | null>(null);
  const lastSavedTxtRef = useRef('');

  const classesRef = useRef(classes);
  const selectedClassRef = useRef(selectedClass);
  useEffect(() => {
    classesRef.current = classes;
    selectedClassRef.current = selectedClass;
  }, [classes, selectedClass]);

  /** 저장소에서 저장된 세트 목록만 복원 (시작 시에는 아무 클래스도 적용하지 않음) */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_SETS_STORAGE_KEY);
      if (!raw) {
        setStorageRestored(true);
        return;
      }
      const o = JSON.parse(raw) as {
        savedClassSets?: SavedClassSet[];
        customColors?: Record<string, string>;
      };
      const sets = Array.isArray(o.savedClassSets) ? o.savedClassSets.filter((s) => s?.id && s?.displayName && Array.isArray(s.classNames)) : [];
      setSavedClassSets(sets);
      if (o.customColors && typeof o.customColors === 'object') {
        const colors: Record<number, string> = {};
        for (const [k, v] of Object.entries(o.customColors)) {
          if (typeof v === 'string') colors[Number(k)] = v;
        }
        setCustomClassColors(colors);
      }
      setStorageRestored(true);
    } catch {
      setStorageRestored(true);
    }
  }, []);

  /** 세트 목록·선택·색상 변경 시 저장 (복원 완료 후에만) */
  const persistSavedSets = useCallback(() => {
    try {
      localStorage.setItem(
        SAVED_SETS_STORAGE_KEY,
        JSON.stringify({
          savedClassSets,
          activeClassSetId,
          customColors: customClassColors,
        })
      );
    } catch {
      /* ignore */
    }
  }, [savedClassSets, activeClassSetId, customClassColors]);

  useEffect(() => {
    if (!storageRestored) return;
    persistSavedSets();
  }, [storageRestored, persistSavedSets]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_SAVE_STORAGE_KEY, autoSave ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [autoSave]);

  /** 배열 참조만 바뀌는 경우 필터 스캔이 다시 돌지 않도록 실질적 목록 키 */
  const imageListScanKey = useMemo(
    () => `${imageList.length}\n${imageList.map((item) => item.imagePath).join('\n')}`,
    [imageList]
  );

  const classNavIndices = useMemo(() => {
    if (browseFilterClassId === null) return imageList.map((_, i) => i);
    if (filteredNavIndices === null) return [];
    return filteredNavIndices;
  }, [browseFilterClassId, filteredNavIndices, imageList]);

  const navIndices = useMemo(() => {
    const classScanPending = browseFilterClassId !== null && filteredNavIndices === null;
    const statusScanPending = statusFilter !== 'all' && statusFilteredNavIndices === null;
    if (classScanPending || statusScanPending) return [];

    let indices = classNavIndices;
    if (statusFilter !== 'all') {
      const statusSet = new Set(statusFilteredNavIndices ?? []);
      indices = indices.filter((i) => statusSet.has(i));
    }
    return indices;
  }, [browseFilterClassId, classNavIndices, filteredNavIndices, statusFilter, statusFilteredNavIndices]);

  /** effect 직후 한 프레임까지 포함해 스캔 중으로 간주 */
  const isBrowseFilterScanning =
    (browseFilterClassId !== null && (browseFilterLoading || filteredNavIndices === null)) ||
    (statusFilter !== 'all' && (statusFilterLoading || statusFilteredNavIndices === null));
  const navCount = navIndices.length;
  const absoluteImageIndex = navCount > 0 ? (navIndices[Math.min(currentIndex, navCount - 1)] ?? 0) : -1;
  const currentItem = absoluteImageIndex >= 0 ? (imageList[absoluteImageIndex] ?? null) : null;

  /** 필터 스캔: browseFilterClassId 또는 폴더 목록이 바뀔 때 */
  useEffect(() => {
    if (browseFilterClassId === null) {
      setFilteredNavIndices(null);
      setBrowseFilterLoading(false);
      setBrowseFilterScanProgress(null);
      return;
    }
    const list = imageListRef.current;
    if (!window.electron || list.length === 0) {
      setFilteredNavIndices([]);
      setBrowseFilterLoading(false);
      setBrowseFilterScanProgress(null);
      setCurrentIndex(0);
      return;
    }
    let cancelled = false;
    const total = list.length;
    const progressStep = Math.max(1, Math.ceil(total / 120));
    setFilteredNavIndices(null);
    setBrowseFilterLoading(true);
    setBrowseFilterScanProgress({ done: 0, total });
    (async () => {
      const indices: number[] = [];
      for (let i = 0; i < list.length; i++) {
        if (cancelled) return;
        try {
          const content = await window.electron!.readTxt(list[i].txtPath);
          const boxes = parseYoloTxt(content);
          if (boxes.some((b) => b.classId === browseFilterClassId)) indices.push(i);
        } catch {
          /* no txt */
        }
        if (cancelled) return;
        const done = i + 1;
        if (done === total || done % progressStep === 0) {
          setBrowseFilterScanProgress({ done, total });
        }
      }
      if (cancelled) return;
      setFilteredNavIndices(indices);
      setBrowseFilterLoading(false);
      setBrowseFilterScanProgress(null);
      const slotNav = navigateAfterFilterScanRef.current;
      navigateAfterFilterScanRef.current = null;
      if (slotNav?.type === 'filteredSlot') {
        setCurrentIndex(Math.min(slotNav.slot, Math.max(0, indices.length - 1)));
        return;
      }
      const abs = pendingAbsoluteIndexRef.current;
      const pos = indices.indexOf(abs);
      setCurrentIndex(pos >= 0 ? pos : indices.length > 0 ? 0 : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [browseFilterClassId, imageListScanKey]);

  /** 상태 필터 스캔 */
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

  useEffect(() => {
    try {
      localStorage.setItem(WORKFLOW_STATUS_FILTER_KEY, statusFilter);
    } catch {
      /* ignore */
    }
  }, [statusFilter]);

  useEffect(() => {
    if (navCount === 0) return;
    if (currentIndex >= navCount) setCurrentIndex(navCount - 1);
  }, [navCount, currentIndex]);

  const setBrowseFilter = useCallback(
    (classId: number | null) => {
      if (classId === null) {
        if (browseFilterClassId !== null && filteredNavIndices && filteredNavIndices.length > 0) {
          const abs = filteredNavIndices[Math.min(currentIndex, filteredNavIndices.length - 1)];
          if (abs !== undefined) setCurrentIndex(abs);
        }
        setBrowseFilterClassId(null);
        setFilteredNavIndices(null);
        setBrowseFilterLoading(false);
        setBrowseFilterScanProgress(null);
        return;
      }
      const abs =
        browseFilterClassId === null || !filteredNavIndices || filteredNavIndices.length === 0
          ? currentIndex
          : (filteredNavIndices[Math.min(currentIndex, filteredNavIndices.length - 1)] ?? currentIndex);
      pendingAbsoluteIndexRef.current = abs;
      setBrowseFilterClassId(classId);
    },
    [browseFilterClassId, filteredNavIndices, currentIndex]
  );

  /** 현재 이미지(캔버스) 기준 클래스별 박스 수 */
  const classBoxCounts = useMemo(() => {
    const m = new Map<number, number>();
    if (!displayAnnotations.length) return m;
    for (const b of displayAnnotations) {
      m.set(b.classId, (m.get(b.classId) ?? 0) + 1);
    }
    return m;
  }, [displayAnnotations]);

  const loadAnnotationsForIndex = useCallback(async (index: number): Promise<BoundingBox[]> => {
    if (!window.electron || index < 0 || index >= imageList.length) return [];
    const item = imageList[index];
    try {
      const content = await window.electron.readTxt(item.txtPath);
      return parseYoloTxt(content);
    } catch {
      return [];
    }
  }, [imageList]);

  // 폴더가 바뀌면 표시 초기화
  useEffect(() => {
    setDisplayItem(null);
    setDisplayAnnotations([]);
    setDisplayMeta(null);
    lastSavedTxtRef.current = '';
  }, [imageList]);

  // 현재(절대) 인덱스에 대해 라벨·메타 로드 후, 이미지+라벨을 동시에 갱신
  useEffect(() => {
    if (!currentItem || !window.electron || absoluteImageIndex < 0) return;
    const index = absoluteImageIndex;
    let cancelled = false;
    (async () => {
      const [loaded, txtContent, meta] = await Promise.all([
        loadAnnotationsForIndex(index),
        window.electron!.readTxt(currentItem.txtPath),
        loadYoloMeta((p) => window.electron!.readJsonFile(p), currentItem.imagePath),
      ]);
      if (cancelled) return;
      lastSavedTxtRef.current = txtContent;
      setDisplayItem(currentItem);
      setDisplayAnnotations(loaded);
      setDisplayMeta(meta);
    })();
    return () => {
      cancelled = true;
    };
  }, [absoluteImageIndex, currentItem, loadAnnotationsForIndex]);

  const openFolderByPath = useCallback(
    async (folderPath: string, options?: { statusFilter?: YoloWorkflowStatus }) => {
      if (!window.electron) return;
      try {
        await window.electron.setWorkspaceRoot(folderPath);
        const list = await window.electron.scanFolder(folderPath);
        setWorkFolderPath(folderPath);
        setImageList(list);
        setCurrentIndex(0);
        setBrowseFilterClassId(null);
        setFilteredNavIndices(null);
        setBrowseFilterLoading(false);
        setBrowseFilterScanProgress(null);
        if (options?.statusFilter) {
          setStatusFilter(options.statusFilter);
          setStatusFilterScanKey((k) => k + 1);
        } else {
          setStatusFilter('all');
          setStatusFilteredNavIndices(null);
          setStatusFilterLoading(false);
        }
        setStatusMessage(`폴더 열림: ${folderPath} — 하위 폴더 포함 ${list.length}개 이미지`);
      } catch (e) {
        setStatusMessage('폴더 열기 실패: ' + (e as Error).message);
      }
    },
    []
  );

  const handleOpenFolder = async () => {
    if (!window.electron) return;
    try {
      const path = await window.electron.openFolderDialog({
        initialPath: '/data/datasets/detector',
        pickerRoot: '/data/datasets/detector',
      });
      if (!path) return;
      await openFolderByPath(path);
    } catch (e) {
      setStatusMessage('폴더 열기 실패: ' + (e as Error).message);
    }
  };

  useEffect(() => {
    if (!launchRequest?.folderPath) return;
    void openFolderByPath(launchRequest.folderPath, { statusFilter: launchRequest.statusFilter }).finally(() => {
      onLaunchConsumed?.();
    });
  }, [launchRequest, onLaunchConsumed, openFolderByPath]);

  /** txt 파일을 불러와 새 클래스 세트로 저장하고 적용 */
  const handleLoadFileAndSave = async () => {
    if (!window.electron) return;
    setLabelMenuOpen(false);
    try {
      const path = await window.electron.openLabelFileDialog({
        initialPath: '/data/datasets/detector',
        pickerRoot: '/data/datasets/detector',
      });
      if (!path) return;
      const content = await window.electron.readLabelFile(path);
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      const displayName = path.replace(/^.*[/\\]/, '').replace(/\.txt$/i, '') || 'classes';
      const newSet: SavedClassSet = {
        id: newId('classset'),
        displayName,
        classNames: lines,
      };
      setSavedClassSets((prev) => [...prev, newSet]);
      setActiveClassSetId(newSet.id);
      const yolo = classNamesToYoloClasses(newSet.classNames);
      setClasses(yolo);
      setSelectedClass(yolo[0] ?? null);
      setStatusMessage(`저장됨: ${newSet.displayName} (${lines.length}개 클래스)`);
    } catch (e) {
      setStatusMessage('라벨 파일 열기 실패: ' + (e as Error).message);
    }
  };

  /** 저장된 세트 선택 시 적용 */
  const applySavedSet = useCallback((id: string) => {
    const set = savedClassSets.find((s) => s.id === id);
    if (!set) return;
    setLabelMenuOpen(false);
    setActiveClassSetId(id);
    const yolo = classNamesToYoloClasses(set.classNames);
    setClasses(yolo);
    setSelectedClass(yolo[0] ?? null);
    setStatusMessage(`적용: ${set.displayName}`);
  }, [savedClassSets]);

  /** 세트 표시 이름 변경 */
  const renameSavedSet = useCallback((id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setSavedClassSets((prev) => prev.map((s) => (s.id === id ? { ...s, displayName: trimmed } : s)));
    setRenameId(null);
    setRenameValue('');
  }, []);

  /** 세트 삭제 */
  const removeSavedSet = useCallback((id: string) => {
    setSavedClassSets((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeClassSetId === id) {
        const first = next[0];
        if (first) {
          setActiveClassSetId(first.id);
          const yolo = classNamesToYoloClasses(first.classNames);
          setClasses(yolo);
          setSelectedClass(yolo[0] ?? null);
        } else {
          setActiveClassSetId(null);
          setClasses([]);
          setSelectedClass(null);
        }
      }
      return next;
    });
    setRenameId(null);
  }, [activeClassSetId]);

  useEffect(() => {
    if (!labelMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (labelMenuRef.current && !labelMenuRef.current.contains(e.target as Node)) setLabelMenuOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [labelMenuOpen]);

  useEffect(() => {
    if (renameId) renameInputRef.current?.focus();
  }, [renameId]);

  /** Goto 입력값을 현재 인덱스와 동기화 (필터 시 필터된 목록 기준) */
  useEffect(() => {
    if (navCount > 0) setGotoValue(String(currentIndex + 1));
    else setGotoValue('');
  }, [currentIndex, navCount]);

  /** 드롭다운 열릴 때 트리거 위치 갱신 (portal 위치용) */
  useEffect(() => {
    if (!labelMenuOpen || !labelTriggerRef.current) {
      setLabelDropdownRect(null);
      return;
    }
    const update = () => {
      if (labelTriggerRef.current) {
        const rect = labelTriggerRef.current.getBoundingClientRect();
        setLabelDropdownRect({ top: rect.bottom, left: rect.left, width: rect.width });
      }
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [labelMenuOpen]);

  const loadFolderStats = useCallback(async () => {
    if (!window.electron || imageList.length === 0) return;
    setStatsLoading(true);
    setFolderStats(null);
    try {
      const byClassMap = new Map<number, number>();
      let totalBoxes = 0;
      let imagesWithLabels = 0;
      for (const item of imageList) {
        try {
          const content = await window.electron!.readTxt(item.txtPath);
          const boxes = parseYoloTxt(content);
          totalBoxes += boxes.length;
          if (boxes.length > 0) imagesWithLabels += 1;
          for (const b of boxes) {
            byClassMap.set(b.classId, (byClassMap.get(b.classId) ?? 0) + 1);
          }
        } catch {
          // no txt or read error
        }
      }
      const byClass = Array.from(byClassMap.entries())
        .map(([classId, count]) => ({
          classId,
          name: classes.find((c) => c.id === classId)?.name ?? `클래스 ID ${classId}`,
          count,
        }))
        .sort((a, b) => b.count - a.count);
      setFolderStats({
        totalImages: imageList.length,
        imagesWithLabels,
        imagesWithoutLabels: imageList.length - imagesWithLabels,
        totalBoxes,
        byClass,
      });
    } finally {
      setStatsLoading(false);
    }
  }, [imageList, classes]);

  useEffect(() => {
    if (showStatsModal && imageList.length > 0) loadFolderStats();
  }, [showStatsModal, imageList.length, loadFolderStats]);

  const notifyTxtWriteFailure = useCallback((item: OfflineImageItem) => {
    const status = `저장 실패: ${item.name} (TXT 쓰기 권한 확인)`;
    setStatusMessage(status);
    const now = Date.now();
    const last = lastWriteWarningRef.current;
    if (last && last.path === item.txtPath && now - last.at < 5000) return;
    lastWriteWarningRef.current = { path: item.txtPath, at: now };
    window.alert(
      [
        `라벨 TXT 저장에 실패했습니다: ${item.name}`,
        '작업 폴더에 쓰기 권한이 없거나 읽기 전용/보안 정책으로 차단되었을 수 있습니다.',
        '폴더 권한을 확인한 뒤 다시 시도해 주세요.',
        '',
        `대상 파일: ${item.txtPath}`,
      ].join('\n')
    );
  }, []);

  const persistCurrentTxt = useCallback(
    async (item: OfflineImageItem, annotations: BoundingBox[], options?: { skipHistory?: boolean }) => {
      if (!window.electron) return false;
      const content = generateYoloTxt(annotations);
      const beforeTxt = lastSavedTxtRef.current;
      const ok = await window.electron.writeTxt(item.txtPath, content);
      if (!ok) {
        notifyTxtWriteFailure(item);
        return false;
      }
      const actor = workflowUser.trim();
      if (!options?.skipHistory && actor && beforeTxt !== content) {
        try {
          const meta = await loadYoloMeta((p) => window.electron!.readJsonFile(p), item.imagePath);
          const updated = appendLabelSaveHistory(meta, actor, workflowRole, beforeTxt, content);
          if (updated) {
            const metaOk = await saveYoloMeta(
              (p, c) => window.electron!.writeJsonFile(p, c),
              item.imagePath,
              updated
            );
            if (metaOk) setDisplayMeta(updated);
          }
        } catch {
          /* meta history is best-effort */
        }
      }
      lastSavedTxtRef.current = content;
      return true;
    },
    [notifyTxtWriteFailure, workflowRole, workflowUser]
  );

  const handleUpdateAnnotations = useCallback(
    (newAnnotations: BoundingBox[]) => {
      setDisplayAnnotations(newAnnotations);
      if (!autoSave || !window.electron || !displayItem) return;
      void persistCurrentTxt(displayItem, newAnnotations);
    },
    [autoSave, displayItem, persistCurrentTxt]
  );

  const saveCurrent = useCallback(async () => {
    if (!window.electron || !displayItem) return true;
    return persistCurrentTxt(displayItem, displayAnnotations);
  }, [displayAnnotations, displayItem, persistCurrentTxt]);

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
      if (!window.electron || !displayItem) return false;
      const ok = await saveYoloMeta(
        (p, c) => window.electron!.writeJsonFile(p, c),
        displayItem.imagePath,
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
    [displayItem, statusFilter]
  );

  const handleSubmitForReview = useCallback(async (): Promise<boolean> => {
    if (!displayItem || !window.electron) return false;
    const actor = requireWorkflowUser();
    if (!actor) return false;
    if (autoSave) {
      const ok = await saveCurrent();
      if (!ok) return false;
    }
    const meta = await loadYoloMeta((p) => window.electron!.readJsonFile(p), displayItem.imagePath);
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
  }, [autoSave, displayItem, persistWorkflowMeta, requireWorkflowUser, saveCurrent]);

  const handleApprove = useCallback(async (): Promise<boolean> => {
    if (!displayItem || !window.electron) return false;
    const actor = requireWorkflowUser();
    if (!actor) return false;
    const meta = await loadYoloMeta((p) => window.electron!.readJsonFile(p), displayItem.imagePath);
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
  }, [displayItem, persistWorkflowMeta, requireWorkflowUser]);

  const handleReject = useCallback(async () => {
    if (!displayItem || !window.electron) return;
    const actor = requireWorkflowUser();
    if (!actor) return;
    const reason = window.prompt('반려 사유를 입력하세요 (선택)');
    if (reason === null) return;
    const meta = await loadYoloMeta((p) => window.electron!.readJsonFile(p), displayItem.imagePath);
    const next = transitionReject(meta, actor, reason);
    if (next.workflowStatus === meta.workflowStatus) {
      setStatusMessage('반려할 수 없는 상태입니다.');
      return;
    }
    if (await persistWorkflowMeta(next)) {
      setStatusMessage('반려됨');
    }
  }, [displayItem, persistWorkflowMeta, requireWorkflowUser]);

  const labelsReadOnly = useMemo(() => {
    if (workflowRole === 'reviewer') return true;
    if (!displayMeta) return false;
    return !canEditLabels(workflowRole, displayMeta.workflowStatus);
  }, [displayMeta, workflowRole]);

  const finishNavigate = useCallback(
    async (nextIndex: number) => {
      if (isBrowseFilterScanning || browseFilterLoading || navCount <= 0) return;
      if (nextIndex < 0 || nextIndex >= navCount || nextIndex === currentIndex) return;
      if (autoSave) {
        const ok = await saveCurrent();
        if (!ok) return;
      }
      setCurrentIndex(nextIndex);
    },
    [autoSave, browseFilterLoading, currentIndex, isBrowseFilterScanning, navCount, saveCurrent]
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

  const handleDeleteCurrentImage = useCallback(async () => {
    if (!window.electron || !displayItem) return;
    const msg = `현재 이미지와 해당 라벨 파일을 삭제할까요?\n이 작업은 되돌릴 수 없습니다.\n\n${displayItem.name}`;
    if (!window.confirm(msg)) return;
    const metaPath = yoloMetaPathForImage(displayItem.imagePath);
    const result = await window.electron.deleteImageAndTxt(displayItem.imagePath, displayItem.txtPath, metaPath);
    if (!result.ok) {
      setStatusMessage('삭제 실패: ' + (result.error || '알 수 없음'));
      return;
    }
    const nextList = imageList.filter((item) => item.imagePath !== displayItem!.imagePath);
    if (browseFilterClassId !== null) {
      navigateAfterFilterScanRef.current = { type: 'filteredSlot', slot: currentIndex };
    }
    setImageList(nextList);
    if (nextList.length === 0) {
      setDisplayItem(null);
      setDisplayAnnotations([]);
      setCurrentIndex(0);
      navigateAfterFilterScanRef.current = null;
      setStatusMessage('이미지와 라벨 파일이 삭제되었습니다.');
      return;
    }
    if (browseFilterClassId === null) {
      const nextIndex = currentIndex >= nextList.length ? nextList.length - 1 : currentIndex;
      setCurrentIndex(nextIndex);
    }
    setStatusMessage(`삭제됨: ${displayItem.name}`);
  }, [displayItem, imageList, currentIndex, browseFilterClassId]);

  const handleDeleteCurrentImageRef = useRef(handleDeleteCurrentImage);
  handleDeleteCurrentImageRef.current = handleDeleteCurrentImage;

  const goPrevRef = useRef(goPrev);
  const goNextRef = useRef(goNext);
  const saveCurrentRef = useRef(saveCurrent);
  const handleOpenFolderRef = useRef(handleOpenFolder);
  const handleLoadFileAndSaveRef = useRef(handleLoadFileAndSave);
  const currentItemRef = useRef<OfflineImageItem | null>(null);
  goPrevRef.current = goPrev;
  goNextRef.current = goNext;
  saveCurrentRef.current = saveCurrent;
  handleOpenFolderRef.current = handleOpenFolder;
  handleLoadFileAndSaveRef.current = handleLoadFileAndSave;
  currentItemRef.current = displayItem;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const isCtrlS = e.ctrlKey && key === 's';
      if (isCtrlS) e.preventDefault();

      if (e.ctrlKey && key === 'o') {
        e.preventDefault();
        e.stopPropagation();
        handleOpenFolderRef.current();
        return;
      }
      if (e.ctrlKey && key === 'l') {
        e.preventDefault();
        e.stopPropagation();
        handleLoadFileAndSaveRef.current();
        return;
      }
      if (e.ctrlKey && key === 'g') {
        e.preventDefault();
        e.stopPropagation();
        gotoInputRef.current?.focus();
        gotoInputRef.current?.select();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (
        e.key === 'Delete' &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        window.electron &&
        currentItemRef.current
      ) {
        e.preventDefault();
        e.stopPropagation();
        void handleDeleteCurrentImageRef.current();
        return;
      }
      if (isCtrlS) {
        if (currentItemRef.current) void saveCurrentRef.current();
        return;
      }
      if (navPromptRef.current) return;

      if (key === 'a' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        goPrevRef.current();
        return;
      }
      if (key === 'd' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        goNextRef.current();
        return;
      }

      const curClasses = classesRef.current;
      const curSelected = selectedClassRef.current;

      // 백틱: 모든 객체 표시/숨김 토글
      if (key === '`') {
        e.preventDefault();
        e.stopPropagation();
        setHiddenClassIds((prev) =>
          prev.length > 0 ? [] : curClasses.map((c) => c.id)
        );
        return;
      }
      // W / S: 활성 클래스 이전/다음
      if (curClasses.length > 0 && (key === 'w' || key === 's')) {
        e.preventDefault();
        e.stopPropagation();
        const idx = curClasses.findIndex((c) => c.id === curSelected?.id);
        if (key === 'w') {
          if (idx <= 0) setSelectedClass(curClasses[curClasses.length - 1]);
          else setSelectedClass(curClasses[idx - 1]);
        } else {
          if (idx < 0 || idx >= curClasses.length - 1) setSelectedClass(curClasses[0]);
          else setSelectedClass(curClasses[idx + 1]);
        }
        return;
      }
      // 1-9: 클래스 숫자 단축키
      if (key >= '1' && key <= '9') {
        const idx = parseInt(key, 10) - 1;
        if (idx < curClasses.length) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedClass(curClasses[idx]);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <header className="glass flex-shrink-0 border-b border-white/10 px-5 py-3 flex items-center gap-4 rounded-none overflow-visible">
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleOpenFolder} className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_20px_rgba(82,182,255,0.15)]" style={{ color: 'var(--accent-blue)' }}>폴더 열기</button>
          <div className="relative" ref={labelMenuRef}>
            <button
              ref={labelTriggerRef}
              type="button"
              onClick={() => setLabelMenuOpen((o) => !o)}
              className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_20px_rgba(82,182,255,0.15)] inline-flex items-center gap-1.5"
              style={{ color: 'var(--accent-blue)' }}
              aria-expanded={labelMenuOpen}
              aria-haspopup="true"
              title="클래스 세트 선택"
            >
              {savedClassSets.find((s) => s.id === activeClassSetId)?.displayName ?? '클래스 세트'}
              <svg className={`w-4 h-4 transition-transform ${labelMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {labelMenuOpen &&
              labelDropdownRect &&
              createPortal(
                <div
                  className="fixed py-1 min-w-[240px] max-h-[320px] overflow-auto rounded-xl glass border border-white/10 shadow-2xl bg-slate-900/95 backdrop-blur-xl"
                  style={{
                    top: labelDropdownRect.top + 4,
                    left: labelDropdownRect.left,
                    zIndex: 99999,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">저장된 세트</div>
                  {savedClassSets.length === 0 ? (
                    <div className="px-4 py-2 text-sm text-slate-500">저장된 세트 없음</div>
                  ) : (
                    savedClassSets.map((set) => (
                      <div
                        key={set.id}
                        className={`flex items-center gap-1 px-2 py-1.5 rounded-lg group ${activeClassSetId === set.id ? 'bg-[var(--accent-purple)]/20' : 'hover:bg-white/10'}`}
                      >
                        {renameId === set.id ? (
                          <input
                            ref={renameInputRef}
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => renameSavedSet(set.id, renameValue)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') renameSavedSet(set.id, renameValue);
                              if (e.key === 'Escape') { setRenameId(null); setRenameValue(''); }
                            }}
                            className="flex-1 min-w-0 px-2 py-0.5 text-sm bg-slate-800 border border-white/20 rounded text-white"
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => applySavedSet(set.id)}
                              className="flex-1 min-w-0 text-left text-sm text-slate-200 truncate py-0.5"
                            >
                              {set.displayName}
                              <span className="ml-1 text-slate-500 text-xs">({set.classNames.length})</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setRenameId(set.id); setRenameValue(set.displayName); }}
                              className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="이름 변경"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); removeSavedSet(set.id); }}
                              className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="삭제"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            </button>
                          </>
                        )}
                      </div>
                    ))
                  )}
                  <div className="border-t border-white/10 mt-1 pt-1">
                    <button
                      type="button"
                      onClick={handleLoadFileAndSave}
                      className="w-full px-4 py-2.5 text-left text-sm text-[var(--accent-blue)] hover:bg-white/10 transition-colors rounded-lg flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                      파일에서 불러와 저장 (Ctrl+L)
                    </button>
                  </div>
                </div>,
                document.body
              )}
          </div>
          <button type="button" onClick={() => void saveCurrent()} className="px-3.5 py-2 rounded-xl text-sm font-medium transition-all border border-[var(--accent-lime)]/50 shadow-[0_0_20px_rgba(168,230,27,0.2)] hover:shadow-[0_0_24px_rgba(168,230,27,0.3)]" style={{ backgroundColor: 'var(--accent-lime)', color: '#1A1A2E' }}>저장 (Ctrl+S)</button>
          <label
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-xl glass border border-white/10 text-xs text-slate-400 cursor-pointer select-none shrink-0"
            title="끄면 Ctrl+S·저장 버튼으로만 디스크에 기록 (이동 시 자동 저장 안 함)"
          >
            <input
              type="checkbox"
              checked={autoSave}
              onChange={(e) => setAutoSave(e.target.checked)}
              className="rounded border-white/20 shrink-0"
            />
            자동 저장
          </label>
          {displayItem && window.electron && (
            <button type="button" onClick={handleDeleteCurrentImage} className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:bg-red-500/20 hover:border-red-400/50 hover:text-red-400" title="현재 이미지와 라벨 파일 삭제 (Del)">
              <span className="inline-flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                이미지 삭제
              </span>
            </button>
          )}
          {imageList.length > 0 && (
            <button type="button" onClick={() => setShowStatsModal(true)} className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-purple)] hover:shadow-[0_0_20px_rgba(176,142,212,0.2)]" style={{ color: 'var(--accent-purple)' }} title="폴더 내 객체 통계">
              <span className="inline-flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                폴더 통계
              </span>
            </button>
          )}
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-3 ml-2">
          {browseFilterClassId !== null && (
            <span className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-[var(--accent-purple)]/50 bg-[var(--accent-purple)]/15 text-[var(--accent-purple)]" title="이 클래스가 포함된 이미지만 탐색 중">
              필터:
              <span className="truncate max-w-[10rem]">{classes.find((c) => c.id === browseFilterClassId)?.name ?? `ID ${browseFilterClassId}`}</span>
              <button
                type="button"
                onClick={() => setBrowseFilter(null)}
                className="ml-0.5 px-1.5 py-0.5 rounded-md hover:bg-white/10 text-slate-200"
              >
                해제
              </button>
            </span>
          )}
          {statusFilter !== 'all' && (
            <span className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-amber-400/40 bg-amber-400/10 text-amber-200" title="상태 필터 적용 중">
              상태:
              <span>{STATUS_FILTER_OPTIONS.find((o) => o.value === statusFilter)?.label ?? statusFilter}</span>
              <button
                type="button"
                onClick={() => setStatusFilter('all')}
                className="ml-0.5 px-1.5 py-0.5 rounded-md hover:bg-white/10 text-slate-200"
              >
                해제
              </button>
            </span>
          )}
          {displayItem && displayMeta ? (
            <span
              className={`shrink-0 inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold border ${workflowStatusBadgeClass(displayMeta.workflowStatus)}`}
            >
              {workflowStatusLabel(displayMeta.workflowStatus)}
            </span>
          ) : null}
          {displayItem ? (
            <span className="text-base font-bold font-mono truncate max-w-md min-w-0" style={{ color: 'var(--accent-lime)' }} title={displayItem.name}>{displayItem.name}</span>
          ) : (
            <span className="text-slate-400 text-sm truncate min-w-0" title={statusMessage}>{statusMessage || '\u00A0'}</span>
          )}
        </div>
      </header>

      <div className="glass flex-shrink-0 border-b border-white/10 px-5 py-2.5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500 shrink-0">역할</label>
          <select
            value={workflowRole}
            onChange={(e) => setWorkflowRole(e.target.value === 'reviewer' ? 'reviewer' : 'worker')}
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 border border-white/10 text-sm text-white focus:border-[var(--accent-blue)] outline-none"
          >
            <option value="worker">작업자</option>
            <option value="reviewer">검수자</option>
          </select>
        </div>
        <div className="flex items-center gap-2 min-w-[10rem]">
          <label className="text-xs text-slate-500 shrink-0">이름</label>
          <input
            type="text"
            value={workflowUser}
            onChange={(e) => setWorkflowUser(e.target.value)}
            placeholder="홍길동"
            className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-slate-800 border border-white/10 text-sm text-white placeholder:text-slate-600 focus:border-[var(--accent-blue)] outline-none"
          />
        </div>
        <div className="h-5 w-px bg-white/10 hidden sm:block" />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500 mr-1">상태 필터</span>
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatusFilter(opt.value)}
              disabled={imageList.length === 0 || isBrowseFilterScanning}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40 ${
                statusFilter === opt.value
                  ? 'border-[var(--accent-blue)]/60 bg-[var(--accent-blue)]/15 text-[var(--accent-blue)]'
                  : 'border-transparent bg-white/5 text-slate-400 hover:text-slate-200 hover:border-white/10'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <aside className="glass w-72 flex-shrink-0 border-r border-white/10 overflow-auto flex flex-col">
          <div className="p-3 pb-2">
            <div className="text-[11px] font-bold uppercase tracking-widest mb-3 text-slate-400">Classes (1-9)</div>
            {browseFilterClassId !== null && (
              <div className="mb-2 px-2 py-1.5 rounded-lg bg-[var(--accent-purple)]/10 border border-[var(--accent-purple)]/30 text-[12px] text-slate-300">
                <div>
                  <span className="text-slate-400">탐색: </span>
                  <span className="font-semibold text-[var(--accent-purple)]">
                    {classes.find((c) => c.id === browseFilterClassId)?.name ?? `ID ${browseFilterClassId}`}
                  </span>
                  <span className="text-slate-500"> 만 표시</span>
                </div>
                {isBrowseFilterScanning && browseFilterScanProgress && browseFilterScanProgress.total > 0 && (
                  <div className="mt-2 space-y-1">
                    <div className="flex justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-400">
                      <span className="truncate">라벨 검사</span>
                      <span className="shrink-0">
                        {browseFilterScanProgress.done} / {browseFilterScanProgress.total} (
                        {Math.round((browseFilterScanProgress.done / browseFilterScanProgress.total) * 100)}
                        %)
                      </span>
                    </div>
                    <div
                      className="h-1.5 rounded-full bg-white/10 overflow-hidden border border-white/5"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={browseFilterScanProgress.total}
                      aria-valuenow={browseFilterScanProgress.done}
                      aria-label="라벨 검사 진행"
                    >
                      <div
                        className="h-full rounded-full transition-[width] duration-150 ease-out"
                        style={{
                          width: `${Math.max(0, Math.min(100, (browseFilterScanProgress.done / browseFilterScanProgress.total) * 100))}%`,
                          backgroundColor: 'var(--accent-purple)',
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
            {classes.length === 0 ? (
              <div className="glass-card p-4 text-center">
                <p className="text-slate-400 text-sm">라벨 파일을 열어</p>
                <p className="text-slate-400 text-sm mt-0.5">클래스를 불러오세요.</p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {classes.map((c, idx) => {
                  const displayColor = customClassColors[c.id] ?? c.color;
                  const isSelected = selectedClass?.id === c.id;
                  const boxCount = classBoxCounts.get(c.id) ?? 0;
                  const countBadgeClass =
                    boxCount === 0
                      ? 'text-slate-500 border-transparent'
                      : boxCount === 1
                        ? 'border-red-400/40 shadow-[0_0_10px_rgba(239,68,68,0.35)]'
                        : 'border-white/25 shadow-[0_0_10px_rgba(168,230,27,0.3)]';
                  const countBadgeStyle =
                    boxCount === 0
                      ? undefined
                      : boxCount === 1
                        ? { backgroundColor: '#ef4444', color: '#ffffff' }
                        : { backgroundColor: 'var(--accent-lime)', color: '#1A1A2E' };
                  return (
                  <li key={c.id} className="group flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedClass(c)}
                      className={`flex-1 min-w-0 flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm text-left transition-all border ${isSelected ? 'bg-[rgba(176,142,212,0.35)] border-[var(--accent-purple)] border-2 shadow-[0_0_20px_rgba(176,142,212,0.4)] ring-2 ring-[var(--accent-purple)]/30' : 'border-transparent bg-transparent hover:bg-white/5 hover:border-white/10 text-slate-300'}`}
                      style={isSelected ? { color: '#fff' } : undefined}
                    >
                      <div className="relative shrink-0 flex items-center justify-center">
                        <input
                          type="color"
                          id={`class-color-${c.id}`}
                          value={displayColor}
                          onChange={(e) => setCustomClassColors((prev) => ({ ...prev, [c.id]: e.target.value }))}
                          className="absolute w-4 h-4 opacity-0 cursor-pointer"
                          style={{ left: 0, top: 0 }}
                          tabIndex={-1}
                          aria-label={`${c.name} 색상 변경`}
                          title="색상 변경"
                        />
                        <span
                          role="button"
                          tabIndex={0}
                          className="block w-4 h-4 rounded-full border-2 border-white/30 shadow-inner cursor-pointer hover:scale-110 transition-transform hover:ring-2 hover:ring-white/50"
                          style={{ backgroundColor: displayColor }}
                          onClick={(e) => { e.stopPropagation(); document.getElementById(`class-color-${c.id}`)?.click(); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); document.getElementById(`class-color-${c.id}`)?.click(); } }}
                          title="색상 변경"
                        />
                      </div>
                      <div className="flex items-baseline gap-1.5 min-w-0 flex-1" title={`단축키 ${idx + 1}`}>
                        <span className={`truncate font-semibold min-w-0 ${hiddenClassIds.includes(c.id) ? 'text-slate-600 line-through' : ''} ${isSelected ? 'text-white' : 'text-slate-200'}`}>
                          {c.name}
                        </span>
                        <span className={`shrink-0 text-[11px] font-mono tabular-nums ${isSelected ? 'text-white/80' : 'text-slate-500'}`}>
                          {idx + 1}
                        </span>
                      </div>
                      <span
                        className={`shrink-0 tabular-nums text-xs font-bold leading-none rounded-full px-2 py-0.5 text-right border min-w-[1.35rem] ${countBadgeClass}`}
                        style={countBadgeStyle}
                        title="현재 이미지 박스 수"
                      >
                        {boxCount}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setBrowseFilter(browseFilterClassId === c.id ? null : c.id)}
                      disabled={imageList.length === 0 || isBrowseFilterScanning}
                      className={`shrink-0 p-1.5 rounded-xl transition-all border disabled:opacity-30 disabled:cursor-not-allowed ${
                        browseFilterClassId === c.id
                          ? 'bg-[var(--accent-purple)]/30 border-[var(--accent-purple)]/60 text-[var(--accent-purple)]'
                          : 'border-transparent bg-transparent text-slate-500 hover:bg-white/5 hover:text-slate-200 hover:border-white/10'
                      }`}
                      title={browseFilterClassId === c.id ? '이 클래스만 보기 해제' : '이 클래스가 있는 이미지만 탐색'}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => setHiddenClassIds((prev) => (prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id]))}
                      className={`shrink-0 p-1.5 rounded-xl transition-all border ${hiddenClassIds.includes(c.id) ? 'bg-red-500/20 border-red-400/40 text-red-400' : 'border-transparent bg-transparent text-slate-500 hover:bg-white/5 hover:text-slate-200 hover:border-white/10'}`}
                      title={hiddenClassIds.includes(c.id) ? '클래스 표시' : '클래스 숨김'}
                    >
                      {hiddenClassIds.includes(c.id) ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" /></svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                      )}
                    </button>
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
          {imageList.length > 0 && (
            <div className="mt-auto p-3 pt-2 border-t border-white/10">
              <div className="text-[11px] font-bold uppercase tracking-widest mb-1.5 text-slate-500">Goto (Ctrl+G)</div>
              <div className="flex items-start gap-2.5">
                <div className="flex items-center gap-2 shrink-0">
                  <input
                    ref={gotoInputRef}
                    type="number"
                    min={1}
                    max={Math.max(1, navCount)}
                    value={gotoValue}
                    disabled={isBrowseFilterScanning || navCount === 0}
                    onChange={(e) => setGotoValue(e.target.value.replace(/[^0-9]/g, ''))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const num = Math.min(navCount, Math.max(1, parseInt(gotoValue, 10) || 1));
                        setGotoValue(String(num));
                        void goToIndex(num - 1);
                        gotoInputRef.current?.blur();
                      }
                    }}
                    onBlur={() => setGotoValue(String(currentIndex + 1))}
                    className="w-16 px-2 py-1.5 text-sm font-mono tabular-nums rounded-lg bg-slate-800 border border-white/10 text-white focus:border-[var(--accent-blue)] focus:ring-1 focus:ring-[var(--accent-blue)] outline-none disabled:opacity-40"
                    title={browseFilterClassId !== null ? '필터된 목록에서 번호 입력 후 Enter' : '이미지 번호 입력 후 Enter'}
                  />
                  <span className="text-slate-500 text-sm">/ {navCount}</span>
                </div>
                {displayItem && displayMeta && window.electron ? (
                  <div className="flex flex-col gap-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {workflowRole === 'worker' &&
                        (displayMeta.workflowStatus === 'draft' || displayMeta.workflowStatus === 'rejected') && (
                          <button
                            type="button"
                            onClick={() => void handleSubmitForReview()}
                            className="px-2.5 py-1 rounded-lg text-xs font-medium border border-amber-400/50 bg-amber-400/15 text-amber-100 hover:bg-amber-400/25 transition-colors whitespace-nowrap"
                          >
                            {displayMeta.workflowStatus === 'rejected' ? '재검수' : '검수 요청'}
                          </button>
                        )}
                      {workflowRole === 'reviewer' && displayMeta.workflowStatus === 'submitted' && (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleApprove()}
                            className="px-2.5 py-1 rounded-lg text-xs font-medium border border-emerald-400/50 bg-emerald-400/15 text-emerald-100 hover:bg-emerald-400/25 transition-colors"
                          >
                            승인
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleReject()}
                            className="px-2.5 py-1 rounded-lg text-xs font-medium border border-red-400/50 bg-red-400/15 text-red-200 hover:bg-red-400/25 transition-colors"
                          >
                            반려
                          </button>
                        </>
                      )}
                    </div>
                    {labelsReadOnly ? (
                      <span className="text-[11px] text-slate-500">읽기 전용</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </aside>

        <main className="flex-1 flex flex-col min-w-0" style={{ backgroundColor: 'var(--bg-deep)' }}>
          {imageList.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
              <div className="glass-card w-20 h-20 rounded-2xl flex items-center justify-center">
                <svg className="w-10 h-10" style={{ color: 'var(--accent-blue)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14" /></svg>
              </div>
              <p className="text-sm font-medium text-slate-300">작업 폴더를 열어 이미지를 불러오세요</p>
              <p className="text-xs text-slate-500">Ctrl+O 또는 상단 [폴더] 버튼</p>
            </div>
          ) : isBrowseFilterScanning ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-5 p-8 w-full max-w-md mx-auto">
              <div className="w-10 h-10 border-2 border-[var(--accent-purple)] border-t-transparent rounded-full animate-spin shrink-0" />
              <div className="text-center space-y-1">
                <p className="text-sm font-medium text-slate-300">클래스 필터 적용 중</p>
                <p className="text-xs text-slate-500">폴더의 라벨(.txt)을 검사하고 있습니다</p>
              </div>
              {browseFilterScanProgress && browseFilterScanProgress.total > 0 ? (
                <>
                  <p className="text-sm font-mono tabular-nums text-slate-300">
                    {browseFilterScanProgress.done} / {browseFilterScanProgress.total}
                    <span className="text-slate-500 ml-2">
                      {Math.round((browseFilterScanProgress.done / browseFilterScanProgress.total) * 100)}%
                    </span>
                  </p>
                  <div
                    className="w-full h-2.5 rounded-full bg-white/10 overflow-hidden border border-white/10"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={browseFilterScanProgress.total}
                    aria-valuenow={browseFilterScanProgress.done}
                    aria-label="라벨 검사 진행"
                  >
                    <div
                      className="h-full rounded-full transition-[width] duration-150 ease-out"
                      style={{
                        width: `${Math.max(0, Math.min(100, (browseFilterScanProgress.done / browseFilterScanProgress.total) * 100))}%`,
                        backgroundColor: 'var(--accent-purple)',
                      }}
                    />
                  </div>
                </>
              ) : (
                <p className="text-xs text-slate-500">준비 중…</p>
              )}
            </div>
          ) : (browseFilterClassId !== null || statusFilter !== 'all') && navCount === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
              <div className="glass-card w-20 h-20 rounded-2xl flex items-center justify-center">
                <svg className="w-10 h-10 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>
              </div>
              <p className="text-sm font-medium text-slate-300">필터 조건에 맞는 이미지가 없습니다</p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {browseFilterClassId !== null ? (
                  <button type="button" onClick={() => setBrowseFilter(null)} className="px-4 py-2 rounded-xl glass border border-white/10 text-sm text-[var(--accent-blue)] hover:border-[var(--accent-blue)]">
                    클래스 필터 해제
                  </button>
                ) : null}
                {statusFilter !== 'all' ? (
                  <button type="button" onClick={() => setStatusFilter('all')} className="px-4 py-2 rounded-xl glass border border-white/10 text-sm text-[var(--accent-blue)] hover:border-[var(--accent-blue)]">
                    상태 필터 해제
                  </button>
                ) : null}
              </div>
            </div>
          ) : !currentItem ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
              <div className="glass-card w-20 h-20 rounded-2xl flex items-center justify-center">
                <svg className="w-10 h-10" style={{ color: 'var(--accent-blue)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14" /></svg>
              </div>
              <p className="text-sm font-medium text-slate-300">이미지를 불러올 수 없습니다</p>
            </div>
          ) : !displayItem ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
              <div className="glass-card w-16 h-16 rounded-2xl flex items-center justify-center animate-pulse">
                <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              </div>
              <p className="text-sm text-slate-400">라벨 로딩 중...</p>
            </div>
          ) : (
            <>
              <div className="flex-1 relative overflow-hidden bg-black">
                <AnnotationCanvas
                  imageUrl={displayItem.imageUrl}
                  annotations={displayAnnotations}
                  currentClass={selectedClass ?? { id: -1, name: 'None', color: '#666' }}
                  classes={classes}
                  readOnly={labelsReadOnly}
                  onUpdateAnnotations={handleUpdateAnnotations}
                  hiddenClassIds={hiddenClassIds}
                  customClassColors={customClassColors}
                  undoSignal={undoSignal}
                  redoSignal={redoSignal}
                />
              </div>
              <footer className="glass flex-shrink-0 border-t border-white/10 px-4 py-2.5 flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={goPrev} disabled={isBrowseFilterScanning || browseFilterLoading || navCount <= 0 || currentIndex <= 0} className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_16px_rgba(82,182,255,0.15)] disabled:hover:border-white/10 disabled:hover:shadow-none" style={{ color: 'var(--accent-blue)' }}>이전 (A)</button>
                  <button type="button" onClick={goNext} disabled={isBrowseFilterScanning || browseFilterLoading || navCount <= 0 || currentIndex >= navCount - 1} className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_16px_rgba(82,182,255,0.15)] disabled:hover:border-white/10 disabled:hover:shadow-none" style={{ color: 'var(--accent-blue)' }}>다음 (D)</button>
                </div>
                {navCount > 0 && (
                  <>
                    <span className="shrink-0 text-lg font-bold tabular-nums whitespace-nowrap" style={{ color: 'var(--accent-blue)' }}>
                      {currentIndex + 1} / {navCount}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, navCount - 1)}
                      value={Math.min(currentIndex, Math.max(0, navCount - 1))}
                      onChange={(e) => {
                        const next = parseInt(e.target.value, 10);
                        if (next !== currentIndex) {
                          void goToIndex(next);
                        }
                      }}
                      className="progress-slider flex-1 min-w-0 h-2 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white/30 [&::-webkit-slider-thumb]:shadow-lg [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0"
                      style={{ background: 'rgba(255,255,255,0.1)' }}
                    />
                  </>
                )}
              </footer>
            </>
          )}
        </main>

        {displayItem && displayMeta ? (
          <aside className="glass w-72 flex-shrink-0 border-l border-white/10 overflow-hidden flex flex-col min-h-0">
            <LabelHistoryPanel history={displayMeta.changeHistory} />
          </aside>
        ) : null}
      </div>

      <WorkflowNavigateModal
        prompt={navPrompt}
        itemLabel={displayItem?.name}
        busy={navBusy}
        onCancel={() => void handleNavCancel()}
        onConfirm={() => void handleNavConfirm()}
      />

      {/* 폴더 통계 모달 */}
      {showStatsModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowStatsModal(false)}>
          <div className="glass-card max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col border border-white/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <h2 className="text-lg font-bold text-white">폴더 통계</h2>
              <button type="button" onClick={() => setShowStatsModal(false)} className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition-colors" aria-label="닫기">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-5 overflow-auto flex-1 min-h-0">
              {statsLoading ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <div className="w-10 h-10 border-2 border-[var(--accent-purple)] border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-slate-400">통계 계산 중...</p>
                </div>
              ) : folderStats ? (
                <div className="space-y-5">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="glass rounded-xl p-4 border border-white/10">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">총 이미지</p>
                      <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--accent-blue)' }}>{folderStats.totalImages}</p>
                    </div>
                    <div className="glass rounded-xl p-4 border border-white/10">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">총 객체 수</p>
                      <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--accent-lime)' }}>{folderStats.totalBoxes}</p>
                    </div>
                    <div className="glass rounded-xl p-4 border border-white/10">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">라벨 있음</p>
                      <p className="text-xl font-bold tabular-nums text-emerald-300">{folderStats.imagesWithLabels}</p>
                    </div>
                    <div className="glass rounded-xl p-4 border border-white/10">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">라벨 없음</p>
                      <p className="text-xl font-bold tabular-nums text-amber-300">{folderStats.imagesWithoutLabels}</p>
                    </div>
                  </div>
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">클래스별 객체 수</h3>
                    {folderStats.byClass.length === 0 ? (
                      <p className="text-sm text-slate-400">객체가 없습니다.</p>
                    ) : (
                      <div className="space-y-2.5">
                        {folderStats.byClass.map((row) => {
                          const pct = folderStats!.totalBoxes > 0 ? (row.count / folderStats!.totalBoxes) * 100 : 0;
                          return (
                            <div key={row.classId} className="flex items-center gap-3">
                              <span className="w-28 shrink-0 text-sm font-medium text-slate-200 truncate" title={row.name}>{row.name}</span>
                              <div className="flex-1 min-w-0 h-6 rounded-lg bg-slate-800/80 overflow-hidden">
                                <div
                                  className="h-full rounded-lg transition-all min-w-0"
                                  style={{ width: `${Math.max(2, pct)}%`, backgroundColor: 'var(--accent-purple)', opacity: 0.85 }}
                                />
                              </div>
                              <span className="w-12 shrink-0 text-right text-sm font-bold tabular-nums text-slate-300">{row.count}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default YoloWorkspace;
