/// <reference types="vite/client" />
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { YoloClass } from '../types';
import { COLOR_PALETTE } from '../constants';
import type { PolygonShapePixel } from '../polygonTypes';
import {
  buildPolygonFile,
  deriveJsonPath,
  extractEditableShapes,
  imageBasename,
  parsePolygonFileJson,
  serializePolygonFile,
} from '../polygonFormat';
import PolygonCanvas from '../components/PolygonCanvas';

interface OfflineImageItem {
  name: string;
  imagePath: string;
  txtPath: string;
  imageUrl: string;
}

interface SavedClassSet {
  id: string;
  displayName: string;
  classNames: string[];
}

type ShapesChangeOptions = { recordHistory?: boolean };

const SAVED_SETS_STORAGE_KEY = 'intellivixPolygon.savedClassSetsV1';

function classNamesToYoloClasses(classNames: string[]): YoloClass[] {
  return classNames.map((name, index) => ({
    id: index,
    name,
    color: COLOR_PALETTE[index % COLOR_PALETTE.length],
  }));
}

function cloneShapes(list: PolygonShapePixel[]): PolygonShapePixel[] {
  return list.map((sh) => ({
    ...sh,
    points: sh.points.map(([x, y]) => [x, y] as [number, number]),
  }));
}

function applyShapeClickSelection(current: string[], shapeId: string, shiftKey: boolean): string[] {
  if (shiftKey) {
    return current.includes(shapeId) ? current.filter((id) => id !== shapeId) : [...current, shapeId];
  }
  return [shapeId];
}

async function loadShapesFromJson(jsonPath: string): Promise<PolygonShapePixel[]> {
  if (!window.electron) return [];
  const res = await window.electron.readJsonFile(jsonPath);
  if (!res.ok || !res.text) return [];
  const parsed = parsePolygonFileJson(res.text);
  if (!parsed.ok) return [];
  return extractEditableShapes(parsed.data);
}

type PolygonClipboardEntry = Pick<PolygonShapePixel, 'label' | 'points'>;

type PolygonClipboardState = {
  sourceImagePath: string;
  shapes: PolygonClipboardEntry[];
};

