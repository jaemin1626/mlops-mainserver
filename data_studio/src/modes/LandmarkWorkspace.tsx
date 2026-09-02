/// <reference types="vite/client" />
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { YoloClass } from '../types';
import { COLOR_PALETTE } from '../constants';
import type { LandmarkObjectPixel } from '../landmarkTypes';
import { DEFAULT_LANDMARK_TYPES, DEFAULT_LANDMARK_LABEL } from '../landmarkTypes';
import {
  buildLandmarkFile,
  deriveXmlPath,
  extractEditableObjects,
  imageBasename,
  parseLandmarkXml,
  serializeLandmarkXml,
} from '../landmarkFormat';
import LandmarkCanvas from '../components/LandmarkCanvas';

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

type ObjectsChangeOptions = { recordHistory?: boolean };

const SAVED_SETS_STORAGE_KEY = 'intellivixLandmark.savedClassSetsV1';

function classNamesToYoloClasses(classNames: string[]): YoloClass[] {
  return classNames.map((name, index) => ({
    id: index,
    name,
    color: COLOR_PALETTE[index % COLOR_PALETTE.length],
  }));
}

function cloneObjects(list: LandmarkObjectPixel[]): LandmarkObjectPixel[] {
  return list.map((obj) => ({
    ...obj,
    bndbox: { ...obj.bndbox },
    points: obj.points.map((p) => ({ ...p })),
  }));
}

async function loadObjectsFromXml(xmlPath: string): Promise<LandmarkObjectPixel[]> {
  if (!window.electron) return [];
  try {
    const text = await window.electron.readTxt(xmlPath);
    if (!text.trim()) return [];
    const parsed = parseLandmarkXml(text);
    if (!parsed.ok) return [];
    return extractEditableObjects(parsed.data);
  } catch {
    return [];
  }
}

const LandmarkWorkspace: React.FC = () => {
  const [workFolderPath, setWorkFolderPath] = useState<string | null>(null);
  const [imageList, setImageList] = useState<OfflineImageItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [classes, setClasses] = useState<YoloClass[]>([]);
  const [selectedClass, setSelectedClass] = useState<YoloClass | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [savedClassSets, setSavedClassSets] = useState<SavedClassSet[]>([]);
  const [activeClassSetId, setActiveClassSetId] = useState<string | null>(null);
  const [storageRestored, setStorageRestored] = useState(false);
  const gotoInputRef = useRef<HTMLInputElement>(null);
  const [gotoValue, setGotoValue] = useState('');
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);

  const [displayItem, setDisplayItem] = useState<OfflineImageItem | null>(null);
  const [displayObjects, setDisplayObjects] = useState<LandmarkObjectPixel[]>([]);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  const displayItemRef = useRef<OfflineImageItem | null>(null);
  const displayObjectsRef = useRef<LandmarkObjectPixel[]>([]);
  const [customLabelColors, setCustomLabelColors] = useState<Record<number, string>>({});
  const lastWriteWarningRef = useRef<{ path: string; at: number } | null>(null);
  const undoStackRef = useRef<LandmarkObjectPixel[][]>([]);
  const redoStackRef = useRef<LandmarkObjectPixel[][]>([]);
  const pushHistoryRef = useRef<(() => void) | null>(null);

  const isElectron = typeof window !== 'undefined' && !!window.electron;
  const navCount = imageList.length;
  const currentItem = navCount > 0 && currentIndex >= 0 && currentIndex < navCount ? imageList[currentIndex]! : null;

  const selectedClassRef = useRef(selectedClass);
  const selectedObjectIdRef = useRef(selectedObjectId);
  useEffect(() => {
    selectedClassRef.current = selectedClass;
    selectedObjectIdRef.current = selectedObjectId;
  }, [selectedClass, selectedObjectId]);

  useEffect(() => {
    naturalSizeRef.current = naturalSize;
  }, [naturalSize]);

  useEffect(() => {
    displayItemRef.current = displayItem;
    displayObjectsRef.current = displayObjects;
  }, [displayItem, displayObjects]);

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
    setDisplayItem(null);
    setDisplayObjects([]);
    setNaturalSize(null);
    setSelectedObjectId(null);
    setSelectedPointIndex(null);
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, [imageList]);

  useEffect(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, [displayItem?.imagePath]);

  const loadObjectsForItem = useCallback(async (item: OfflineImageItem) => {
    return loadObjectsFromXml(deriveXmlPath(item.imagePath));
  }, []);

  useEffect(() => {
    if (!currentItem?.imagePath) return;
    setNaturalSize(null);
  }, [currentItem?.imagePath]);

  useEffect(() => {
    if (!currentItem || !window.electron) return;
    setDisplayItem(null);
    let cancelled = false;
    loadObjectsForItem(currentItem).then((loaded) => {
      if (cancelled) return;
      setDisplayItem(currentItem);
      setDisplayObjects(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [currentItem, loadObjectsForItem]);

  useEffect(() => {
    if (navCount > 0) setGotoValue(String(currentIndex + 1));
    else setGotoValue('');
  }, [currentIndex, navCount]);

  useEffect(() => {
    if (navCount === 0) return;
    if (currentIndex >= navCount) setCurrentIndex(navCount - 1);
  }, [navCount, currentIndex]);

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

  const activeLabel = selectedClass?.name ?? DEFAULT_LANDMARK_LABEL;

  const notifyXmlWriteFailure = useCallback((item: OfflineImageItem, xmlPath: string) => {
    setStatusMessage(`저장 실패: ${item.name}`);
    const now = Date.now();
    const last = lastWriteWarningRef.current;
    if (last && last.path === xmlPath && now - last.at < 5000) return;
    lastWriteWarningRef.current = { path: xmlPath, at: now };
    window.alert(`랜드마크 XML 저장 실패: ${item.name}\n${xmlPath}`);
  }, []);

  const writeLandmarkXml = useCallback(
    async (item: OfflineImageItem, objects: LandmarkObjectPixel[]) => {
      if (!window.electron) return false;
      const xmlPath = deriveXmlPath(item.imagePath);
      const file = buildLandmarkFile(imageBasename(item.imagePath), objects);
      const ok = await window.electron.writeTxt(xmlPath, serializeLandmarkXml(file));
      if (!ok) {
        notifyXmlWriteFailure(item, xmlPath);
        return false;
      }
      return true;
    },
    [notifyXmlWriteFailure]
  );

  const pushHistory = useCallback(() => {
    undoStackRef.current = [...undoStackRef.current, cloneObjects(displayObjectsRef.current)];
    redoStackRef.current = [];
  }, []);

  pushHistoryRef.current = pushHistory;

  const handleObjectsChange = useCallback(
    (next: LandmarkObjectPixel[], options?: ObjectsChangeOptions) => {
      if (options?.recordHistory !== false) {
        pushHistory();
      }
      setDisplayObjects(next);
      if (selectedObjectId && !next.some((o) => o.id === selectedObjectId)) {
        setSelectedObjectId(null);
        setSelectedPointIndex(null);
      }
      const item = displayItem;
      if (!window.electron || !item) return;
      void writeLandmarkXml(item, next);
    },
    [displayItem, writeLandmarkXml, selectedObjectId, pushHistory]
  );

  const applyUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1]!;
    undoStackRef.current = stack.slice(0, -1);
    redoStackRef.current = [...redoStackRef.current, cloneObjects(displayObjectsRef.current)];
    handleObjectsChange(prev, { recordHistory: false });
  }, [handleObjectsChange]);

  const applyRedo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const next = stack[stack.length - 1]!;
    redoStackRef.current = stack.slice(0, -1);
    undoStackRef.current = [...undoStackRef.current, cloneObjects(displayObjectsRef.current)];
    handleObjectsChange(next, { recordHistory: false });
  }, [handleObjectsChange]);

  const deleteSelectedObject = useCallback(() => {
    const sid = selectedObjectIdRef.current;
    if (!sid) return false;
    const next = displayObjectsRef.current.filter((o) => o.id !== sid);
    handleObjectsChange(next);
    setSelectedObjectId(null);
    setSelectedPointIndex(null);
    return true;
  }, [handleObjectsChange]);

  const applyLabelToSelectedObject = useCallback(
    (label: string) => {
      if (!selectedObjectId) return;
      const next = displayObjects.map((o) => (o.id === selectedObjectId ? { ...o, name: label } : o));
      handleObjectsChange(next);
    },
    [selectedObjectId, displayObjects, handleObjectsChange]
  );

  const applyTypeToSelectedObject = useCallback(
    (type: string) => {
      if (!selectedObjectId) return;
      const next = displayObjects.map((o) => (o.id === selectedObjectId ? { ...o, type: type.trim() || 'Normal' } : o));
      handleObjectsChange(next);
    },
    [selectedObjectId, displayObjects, handleObjectsChange]
  );

  const selectClass = useCallback(
    (cls: YoloClass) => {
      setSelectedClass(cls);
      if (selectedObjectId) {
        applyLabelToSelectedObject(cls.name);
      }
    },
    [selectedObjectId, applyLabelToSelectedObject]
  );

  const saveCurrent = useCallback(async () => {
    const item = displayItem;
    if (!window.electron || !item) return true;
    return writeLandmarkXml(item, displayObjects);
  }, [displayItem, displayObjects, writeLandmarkXml]);

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
      setStatusMessage(`폴더 열림: ${path} — ${list.length}개 이미지`);
    } catch (e) {
      setStatusMessage('폴더 열기 실패: ' + (e as Error).message);
    }
  };

  const handleLoadFileAndSave = async () => {
    if (!window.electron) return;
    try {
      const path = await window.electron.openLabelFileDialog();
      if (!path) return;
      const content = await window.electron.readLabelFile(path);
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      const displayName = path.replace(/^.*[/\\]/, '').replace(/\.txt$/i, '') || 'classes';
      const newSet: SavedClassSet = { id: crypto.randomUUID(), displayName, classNames: lines };
      setSavedClassSets((prev) => [...prev, newSet]);
      setActiveClassSetId(newSet.id);
      const yolo = classNamesToYoloClasses(newSet.classNames);
      setClasses(yolo);
      setSelectedClass(yolo[0] ?? null);
      setStatusMessage(`저장됨: ${newSet.displayName}`);
    } catch (e) {
      setStatusMessage('라벨 파일 열기 실패: ' + (e as Error).message);
    }
  };

  const applySavedSet = useCallback((id: string) => {
    const set = savedClassSets.find((s) => s.id === id);
    if (!set) return;
    setActiveClassSetId(id);
    const yolo = classNamesToYoloClasses(set.classNames);
    setClasses(yolo);
    setSelectedClass(yolo[0] ?? null);
  }, [savedClassSets]);

  const renameSavedSet = useCallback((id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setSavedClassSets((prev) => prev.map((s) => (s.id === id ? { ...s, displayName: trimmed } : s)));
  }, []);

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
  }, [activeClassSetId]);

  const goToIndex = useCallback(
    async (nextIndex: number) => {
      if (navCount <= 0) return;
      if (nextIndex < 0 || nextIndex >= navCount || nextIndex === currentIndex) return;
      const ok = await saveCurrent();
      if (!ok) return;
      setCurrentIndex(nextIndex);
    },
    [currentIndex, navCount, saveCurrent]
  );

  const goPrev = useCallback(() => void goToIndex(currentIndex - 1), [currentIndex, goToIndex]);
  const goNext = useCallback(() => void goToIndex(currentIndex + 1), [currentIndex, goToIndex]);

  const handleDeleteCurrentImage = useCallback(async () => {
    if (!window.electron || !displayItem) return;
    const xmlPath = deriveXmlPath(displayItem.imagePath);
    if (!window.confirm(`이미지와 XML을 삭제할까요?\n\n${displayItem.name}`)) return;
    const result = await window.electron.deleteImagePolygonJson(displayItem.imagePath, xmlPath);
    if (!result.ok) {
      setStatusMessage('삭제 실패: ' + (result.error || ''));
      return;
    }
    const nextList = imageList.filter((item) => item.imagePath !== displayItem.imagePath);
    setImageList(nextList);
    if (nextList.length === 0) {
      setDisplayItem(null);
      setDisplayObjects([]);
      setCurrentIndex(0);
      return;
    }
    setCurrentIndex(currentIndex >= nextList.length ? nextList.length - 1 : currentIndex);
  }, [displayItem, imageList, currentIndex]);

  const selectedObject = useMemo(
    () => displayObjects.find((o) => o.id === selectedObjectId) ?? null,
    [displayObjects, selectedObjectId]
  );

  const handleOpenFolderRef = useRef(handleOpenFolder);
  const handleLoadFileAndSaveRef = useRef(handleLoadFileAndSave);
  const goPrevRef = useRef(goPrev);
  const goNextRef = useRef(goNext);
  const applyUndoRef = useRef(applyUndo);
  const applyRedoRef = useRef(applyRedo);
  const deleteSelectedObjectRef = useRef(deleteSelectedObject);
  const handleDeleteCurrentImageRef = useRef(handleDeleteCurrentImage);
  const applyLabelToSelectedObjectRef = useRef(applyLabelToSelectedObject);
  handleOpenFolderRef.current = handleOpenFolder;
  handleLoadFileAndSaveRef.current = handleLoadFileAndSave;
  goPrevRef.current = goPrev;
  goNextRef.current = goNext;
  applyUndoRef.current = applyUndo;
  applyRedoRef.current = applyRedo;
  deleteSelectedObjectRef.current = deleteSelectedObject;
  handleDeleteCurrentImageRef.current = handleDeleteCurrentImage;
  applyLabelToSelectedObjectRef.current = applyLabelToSelectedObject;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (e.ctrlKey && key === 's') e.preventDefault();
      if (e.ctrlKey && key === 'o') {
        e.preventDefault();
        handleOpenFolderRef.current();
        return;
      }
      if (e.ctrlKey && key === 'l') {
        e.preventDefault();
        handleLoadFileAndSaveRef.current();
        return;
      }
      if (e.ctrlKey && key === 'g') {
        e.preventDefault();
        gotoInputRef.current?.focus();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        applyUndoRef.current();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        applyRedoRef.current();
        return;
      }
      if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey) {
        if (deleteSelectedObjectRef.current()) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === 'Delete' && e.ctrlKey) {
        e.preventDefault();
        void handleDeleteCurrentImageRef.current();
        return;
      }
      if (key === 'a' && !e.ctrlKey) {
        e.preventDefault();
        goPrevRef.current();
        return;
      }
      if (key === 'd' && !e.ctrlKey) {
        e.preventDefault();
        goNextRef.current();
        return;
      }
      if (e.key >= '1' && e.key <= '9' && !e.ctrlKey && classesRef.current.length > 0) {
        const idx = Number(e.key) - 1;
        const cls = classesRef.current[idx];
        if (cls) {
          selectClass(cls);
          if (selectedObjectIdRef.current) applyLabelToSelectedObjectRef.current(cls.name);
        }
      }
      if (e.ctrlKey && key === 's') {
        const item = displayItemRef.current;
        if (item) void writeLandmarkXml(item, displayObjectsRef.current);
      }
      if ((e.key === '?' || (e.key === '/' && e.shiftKey)) && !shortcutsModalOpen) {
        e.preventDefault();
        setShortcutsModalOpen(true);
      }
      if (e.key === 'Escape' && shortcutsModalOpen) setShortcutsModalOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [shortcutsModalOpen, selectClass, writeLandmarkXml]);

  const classesRef = useRef(classes);
  classesRef.current = classes;

  const onNaturalSize = useCallback((w: number, h: number) => {
    setNaturalSize({ w, h });
  }, []);

  if (!isElectron) {
    return <div className="h-full flex items-center justify-center text-slate-400">Electron으로 실행해 주세요</div>;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <header className="glass flex-shrink-0 border-b border-white/10 px-5 py-3 flex items-center gap-3 flex-wrap">
        <button type="button" onClick={() => void handleOpenFolder()} className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium text-sky-300 hover:border-sky-400/50">
          폴더 (Ctrl+O)
        </button>
        <button type="button" onClick={() => void saveCurrent()} className="px-3.5 py-2 rounded-xl text-sm font-medium border border-rose-400/50 bg-rose-500/20 text-rose-100">
          저장 (Ctrl+S)
        </button>
        {displayItem && (
          <button type="button" onClick={() => window.electron!.showItemInFolder(displayItem.imagePath)} className="px-3 py-2 rounded-xl glass border border-white/10 text-sm text-slate-300">
            폴더 열기
          </button>
        )}
        <span className="text-sm text-rose-200/90 font-mono truncate flex-1 min-w-0">{displayItem?.name ?? statusMessage}</span>
        <button type="button" onClick={() => setShortcutsModalOpen(true)} className="px-3 py-2 rounded-xl text-xs text-slate-400 border border-white/10">
          단축키 (?)
        </button>
      </header>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <aside className="glass w-72 flex-shrink-0 border-r border-white/10 overflow-auto flex flex-col">
          <div className="p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400">클래스 (1–9)</div>
              <button type="button" onClick={() => void handleLoadFileAndSave()} className="text-[10px] text-rose-300 hover:text-rose-200">
                불러오기
              </button>
            </div>
            {classes.length === 0 ? (
              <p className="text-xs text-slate-500">Ctrl+L로 classes.txt 불러오기</p>
            ) : (
              <ul className="space-y-1">
                {classes.map((c, idx) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => selectClass(c)}
                      className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-left ${selectedClass?.id === c.id ? 'bg-rose-500/25 border border-rose-400/50 text-white' : 'hover:bg-white/5 text-slate-300'}`}
                    >
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: customLabelColors[c.id] ?? c.color }} />
                      <span className="truncate flex-1">{c.name}</span>
                      <span className="text-[10px] text-slate-500">{idx + 1}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {selectedObject && (
            <div className="p-3 border-t border-white/10 space-y-3">
              <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400">선택 객체</div>
              <div className="text-xs text-slate-500">index {selectedObject.index}</div>
              <label className="block text-[10px] text-slate-500 uppercase">type</label>
              <input
                list="landmark-type-presets"
                value={selectedObject.type}
                onChange={(e) => applyTypeToSelectedObject(e.target.value)}
                className="w-full px-2 py-1.5 text-sm rounded-lg bg-slate-800 border border-white/10 text-white outline-none focus:border-rose-400/50"
              />
              <datalist id="landmark-type-presets">
                {DEFAULT_LANDMARK_TYPES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <div className="text-[10px] text-slate-500">포인트: 1–4 · 라벨 드래그 · 모서리로 박스 리사이즈</div>
              {selectedPointIndex !== null && (
                <div className="text-xs text-rose-300 font-mono">포인트 {selectedPointIndex + 1} 선택됨</div>
              )}
            </div>
          )}

          <div className="p-3 border-t border-white/10 flex-1 min-h-0 flex flex-col">
            <div className="text-[11px] font-bold uppercase tracking-widest mb-2 text-slate-400">객체 ({displayObjects.length})</div>
            <ul className="space-y-1 overflow-auto min-h-0 flex-1">
              {displayObjects.map((obj) => (
                <li key={obj.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedObjectId(obj.id);
                      setSelectedPointIndex(null);
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-left ${selectedObjectId === obj.id ? 'bg-rose-500/20 border border-rose-400/40 text-white' : 'hover:bg-white/5 text-slate-300'}`}
                  >
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: colorForLabel(obj.name) }} />
                    <span className="truncate flex-1">{obj.name}</span>
                    <span className="text-[10px] text-slate-500 font-mono">#{obj.index}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <main className="flex-1 flex flex-col min-w-0">
          {imageList.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400">
              <p className="text-sm">작업 폴더를 열어 랜드마크 XML 작업을 시작하세요</p>
              <p className="text-xs text-slate-600">이미지와 같은 이름의 .xml로 저장됩니다</p>
            </div>
          ) : !displayItem ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">XML 로딩 중…</div>
          ) : (
            <>
              <div className="flex-1 relative min-h-0">
                <LandmarkCanvas
                  imageUrl={displayItem.imageUrl}
                  objects={displayObjects}
                  onObjectsChange={handleObjectsChange}
                  pushHistoryRef={pushHistoryRef}
                  activeLabel={activeLabel}
                  colorForLabel={colorForLabel}
                  selectedObjectId={selectedObjectId}
                  onSelectedObjectIdChange={setSelectedObjectId}
                  selectedPointIndex={selectedPointIndex}
                  onSelectedPointIndexChange={setSelectedPointIndex}
                  onNaturalSize={onNaturalSize}
                  suppressEscapeClear={shortcutsModalOpen}
                />
              </div>
              <footer className="glass border-t border-white/10 px-4 py-2 flex items-center gap-3 flex-wrap">
                <button type="button" onClick={goPrev} disabled={currentIndex <= 0} className="px-4 py-2 rounded-xl glass border border-white/10 text-sm text-sky-300 disabled:opacity-40">
                  이전 (A)
                </button>
                <button type="button" onClick={goNext} disabled={currentIndex >= navCount - 1} className="px-4 py-2 rounded-xl glass border border-white/10 text-sm text-sky-300 disabled:opacity-40">
                  다음 (D)
                </button>
                <span className="text-cyan-300 font-bold tabular-nums">{currentIndex + 1} / {navCount}</span>
                <input
                  ref={gotoInputRef}
                  type="number"
                  min={1}
                  max={Math.max(1, navCount)}
                  value={gotoValue}
                  onChange={(e) => setGotoValue(e.target.value.replace(/[^0-9]/g, ''))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void goToIndex(Math.min(navCount, Math.max(1, parseInt(gotoValue, 10) || 1)) - 1);
                  }}
                  className="w-16 px-2 py-1 text-sm font-mono rounded-lg bg-slate-800 border border-white/10 text-white"
                />
              </footer>
            </>
          )}
        </main>
      </div>

      {shortcutsModalOpen &&
        createPortal(
          <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/60 p-4" onClick={() => setShortcutsModalOpen(false)}>
            <div className="glass-card max-w-md w-full p-6 rounded-2xl border border-white/10" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-white mb-4">랜드마크 단축키</h3>
              <ul className="text-sm text-slate-300 space-y-1.5 font-mono">
                <li>드래그 — 박스 생성 (모서리에 포인트 1~4 자동)</li>
                <li>1–4 — 포인트 선택 (번호 라벨 드래그로 이동, 화살표 끝 모서리가 좌표)</li>
                <li>방향키 — 1px 미세 이동 · Shift+방향키 — 5px</li>
                <li>박스 모서리 드래그 — 크기 조절 (포인트는 유지)</li>
                <li>박스 우클릭 — 객체 삭제</li>
                <li>1–9 — 클래스 선택 / 객체 라벨 변경</li>
                <li>Delete — 선택 객체 삭제</li>
                <li>Ctrl+Delete — 이미지+XML 삭제</li>
                <li>M — 돋보기 토글</li>
                <li>` — 포인트 표시/숨김</li>
                <li>Space+드래그 — 화면 이동</li>
                <li>휠 — 확대/축소</li>
                <li>Ctrl+Z / Ctrl+Y — 실행 취소/다시</li>
                <li>A / D — 이전/다음 이미지</li>
              </ul>
              <button type="button" className="mt-4 px-4 py-2 rounded-lg bg-rose-500/30 text-rose-100 text-sm font-bold" onClick={() => setShortcutsModalOpen(false)}>
                닫기
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

export default LandmarkWorkspace;