const PolygonWorkspace: React.FC = () => {
  const [workFolderPath, setWorkFolderPath] = useState<string | null>(null);
  const [imageList, setImageList] = useState<OfflineImageItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [classes, setClasses] = useState<YoloClass[]>([]);
  const [selectedClass, setSelectedClass] = useState<YoloClass | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [activeTool, setActiveTool] = useState<'draw' | 'select'>('draw');
  const [selectedShapeIds, setSelectedShapeIds] = useState<string[]>([]);
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
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [shapesVisible, setShapesVisible] = useState(true);

  const [displayItem, setDisplayItem] = useState<OfflineImageItem | null>(null);
  const [displayShapes, setDisplayShapes] = useState<PolygonShapePixel[]>([]);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  const displayItemRef = useRef<OfflineImageItem | null>(null);
  const displayShapesRef = useRef<PolygonShapePixel[]>([]);
  const [customLabelColors, setCustomLabelColors] = useState<Record<number, string>>({});
  const lastWriteWarningRef = useRef<{ path: string; at: number } | null>(null);
  const undoStackRef = useRef<PolygonShapePixel[][]>([]);
  const redoStackRef = useRef<PolygonShapePixel[][]>([]);
  const clipboardRef = useRef<PolygonClipboardState>({ sourceImagePath: '', shapes: [] });
  const pasteGenRef = useRef(0);
  const currentIndexRef = useRef(0);
  const navInFlightRef = useRef(false);
  const queuedNavIndexRef = useRef<number | null>(null);
  const [sliderIndex, setSliderIndex] = useState(0);
  const pushHistoryRef = useRef<(() => void) | null>(null);

  const isElectron = typeof window !== 'undefined' && !!window.electron;
  const navCount = imageList.length;
  const currentItem = navCount > 0 && currentIndex >= 0 && currentIndex < navCount ? imageList[currentIndex]! : null;

  const activeToolRef = useRef(activeTool);
  const selectedShapeIdsRef = useRef(selectedShapeIds);
  const classesRef = useRef(classes);
  const selectedClassRef = useRef(selectedClass);
  useEffect(() => {
    activeToolRef.current = activeTool;
    selectedShapeIdsRef.current = selectedShapeIds;
  }, [activeTool, selectedShapeIds]);
  useEffect(() => {
    classesRef.current = classes;
    selectedClassRef.current = selectedClass;
  }, [classes, selectedClass]);

  useEffect(() => {
    naturalSizeRef.current = naturalSize;
  }, [naturalSize]);

  useEffect(() => {
    displayItemRef.current = displayItem;
    displayShapesRef.current = displayShapes;
  }, [displayItem, displayShapes]);

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
        setCustomLabelColors(colors);
      }
      setStorageRestored(true);
    } catch {
      setStorageRestored(true);
    }
  }, []);

  const persistSavedSets = useCallback(() => {
    try {
      localStorage.setItem(
        SAVED_SETS_STORAGE_KEY,
        JSON.stringify({
          savedClassSets,
          activeClassSetId,
          customColors: customLabelColors,
        })
      );
    } catch {
      /* ignore */
    }
  }, [savedClassSets, activeClassSetId, customLabelColors]);

  useEffect(() => {
    if (!storageRestored) return;
    persistSavedSets();
  }, [storageRestored, persistSavedSets]);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
    setSliderIndex(currentIndex);
  }, [currentIndex]);

  useEffect(() => {
    setDisplayShapes([]);
    setNaturalSize(null);
    setSelectedShapeIds([]);
    undoStackRef.current = [];
    redoStackRef.current = [];
    clipboardRef.current = { sourceImagePath: '', shapes: [] };
    pasteGenRef.current = 0;
    if (imageList.length === 0) setDisplayItem(null);
  }, [imageList]);

  useEffect(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    pasteGenRef.current = 0;
  }, [displayItem?.imagePath]);

  const loadShapesForItem = useCallback(async (item: OfflineImageItem): Promise<PolygonShapePixel[]> => {
    const jsonPath = deriveJsonPath(item.imagePath);
    return loadShapesFromJson(jsonPath);
  }, []);

  useEffect(() => {
    if (!currentItem?.imagePath) return;
    setNaturalSize(null);
  }, [currentItem?.imagePath]);

  useEffect(() => {
    if (!currentItem || !window.electron) {
      setDisplayItem(null);
      setDisplayShapes([]);
      return;
    }
    const item = currentItem;
    setDisplayItem(item);
    setDisplayShapes([]);
    let cancelled = false;
    loadShapesForItem(item).then((loaded) => {
      if (cancelled) return;
      setDisplayShapes(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [currentItem, loadShapesForItem]);

  useEffect(() => {
    if (navCount > 0) setGotoValue(String(currentIndex + 1));
    else setGotoValue('');
  }, [currentIndex, navCount]);

  useEffect(() => {
    if (navCount === 0) return;
    if (currentIndex >= navCount) setCurrentIndex(navCount - 1);
  }, [navCount, currentIndex]);

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

  const colorForLabel = useCallback(
    (label: string) => {
      const c = classes.find((x) => x.name === label);
      if (c) return customLabelColors[c.id] ?? c.color;
      let h = 0;
      for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
      return COLOR_PALETTE[h % COLOR_PALETTE.length];
    },
    [classes, customLabelColors]
  );

  const activeLabel = selectedClass?.name ?? 'unknown';

  const notifyJsonWriteFailure = useCallback((item: OfflineImageItem, jsonPath: string) => {
    const status = `저장 실패: ${item.name} (JSON 쓰기 권한 확인)`;
    setStatusMessage(status);
    const now = Date.now();
    const last = lastWriteWarningRef.current;
    if (last && last.path === jsonPath && now - last.at < 5000) return;
    lastWriteWarningRef.current = { path: jsonPath, at: now };
    window.alert(
      [
        `폴리곤 JSON 저장에 실패했습니다: ${item.name}`,
        '작업 폴더에 쓰기 권한이 없거나 읽기 전용/보안 정책으로 차단되었을 수 있습니다.',
        '폴더 권한을 확인한 뒤 다시 시도해 주세요.',
        '',
        `대상 파일: ${jsonPath}`,
      ].join('\n')
    );
  }, []);

  const writePolygonJson = useCallback(
    async (item: OfflineImageItem, shapes: PolygonShapePixel[], size: { w: number; h: number }) => {
      if (!window.electron) return false;
      const jsonPath = deriveJsonPath(item.imagePath);
      const file = buildPolygonFile(imageBasename(item.imagePath), size.w, size.h, shapes);
      const ok = await window.electron.writeJsonFile(jsonPath, serializePolygonFile(file));
      if (!ok) {
        notifyJsonWriteFailure(item, jsonPath);
        return false;
      }
      return true;
    },
    [notifyJsonWriteFailure]
  );

  const pushHistory = useCallback(() => {
    undoStackRef.current = [...undoStackRef.current, cloneShapes(displayShapesRef.current)];
    redoStackRef.current = [];
  }, []);

  pushHistoryRef.current = pushHistory;

  const handleShapesChange = useCallback(
    (next: PolygonShapePixel[], options?: ShapesChangeOptions) => {
      if (options?.recordHistory !== false) {
        pushHistory();
      }
      setDisplayShapes(next);
      setSelectedShapeIds((prev) => prev.filter((id) => next.some((s) => s.id === id)));
    },
    [pushHistory]
  );

  const applyUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1]!;
    undoStackRef.current = stack.slice(0, -1);
    redoStackRef.current = [...redoStackRef.current, cloneShapes(displayShapesRef.current)];
    handleShapesChange(prev, { recordHistory: false });
  }, [handleShapesChange]);

  const applyRedo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const next = stack[stack.length - 1]!;
    redoStackRef.current = stack.slice(0, -1);
    undoStackRef.current = [...undoStackRef.current, cloneShapes(displayShapesRef.current)];
    handleShapesChange(next, { recordHistory: false });
  }, [handleShapesChange]);

  const copyShapesToClipboard = useCallback(() => {
    const size = naturalSizeRef.current;
    if (!size || size.w <= 0 || size.h <= 0) return;
    const sids = selectedShapeIdsRef.current;
    const cur = displayShapesRef.current;
    const picked = sids.length > 0 ? cur.filter((s) => sids.includes(s.id)) : cur;
    if (picked.length === 0) return;
    clipboardRef.current = {
      sourceImagePath: displayItemRef.current?.imagePath ?? '',
      shapes: picked.map((sh) => ({
        label: sh.label,
        points: sh.points.map(([x, y]) => [x / size.w, y / size.h] as [number, number]),
      })),
    };
  }, []);

  const pasteShapesFromClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    if (clip.shapes.length === 0) return;
    const size = naturalSizeRef.current;
    const w = size?.w ?? 0;
    const h = size?.h ?? 0;
    if (w <= 0 || h <= 0) return;
    const item = displayItemRef.current;
    const sameImage = !!item && clip.sourceImagePath === item.imagePath;
    let step = 0;
    if (sameImage) {
      if (pasteGenRef.current > 0) {
        step = Math.max(8, Math.min(w, h) * 0.015) * pasteGenRef.current;
      }
      pasteGenRef.current += 1;
    } else {
      pasteGenRef.current = 0;
    }
    const pasted = clip.shapes.map((sh) => ({
      id: crypto.randomUUID(),
      label: sh.label,
      points: sh.points.map(([nx, ny]) => [
        Math.min(w, Math.max(0, nx * w + step)),
        Math.min(h, Math.max(0, ny * h + step)),
      ] as [number, number]),
    }));
    handleShapesChange([...displayShapesRef.current, ...pasted], { recordHistory: true });
    setSelectedShapeIds(pasted.map((p) => p.id));
    setActiveTool('select');
  }, [handleShapesChange]);

  const applyLabelToSelectedShapes = useCallback(
    (label: string) => {
      if (selectedShapeIds.length === 0) return;
      const selected = new Set(selectedShapeIds);
      const next = displayShapes.map((s) => (selected.has(s.id) ? { ...s, label } : s));
      handleShapesChange(next);
    },
    [selectedShapeIds, displayShapes, handleShapesChange]
  );

  const selectClass = useCallback(
    (cls: YoloClass) => {
      setSelectedClass(cls);
      if (activeTool === 'select' && selectedShapeIds.length > 0) {
        applyLabelToSelectedShapes(cls.name);
      }
    },
    [activeTool, selectedShapeIds.length, applyLabelToSelectedShapes]
  );

  const saveCurrent = useCallback(async () => {
    const item = displayItemRef.current;
    const size = naturalSizeRef.current;
    if (!window.electron || !item || !size) return true;
    return writePolygonJson(item, displayShapesRef.current, size);
  }, [writePolygonJson]);

  const handleOpenFolder = async () => {
    if (!window.electron) return;
    try {
      const path = await window.electron.openFolderDialog();
      if (!path) return;
      await window.electron.setWorkspaceRoot(path);
      const list = await window.electron.scanFolder(path);
      setWorkFolderPath(path);
      setImageList(list);
      setCurrentIndex(0);
      setStatusMessage(`폴더 열림: ${path} — 하위 폴더 포함 ${list.length}개 이미지`);
    } catch (e) {
      setStatusMessage('폴더 열기 실패: ' + (e as Error).message);
    }
  };

  const handleLoadFileAndSave = async () => {
    if (!window.electron) return;
    setLabelMenuOpen(false);
    try {
      const path = await window.electron.openLabelFileDialog();
      if (!path) return;
      const content = await window.electron.readLabelFile(path);
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      const displayName = path.replace(/^.*[/\\]/, '').replace(/\.txt$/i, '') || 'classes';
      const newSet: SavedClassSet = {
        id: crypto.randomUUID(),
        displayName,
        classNames: lines,
      };
      setSavedClassSets((prev) => [...prev, newSet]);
      setActiveClassSetId(newSet.id);
      const yolo = classNamesToYoloClasses(newSet.classNames);
      setClasses(yolo);
      setSelectedClass(yolo[0] ?? null);
      setStatusMessage(`저장됨: ${newSet.displayName} (${lines.length}개 라벨)`);
    } catch (e) {
      setStatusMessage('라벨 파일 열기 실패: ' + (e as Error).message);
    }
  };

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

  const renameSavedSet = useCallback((id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setSavedClassSets((prev) => prev.map((s) => (s.id === id ? { ...s, displayName: trimmed } : s)));
    setRenameId(null);
    setRenameValue('');
  }, []);

  const removeSavedSet = useCallback(
    (id: string) => {
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
    },
    [activeClassSetId]
  );

  const flushNavQueue = useCallback(async () => {
    if (navInFlightRef.current) return;
    navInFlightRef.current = true;
    try {
      while (queuedNavIndexRef.current !== null) {
        const target = queuedNavIndexRef.current;
        queuedNavIndexRef.current = null;
        if (target < 0 || target >= navCount || target === currentIndexRef.current) continue;
        const ok = await saveCurrent();
        if (!ok) {
          setSliderIndex(currentIndexRef.current);
          break;
        }
        setCurrentIndex(target);
        currentIndexRef.current = target;
        setSliderIndex(target);
      }
    } finally {
      navInFlightRef.current = false;
      if (queuedNavIndexRef.current !== null) {
        void flushNavQueue();
      }
    }
  }, [navCount, saveCurrent]);

  const goToIndex = useCallback(
    (nextIndex: number) => {
      if (navCount <= 0 || nextIndex < 0 || nextIndex >= navCount) return;
      if (nextIndex === currentIndexRef.current) {
        setSliderIndex(nextIndex);
        return;
      }
      queuedNavIndexRef.current = nextIndex;
      setSliderIndex(nextIndex);
      void flushNavQueue();
    },
    [flushNavQueue, navCount]
  );

  const goPrev = useCallback(() => {
    void goToIndex(currentIndex - 1);
  }, [currentIndex, goToIndex]);

  const goNext = useCallback(() => {
    void goToIndex(currentIndex + 1);
  }, [currentIndex, goToIndex]);

  const handleDeleteCurrentImage = useCallback(async () => {
    if (!window.electron || !displayItem) return;
    const jsonPath = deriveJsonPath(displayItem.imagePath);
    const msg = `현재 이미지와 같은 이름의 JSON 라벨을 삭제할까요?\n이 작업은 되돌릴 수 없습니다.\n\n${displayItem.name}`;
    if (!window.confirm(msg)) return;
    const result = await window.electron.deleteImagePolygonJson(displayItem.imagePath, jsonPath);
    if (!result.ok) {
      setStatusMessage('삭제 실패: ' + (result.error || '알 수 없음'));
      return;
    }
    const nextList = imageList.filter((item) => item.imagePath !== displayItem.imagePath);
    setImageList(nextList);
    if (nextList.length === 0) {
      setDisplayItem(null);
      setDisplayShapes([]);
      setCurrentIndex(0);
      setStatusMessage('이미지와 JSON이 삭제되었습니다.');
      return;
    }
    const nextIndex = currentIndex >= nextList.length ? nextList.length - 1 : currentIndex;
    setCurrentIndex(nextIndex);
    setStatusMessage(`삭제됨: ${displayItem.name}`);
  }, [displayItem, imageList, currentIndex]);

  const handleDeleteCurrentImageRef = useRef(handleDeleteCurrentImage);
  handleDeleteCurrentImageRef.current = handleDeleteCurrentImage;

  const labelCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const sh of displayShapes) {
      m.set(sh.label, (m.get(sh.label) ?? 0) + 1);
    }
    return m;
  }, [displayShapes]);

  const goPrevRef = useRef(goPrev);
  const goNextRef = useRef(goNext);
  const handleOpenFolderRef = useRef(handleOpenFolder);
  const handleLoadFileAndSaveRef = useRef(handleLoadFileAndSave);
  const applyUndoRef = useRef(applyUndo);
  const applyRedoRef = useRef(applyRedo);
  const copyShapesToClipboardRef = useRef(copyShapesToClipboard);
  const pasteShapesFromClipboardRef = useRef(pasteShapesFromClipboard);
  const applyLabelToSelectedShapesRef = useRef(applyLabelToSelectedShapes);
  goPrevRef.current = goPrev;
  goNextRef.current = goNext;
  handleOpenFolderRef.current = handleOpenFolder;
  handleLoadFileAndSaveRef.current = handleLoadFileAndSave;
  applyLabelToSelectedShapesRef.current = applyLabelToSelectedShapes;
  applyUndoRef.current = applyUndo;
  applyRedoRef.current = applyRedo;
  copyShapesToClipboardRef.current = copyShapesToClipboard;
  pasteShapesFromClipboardRef.current = pasteShapesFromClipboard;

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

      const isCtrl = e.ctrlKey || e.metaKey;
      if (isCtrl) {
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          applyUndoRef.current();
          return;
        }
        if (key === 'y' || (key === 'z' && e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
          applyRedoRef.current();
          return;
        }
        if (key === 'c') {
          e.preventDefault();
          e.stopPropagation();
          copyShapesToClipboardRef.current();
          return;
        }
        if (key === 'v') {
          e.preventDefault();
          e.stopPropagation();
          pasteShapesFromClipboardRef.current();
          return;
        }
      }

      if (
        e.key === 'Delete' &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        window.electron &&
        displayItemRef.current
      ) {
        e.preventDefault();
        e.stopPropagation();
        void handleDeleteCurrentImageRef.current();
        return;
      }
      if (e.key === 'Escape' && shortcutsModalOpen) {
        e.preventDefault();
        e.stopPropagation();
        setShortcutsModalOpen(false);
        return;
      }
      if ((e.key === '?' || (e.key === '/' && e.shiftKey)) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setShortcutsModalOpen((o) => !o);
        return;
      }
      if (key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setActiveTool((t) => (t === 'draw' ? 'select' : 'draw'));
        return;
      }
      if (isCtrlS) {
        const item = displayItemRef.current;
        const size = naturalSizeRef.current;
        if (item && size) {
          writePolygonJson(item, displayShapesRef.current, size);
        }
        return;
      }
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

      if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setShapesVisible((v) => !v);
        return;
      }

      if (curClasses.length > 0 && (key === 'w' || key === 's')) {
        e.preventDefault();
        e.stopPropagation();
        const idx = curClasses.findIndex((c) => c.id === curSelected?.id);
        const picked =
          key === 'w'
            ? idx <= 0
              ? curClasses[curClasses.length - 1]
              : curClasses[idx - 1]
            : idx < 0 || idx >= curClasses.length - 1
              ? curClasses[0]
              : curClasses[idx + 1];
        setSelectedClass(picked);
        if (activeToolRef.current === 'select' && selectedShapeIdsRef.current.length > 0) {
          applyLabelToSelectedShapesRef.current(picked.name);
        }
        return;
      }
      if (key >= '1' && key <= '9') {
        const idx = parseInt(key, 10) - 1;
        const cur = classesRef.current;
        if (idx < cur.length) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedClass(cur[idx]);
          if (activeToolRef.current === 'select' && selectedShapeIdsRef.current.length > 0) {
            applyLabelToSelectedShapesRef.current(cur[idx].name);
          }
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [writePolygonJson, shortcutsModalOpen]);

  const onNaturalSize = useCallback((w: number, h: number) => {
    setNaturalSize({ w, h });
  }, []);

  if (!isElectron) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 bg-slate-950 text-slate-400 p-8">
        <p className="text-sm font-medium text-slate-300">Electron으로 실행해 주세요</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <header className="glass flex-shrink-0 border-b border-white/10 px-5 py-3 flex items-center gap-4 rounded-none overflow-visible">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleOpenFolder}
            className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_20px_rgba(82,182,255,0.15)]"
            style={{ color: 'var(--accent-blue)' }}
          >
            폴더 (Ctrl+O)
          </button>
          <div className="relative" ref={labelMenuRef}>
            <button
              ref={labelTriggerRef}
              type="button"
              onClick={() => setLabelMenuOpen((o) => !o)}
              className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-blue)] inline-flex items-center gap-1.5"
              style={{ color: 'var(--accent-blue)' }}
              aria-expanded={labelMenuOpen}
              aria-haspopup="true"
              title="라벨 세트 선택"
            >
              {savedClassSets.find((s) => s.id === activeClassSetId)?.displayName ?? '라벨 세트'}
              <svg className={`w-4 h-4 transition-transform ${labelMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
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
                        className={`flex items-center gap-1 px-2 py-1.5 rounded-lg group ${activeClassSetId === set.id ? 'bg-cyan-500/20' : 'hover:bg-white/10'}`}
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
                              if (e.key === 'Escape') {
                                setRenameId(null);
                                setRenameValue('');
                              }
                            }}
                            className="flex-1 min-w-0 px-2 py-0.5 text-sm bg-slate-800 border border-white/20 rounded text-white"
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <button type="button" onClick={() => applySavedSet(set.id)} className="flex-1 min-w-0 text-left text-sm text-slate-200 truncate py-0.5">
                              {set.displayName}
                              <span className="ml-1 text-slate-500 text-xs">({set.classNames.length})</span>
                            </button>
                            <button
                              type="button"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setRenameId(set.id);
                                setRenameValue(set.displayName);
                              }}
                              className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="이름 변경"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                removeSavedSet(set.id);
                              }}
                              className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="삭제"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
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
                      파일에서 불러와 저장 (Ctrl+L)
                    </button>
                  </div>
                </div>,
                document.body
              )}
          </div>
          <div className="flex rounded-lg p-0.5 glass border border-white/10">
            <button
              type="button"
              onClick={() => setActiveTool('draw')}
              title="단축키 F"
              className={`px-2.5 py-1.5 rounded-md text-xs font-semibold ${activeTool === 'draw' ? 'bg-cyan-500/30 text-cyan-200' : 'text-slate-400 hover:text-white'}`}
            >
              그리기 (F)
            </button>
            <button
              type="button"
              onClick={() => setActiveTool('select')}
              title="단축키 F"
              className={`px-2.5 py-1.5 rounded-md text-xs font-semibold ${activeTool === 'select' ? 'bg-cyan-500/30 text-cyan-200' : 'text-slate-400 hover:text-white'}`}
            >
              선택 (F)
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              const item = displayItem;
              const size = naturalSizeRef.current;
              if (item && size) writePolygonJson(item, displayShapes, size);
            }}
            className="px-3.5 py-2 rounded-xl text-sm font-medium transition-all border border-cyan-400/50 shadow-[0_0_20px_rgba(34,211,238,0.15)] hover:shadow-[0_0_24px_rgba(34,211,238,0.25)] bg-cyan-500/20 text-cyan-100"
          >
            저장 (Ctrl+S)
          </button>
          {displayItem && window.electron && (
            <>
              <button
                type="button"
                onClick={() => window.electron!.showItemInFolder(displayItem.imagePath)}
                className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-blue)]"
                style={{ color: 'var(--accent-blue)' }}
                title="현재 이미지 폴더"
              >
                폴더 열기
              </button>
              <button
                type="button"
                onClick={handleDeleteCurrentImage}
                className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:bg-red-500/20 hover:border-red-400/50 hover:text-red-400"
                title="이미지 + JSON 삭제 (Del)"
              >
                이미지 삭제
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setShortcutsModalOpen(true)}
            className="px-3.5 py-2 rounded-xl glass border border-cyan-500/30 text-sm font-medium transition-all hover:border-cyan-400/60 hover:bg-cyan-500/10 text-cyan-200/90 shrink-0"
            title="Polygon 단축키 (?)"
          >
            단축키 (?)
          </button>
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-3 ml-2">
          {displayItem ? (
            <span className="text-base font-bold font-mono truncate max-w-md min-w-0 text-cyan-300" title={displayItem.name}>
              {displayItem.name}
            </span>
          ) : (
            <span className="text-slate-400 text-sm truncate min-w-0" title={statusMessage}>
              {statusMessage || (workFolderPath ? '\u00A0' : '폴더를 열어 Polygon 라벨을 작업하세요 (LabelMe 형식 JSON)')}
            </span>
          )}
        </div>
      </header>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <aside className="glass w-72 flex-shrink-0 border-r border-white/10 overflow-auto flex flex-col">
          <div className="p-3 pb-2">
            <div className="text-[11px] font-bold uppercase tracking-widest mb-3 text-slate-400">라벨 (1–9, W/S)</div>
            {classes.length === 0 ? (
              <div className="glass-card p-4 text-center">
                <p className="text-slate-400 text-sm">클래스 txt를 불러와</p>
                <p className="text-slate-400 text-sm mt-0.5">라벨 목록을 만드세요.</p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {classes.map((c, idx) => {
                  const displayColor = customLabelColors[c.id] ?? c.color;
                  const isSelected = selectedClass?.id === c.id;
                  const cnt = labelCounts.get(c.name) ?? 0;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => selectClass(c)}
                        className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm text-left transition-all border ${
                          isSelected
                            ? 'bg-cyan-500/25 border-cyan-400/60 border-2 shadow-[0_0_16px_rgba(34,211,238,0.25)]'
                            : 'border-transparent bg-transparent hover:bg-white/5 hover:border-white/10 text-slate-300'
                        }`}
                      >
                        <div className="relative shrink-0 w-4 h-4 flex items-center justify-center">
                          <input
                            type="color"
                            id={`poly-class-color-${c.id}`}
                            value={displayColor}
                            onChange={(e) => setCustomLabelColors((prev) => ({ ...prev, [c.id]: e.target.value }))}
                            className="absolute inset-0 w-4 h-4 opacity-0 cursor-pointer"
                            tabIndex={-1}
                            aria-label={`${c.name} 색상`}
                            title="색상"
                            onClick={(ev) => ev.stopPropagation()}
                          />
                          <span
                            className="block w-4 h-4 rounded-full border-2 border-white/30 pointer-events-none"
                            style={{ backgroundColor: displayColor }}
                          />
                        </div>
                        <span className={`truncate font-semibold min-w-0 flex-1 ${isSelected ? 'text-white' : 'text-slate-200'}`}>{c.name}</span>
                        <span className="shrink-0 text-[11px] font-mono text-slate-500">{idx + 1}</span>
                        <span
                          className={`shrink-0 tabular-nums text-xs font-bold rounded-full px-2 py-0.5 border min-w-[1.35rem] text-right ${
                            cnt > 0 ? 'border-cyan-400/40 bg-cyan-500/20 text-cyan-100' : 'text-slate-500 border-transparent'
                          }`}
                        >
                          {cnt}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="p-3 pt-2 border-t border-white/10 flex-1 min-h-0 flex flex-col">
            <div className={`text-[11px] font-bold uppercase tracking-widest mb-2 text-slate-400 flex items-center justify-between gap-2 ${!shapesVisible ? 'opacity-50' : ''}`}>
              <span>폴리곤 ({displayShapes.length})</span>
              {activeTool === 'select' && selectedShapeIds.length > 0 && (
                <span className="text-[10px] font-normal normal-case text-cyan-400/90">라벨 변경: 1–9 · Shift+클릭 다중 선택</span>
              )}
            </div>
            {displayShapes.length === 0 ? (
              <p className="text-xs text-slate-500 px-1">이 이미지에 폴리곤이 없습니다.</p>
            ) : (
              <ul className={`space-y-1 overflow-auto min-h-0 flex-1 pr-0.5 ${!shapesVisible ? 'opacity-40' : ''}`}>
                {displayShapes.map((sh, idx) => {
                  const stroke = colorForLabel(sh.label);
                  const isSelected = selectedShapeIds.includes(sh.id);
                  return (
                    <li key={sh.id}>
                      <button
                        type="button"
                        onClick={(e) => {
                          setSelectedShapeIds((prev) =>
                            e.shiftKey ? applyShapeClickSelection(prev, sh.id, true) : [sh.id]
                          );
                          setActiveTool('select');
                        }}
                        className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-left text-sm transition-all border ${
                          isSelected
                            ? 'bg-cyan-500/20 border-cyan-400/50 text-white'
                            : 'border-transparent hover:bg-white/5 hover:border-white/10 text-slate-300'
                        }`}
                      >
                        <span className="shrink-0 w-3 h-3 rounded-full border border-white/30" style={{ backgroundColor: stroke }} />
                        <span className="truncate flex-1 min-w-0 font-medium">{sh.label}</span>
                        <span className="shrink-0 text-[10px] text-slate-500 font-mono">#{idx + 1}</span>
                        <span className="shrink-0 text-[10px] text-slate-500">{sh.points.length}pt</span>
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
              <div className="flex items-center gap-2">
                <input
                  ref={gotoInputRef}
                  type="number"
                  min={1}
                  max={Math.max(1, navCount)}
                  value={gotoValue}
                  disabled={navCount === 0}
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
                  className="w-16 px-2 py-1.5 text-sm font-mono tabular-nums rounded-lg bg-slate-800 border border-white/10 text-white focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 outline-none disabled:opacity-40"
                />
                <span className="text-slate-500 text-sm">/ {navCount}</span>
              </div>
            </div>
          )}
        </aside>

        <main className="flex-1 flex flex-col min-w-0" style={{ backgroundColor: 'var(--bg-deep)' }}>
          {imageList.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
              <div className="glass-card w-20 h-20 rounded-2xl flex items-center justify-center">
                <svg className="w-10 h-10 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h4l2 2h8a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V5z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-slate-300">작업 폴더를 열어 이미지를 불러오세요</p>
              <p className="text-xs text-slate-500">이미지와 같은 이름의 .json에 LabelMe 형식으로 저장됩니다</p>
            </div>
          ) : !currentItem ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
              <p className="text-sm font-medium text-slate-300">이미지를 불러올 수 없습니다</p>
            </div>
          ) : (
            <>
              <div className="flex-1 relative overflow-hidden bg-black min-h-0">
                <PolygonCanvas
                  imageUrl={currentItem.imageUrl}
                  shapes={displayShapes}
                  onShapesChange={handleShapesChange}
                  pushHistoryRef={pushHistoryRef}
                  activeTool={activeTool}
                  activeLabel={activeLabel}
                  colorForLabel={colorForLabel}
                  selectedShapeIds={selectedShapeIds}
                  onSelectedShapeIdsChange={setSelectedShapeIds}
                  onNaturalSize={onNaturalSize}
                  readOnly={false}
                  shapesVisible={shapesVisible}
                  suppressEscapeClear={shortcutsModalOpen}
                />
              </div>
              <footer className="glass flex-shrink-0 border-t border-white/10 px-4 py-2.5 flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={goPrev}
                    disabled={navCount <= 0 || currentIndex <= 0}
                    className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 text-sm font-medium hover:border-cyan-400/50"
                    style={{ color: 'var(--accent-blue)' }}
                  >
                    이전 (A)
                  </button>
                  <button
                    type="button"
                    onClick={goNext}
                    disabled={navCount <= 0 || currentIndex >= navCount - 1}
                    className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 text-sm font-medium hover:border-cyan-400/50"
                    style={{ color: 'var(--accent-blue)' }}
                  >
                    다음 (D)
                  </button>
                </div>
                {navCount > 0 && (
                  <>
                    <span className="shrink-0 text-lg font-bold tabular-nums whitespace-nowrap text-cyan-300">
                      {currentIndex + 1} / {navCount}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, navCount - 1)}
                      value={Math.min(sliderIndex, Math.max(0, navCount - 1))}
                      onChange={(e) => {
                        const next = parseInt(e.target.value, 10);
                        if (!Number.isFinite(next)) return;
                        goToIndex(next);
                      }}
                      className="progress-slider flex-1 min-w-0 h-2 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white/30 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0"
                      style={{ background: 'rgba(255,255,255,0.1)' }}
                    />
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setShortcutsModalOpen(true)}
                  className="ml-auto text-xs text-slate-500 hover:text-cyan-300/90 transition-colors shrink-0"
                >
                  Polygon 단축키 안내 (?)
                </button>
              </footer>
            </>
          )}
        </main>
      </div>

      {shortcutsModalOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setShortcutsModalOpen(false)}
          role="presentation"
        >
          <div
            className="glass-card max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col border border-cyan-500/20 shadow-2xl shadow-cyan-950/40"
            onClick={(ev) => ev.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="polygon-shortcuts-title"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <h2 id="polygon-shortcuts-title" className="text-lg font-bold text-white">
                Polygon 단축키 안내
              </h2>
              <button
                type="button"
                onClick={() => setShortcutsModalOpen(false)}
                className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                aria-label="닫기"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-5 overflow-auto flex-1 min-h-0 space-y-5 text-sm">
              <p className="text-xs text-amber-200/90 leading-relaxed bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-2">
                <strong className="text-amber-100">Detector</strong> 탭의 캔버스 단축키(박스 도구, F 패스트 모드, Del 등)와{' '}
                <strong className="text-amber-100">다릅니다</strong>. 아래는 <strong className="text-cyan-200">Polygon 탭</strong> 기준입니다.
              </p>

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2.5">편집</h3>
                <ul className="space-y-2">
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">되돌리기 / 다시 실행</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">Ctrl+Z / Ctrl+Y</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">복사 / 붙여넣기</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">Ctrl+C / Ctrl+V</kbd>
                  </li>
                </ul>
                <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                  복사: 선택 폴리곤이 있으면 해당 폴리곤만, 없으면 전체. 다른 이미지로 이동한 뒤에도 Ctrl+V로 붙여넣을 수 있습니다. 되돌리기(Ctrl+Z)는 <strong className="text-slate-400 font-normal">이미지마다</strong> 따로 쌓입니다.
                </p>
              </div>

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2.5">뷰 · 캔버스</h3>
                <ul className="space-y-2">
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">확대 / 축소</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">마우스 휠</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">이미지 이동</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100 text-[10px]">스페이스+드래그 · H · 가운데 버튼 · Shift+빈곳</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">도구 패널 표시/숨김</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">]</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">모든 폴리곤 표시/숨김</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">`</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">손 도구 ↔ 편집</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">H</kbd>
                  </li>
                </ul>
                <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                  왼쪽 플로팅 패널: 라벨 표시 on/off, 확대·위치 초기화, 선 굵기·꼭짓점 크기·채우기 투명도. 이미지를 A/D로 넘겨도 <strong className="text-slate-400 font-normal">확대·위치는 유지</strong>됩니다 (Detector와 동일).
                </p>
              </div>

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2.5">파일 · 이미지 이동</h3>
                <ul className="space-y-2">
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">폴더 열기</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">Ctrl+O</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">클래스 txt 불러오기</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">Ctrl+L</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">저장</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">Ctrl+S</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">Goto 번호 입력 포커스</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">Ctrl+G</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">이전 / 다음 이미지</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">A · ← / D · →</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">현재 이미지·JSON 삭제</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">Del</kbd>
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2.5">라벨 선택</h3>
                <ul className="space-y-2">
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">라벨 1~9번</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">1 – 9</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">활성 라벨 이전 / 다음</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">W / S</kbd>
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2.5">도구</h3>
                <ul className="space-y-2">
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">그리기 ↔ 선택</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">F</kbd>
                  </li>
                  <li className="flex justify-between gap-3 items-baseline">
                    <span className="text-slate-400">이 안내 열기/닫기</span>
                    <kbd className="shrink-0 font-mono text-xs px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-cyan-100">?</kbd>
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2.5">그리기 모드 (F)</h3>
                <ul className="space-y-2 text-slate-300">
                  <li>클릭으로 꼭짓점 추가 · 마우스 오버 시 <strong className="text-slate-200 font-medium">채우기</strong>·다음 점·첫 점까지 점선 미리보기</li>
                  <li>첫 점 근처 클릭 또는 <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-800 border border-white/10 text-cyan-100">Enter</kbd>로 완성 — Enter는 <strong className="text-slate-200 font-medium">커서 위치를 마지막 점</strong>으로 넣고 닫습니다</li>
                  <li>
                    <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-800 border border-white/10 text-cyan-100">Esc</kbd> 초안 전체 취소 · <strong className="text-slate-200 font-medium">우클릭</strong> 마지막 점 하나씩 취소
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2.5">선택 모드 (F)</h3>
                <ul className="space-y-2 text-slate-300">
                  <li>폴리곤 클릭 또는 왼쪽 <strong className="text-slate-200 font-medium">폴리곤 목록</strong>에서 선택 · <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-800 border border-white/10 text-cyan-100">Shift</kbd>+클릭으로 다중 선택/해제</li>
                  <li>선택 시 캔버스 중앙에 클래스 라벨 배지 (플로팅 패널 라벨 아이콘으로 전체 표시 on/off)</li>
                  <li>라벨 변경: 왼쪽 라벨 목록 클릭 또는 <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-800 border border-white/10 text-cyan-100">1–9</kbd> · <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-800 border border-white/10 text-cyan-100">W/S</kbd></li>
                  <li>꼭짓점 드래그: 점 이동 · 면(내부) 드래그: 폴리곤 전체 이동</li>
                  <li>
                    <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-800 border border-white/10 text-cyan-100">E</kbd> 변 위에 꼭짓점 추가 (가장 가까운 변에 커서를 올린 뒤 — 연두색 미리보기 점)
                  </li>
                  <li>
                    <kbd className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-800 border border-white/10 text-cyan-100">R</kbd> 선택된 폴리곤 삭제 (다중 선택 시 모두 삭제)
                  </li>
                  <li>우클릭: 해당 꼭짓점 삭제 (점이 3개 미만이 되면 폴리곤 제거)</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PolygonWorkspace;
