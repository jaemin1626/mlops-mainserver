/// <reference types="vite/client" />
import React, { useState, useEffect, useCallback, useRef } from 'react';
import OcrQuadCanvas from '../components/OcrQuadCanvas';
import type { OcrBoxPixel } from '../ocrTypes';
import {
  cloneOcrBoxes,
  newManualOcrBox,
  pointsFromDetectResult,
  quadBounds,
} from '../ocrTypes';
import { parseOcrSidecar, serializeOcrSidecar } from '../ocrSidecarFormat';
import { exportPpocrLabelTxtFromFolder } from '../ocrLabelExport';
import type { OcrModelPreset, OfflineImageItem } from '../electron.d';
import {
  clampOcrDetectOptions,
  loadOcrDetectOptions,
  saveOcrDetectOptions,
  type OcrDetectOptions,
} from '../ocrDetectOptions';

type CanvasTool = 'select' | 'drawRect';

const AUTO_RECOGNIZE_LS = 'intellivixOcr.autoReRecognizeV1';
const BOX_LABEL_DISPLAY_LS = 'intellivixOcr.boxLabelDisplayV1';
const MODEL_PRESET_LS = 'intellivixOcr.modelPresetV1';
const FOCUS_TEXT_ON_NEW_BOX_LS = 'intellivixOcr.focusTextOnNewBoxV1';

function loadFocusTextOnNewBox(): boolean {
  try {
    const raw = localStorage.getItem(FOCUS_TEXT_ON_NEW_BOX_LS);
    if (raw === '0') return false;
    if (raw === '1') return true;
    return true;
  } catch {
    return true;
  }
}

function sameFolderPath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const PRESET_LABELS: Record<OcrModelPreset, string> = {
  mobile: 'PP-OCRv5 mobile',
  server: 'PP-OCRv5 server',
  v6_tiny: 'PP-OCRv6 tiny',
};

function loadModelPreset(): OcrModelPreset {
  try {
    const v = localStorage.getItem(MODEL_PRESET_LS);
    if (v === 'server') return 'server';
    if (v === 'mobile') return 'mobile';
    if (v === 'v6_tiny') return 'v6_tiny';
    return 'v6_tiny';
  } catch {
    return 'v6_tiny';
  }
}

type BoxLabelDisplay = {
  show: boolean;
  fontPx: number;
  pointSize: number;
  lineThickness: number;
};

function clampOcrPointSize(n: number): number {
  return Math.min(16, Math.max(3, Math.round(n)));
}

function clampOcrLineThickness(n: number): number {
  return Math.min(10, Math.max(1, Math.round(n)));
}

function loadBoxLabelDisplay(): BoxLabelDisplay {
  try {
    const raw = localStorage.getItem(BOX_LABEL_DISPLAY_LS);
    if (!raw) return { show: true, fontPx: 30, pointSize: 7, lineThickness: 4 };
    const parsed = JSON.parse(raw) as Partial<BoxLabelDisplay> & { fontScale?: number };
    const legacyScale = typeof parsed.fontScale === 'number' ? parsed.fontScale : null;
    const fontPx =
      typeof parsed.fontPx === 'number'
        ? parsed.fontPx
        : legacyScale != null
          ? Math.round(30 * legacyScale)
          : 30;
    const pointSize =
      typeof parsed.pointSize === 'number' ? clampOcrPointSize(parsed.pointSize) : 7;
    const lineThickness =
      typeof parsed.lineThickness === 'number' ? clampOcrLineThickness(parsed.lineThickness) : 4;
    return {
      show: parsed.show !== false,
      fontPx: Math.min(96, Math.max(8, fontPx)),
      pointSize,
      lineThickness,
    };
  } catch {
    return { show: true, fontPx: 30, pointSize: 7, lineThickness: 4 };
  }
}

type OcrJobProgress = {
  mode: 'batch' | 'single' | 'recognize';
  current: number;
  total: number;
  fileName?: string;
  failures?: number;
  totalBoxes?: number;
  startedAt: number;
  phase?: 'detect' | 'save' | 'init';
};

const PROGRESS_UI_MS = 250;
/** PPOCRLabel AutoDialog — Python 쪽 연속 predict, IPC는 청크 단위 */
const OCR_BATCH_CHUNK = 50;

function formatMmSs(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function estimateRemainingMs(startedAt: number, current: number, total: number): number | null {
  if (current <= 0 || total <= 0 || current >= total) return null;
  const elapsed = Date.now() - startedAt;
  return Math.round((elapsed / current) * (total - current));
}

function ocrProgressTitle(progress: OcrJobProgress): string {
  if (progress.mode === 'batch') {
    if (progress.phase === 'save') return '처리 마무리 중…';
    return '폴더 자동 인식';
  }
  if (progress.mode === 'recognize') return '박스 재인식';
  return '자동 인식 (현재)';
}

const OcrProgressPanel: React.FC<{
  progress: OcrJobProgress;
  onCancel?: () => void;
  cancellable?: boolean;
}> = ({ progress, onCancel, cancellable }) => {
  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;
  const elapsed = Date.now() - progress.startedAt;
  const remaining = estimateRemainingMs(progress.startedAt, progress.current, progress.total);
  const title = ocrProgressTitle(progress);

  return (
    <div className="absolute inset-0 z-20 bg-black/55 flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-slate-900/95 shadow-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white">{title}</h3>
            {progress.fileName && (
              <p className="text-[11px] text-slate-400 truncate mt-0.5" title={progress.fileName}>
                {progress.fileName}
              </p>
            )}
          </div>
          {cancellable && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-rose-400/50 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25"
            >
              중단
            </button>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full transition-[width] duration-200"
              style={{
                width: `${pct}%`,
                background: 'linear-gradient(90deg, #38bdf8, #818cf8)',
              }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs tabular-nums">
            <span className="text-slate-200 font-semibold">
              {progress.current.toLocaleString()} / {progress.total.toLocaleString()}
              <span className="text-slate-500 font-normal ml-1">({pct}%)</span>
            </span>
            <span className="text-slate-400">
              경과 {formatMmSs(elapsed)}
              {remaining != null ? ` · 남은 시간 약 ${formatMmSs(remaining)}` : ''}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
          {progress.mode === 'batch' && progress.totalBoxes != null && (
            <span>누적 박스 {progress.totalBoxes.toLocaleString()}개</span>
          )}
          {progress.failures != null && progress.failures > 0 && (
            <span className="text-amber-300">실패 {progress.failures.toLocaleString()}장</span>
          )}
          {progress.phase === 'save' && (
            <span className="text-emerald-300">처리 마무리 중…</span>
          )}
        </div>
      </div>
    </div>
  );
};

const OcrLabelWorkspace: React.FC = () => {
  const [workFolderPath, setWorkFolderPath] = useState<string | null>(null);
  const [imageList, setImageList] = useState<OfflineImageItem[]>([]);
  const [labelExportBusy, setLabelExportBusy] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [ocrReady, setOcrReady] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<OcrJobProgress | null>(null);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<CanvasTool>('select');
  const [autoReRecognize, setAutoReRecognize] = useState(() => {
    try {
      const v = localStorage.getItem(AUTO_RECOGNIZE_LS);
      return v !== '0';
    } catch {
      return true;
    }
  });
  const [boxLabelDisplay, setBoxLabelDisplay] = useState<BoxLabelDisplay>(() => loadBoxLabelDisplay());
  const [modelPreset, setModelPreset] = useState<OcrModelPreset>(() => loadModelPreset());
  const [loadedModelPreset, setLoadedModelPreset] = useState<OcrModelPreset | null>(null);
  const [detectOptions, setDetectOptions] = useState<OcrDetectOptions>(() => loadOcrDetectOptions());
  const [focusTextOnNewBox, setFocusTextOnNewBox] = useState(() => loadFocusTextOnNewBox());

  const [displayItem, setDisplayItem] = useState<OfflineImageItem | null>(null);
  const [boxes, setBoxes] = useState<OcrBoxPixel[]>([]);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  const displayItemRef = useRef<OfflineImageItem | null>(null);
  const boxesRef = useRef<OcrBoxPixel[]>([]);
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  const lastWriteWarningRef = useRef<{ path: string; at: number } | null>(null);
  const autoReRecognizeRef = useRef(autoReRecognize);
  const detectOptionsRef = useRef(detectOptions);
  const ocrReadyRef = useRef(ocrReady);
  const undoStackRef = useRef<OcrBoxPixel[][]>([]);
  const redoStackRef = useRef<OcrBoxPixel[][]>([]);
  const pushHistoryRef = useRef<(() => void) | null>(null);
  const ocrCancelRef = useRef(false);
  const lastProgressUiAtRef = useRef(0);
  const boxInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const pendingFocusBoxIdRef = useRef<string | null>(null);

  const isElectron = typeof window !== 'undefined' && !!window.electron;
  const navCount = imageList.length;
  const currentItem = navCount > 0 && currentIndex >= 0 && currentIndex < navCount ? imageList[currentIndex]! : null;

  useEffect(() => {
    if (navCount > 0 && currentIndex >= navCount) {
      setCurrentIndex(navCount - 1);
    }
  }, [navCount, currentIndex]);

  useEffect(() => {
    displayItemRef.current = displayItem;
    boxesRef.current = boxes;
  }, [displayItem, boxes]);

  useEffect(() => {
    naturalSizeRef.current = naturalSize;
  }, [naturalSize]);

  useEffect(() => {
    autoReRecognizeRef.current = autoReRecognize;
    try {
      localStorage.setItem(AUTO_RECOGNIZE_LS, autoReRecognize ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [autoReRecognize]);

  useEffect(() => {
    detectOptionsRef.current = detectOptions;
    saveOcrDetectOptions(detectOptions);
  }, [detectOptions]);

  useEffect(() => {
    ocrReadyRef.current = ocrReady;
  }, [ocrReady]);

  useEffect(() => {
    try {
      localStorage.setItem(BOX_LABEL_DISPLAY_LS, JSON.stringify(boxLabelDisplay));
    } catch {
      /* ignore */
    }
  }, [boxLabelDisplay]);

  useEffect(() => {
    try {
      localStorage.setItem(FOCUS_TEXT_ON_NEW_BOX_LS, focusTextOnNewBox ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [focusTextOnNewBox]);

  useEffect(() => {
    const id = pendingFocusBoxIdRef.current;
    if (!id || selectedBoxId !== id) return;
    pendingFocusBoxIdRef.current = null;
    requestAnimationFrame(() => {
      const el = boxInputRefs.current.get(id);
      el?.focus();
      el?.select();
    });
  }, [boxes, selectedBoxId]);

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_PRESET_LS, modelPreset);
    } catch {
      /* ignore */
    }
    if (loadedModelPreset != null && loadedModelPreset !== modelPreset) {
      setOcrReady(false);
      setLoadedModelPreset(null);
      setStatusMessage(`${PRESET_LABELS[modelPreset]} 선택 — OCR 준비를 다시 실행하세요`);
    }
  }, [modelPreset, loadedModelPreset]);

  const imageListRef = useRef(imageList);
  useEffect(() => {
    imageListRef.current = imageList;
  }, [imageList]);

  const notifyJsonWriteFailure = useCallback((path: string) => {
    setStatusMessage('JSON 라벨 저장 실패');
    const now = Date.now();
    const last = lastWriteWarningRef.current;
    if (last && last.path === path && now - last.at < 5000) return;
    lastWriteWarningRef.current = { path, at: now };
    window.alert(
      ['OCR JSON 라벨 저장에 실패했습니다.', '작업 폴더 쓰기 권한을 확인해 주세요.', '', `대상: ${path}`].join(
        '\n'
      )
    );
  }, []);

  const loadBoxesForItem = useCallback(async (item: OfflineImageItem): Promise<OcrBoxPixel[]> => {
    if (!window.electron) return [];
    try {
      const res = await window.electron.readJsonFile(item.jsonPath);
      if (!res.ok || !res.text) return [];
      return parseOcrSidecar(res.text);
    } catch {
      return [];
    }
  }, []);

  const persistCurrentJson = useCallback(
    async (item: OfflineImageItem, list: OcrBoxPixel[]): Promise<boolean> => {
      if (!window.electron) return false;
      const content = serializeOcrSidecar(list);
      const ok = await window.electron.writeJsonFile(item.jsonPath, content);
      if (!ok) {
        notifyJsonWriteFailure(item.jsonPath);
        return false;
      }
      return true;
    },
    [notifyJsonWriteFailure]
  );

  const applyBoxes = useCallback((next: OcrBoxPixel[]) => {
    setBoxes(next);
    setSelectedBoxId((prev) => (prev && next.some((b) => b.id === prev) ? prev : null));
  }, []);

  useEffect(() => {
    if (!currentItem || !window.electron) {
      setDisplayItem(null);
      applyBoxes([]);
      setNaturalSize(null);
      undoStackRef.current = [];
      redoStackRef.current = [];
      return;
    }
    undoStackRef.current = [];
    redoStackRef.current = [];
    const item = currentItem;
    let cancelled = false;
    setNaturalSize(null);
    void loadBoxesForItem(item).then((loaded) => {
      if (cancelled) return;
      setDisplayItem(item);
      applyBoxes(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [applyBoxes, currentItem, loadBoxesForItem]);

  const handleOpenFolder = useCallback(async () => {
    if (!window.electron) return;
    try {
      const path = await window.electron.openFolderDialog();
      if (!path) return;
      if (displayItemRef.current) {
        await persistCurrentJson(displayItemRef.current, boxesRef.current);
      }
      await window.electron.setWorkspaceRoot(path);
      const list = await window.electron.scanFolder(path);
      setWorkFolderPath(path);
      setImageList(list);
      setCurrentIndex(0);
      setOcrReady(false);
      setStatusMessage(`폴더 열림: ${path} — 하위 폴더 포함 ${list.length}개 이미지 (.json 사이드카)`);
    } catch (e) {
      setStatusMessage(`폴더 열기 실패: ${(e as Error).message}`);
    }
  }, [persistCurrentJson]);

  const handleExportLabelTxt = useCallback(async () => {
    if (!window.electron) return;
    try {
      const root = await window.electron.openFolderDialog();
      if (!root) return;

      if (workFolderPath && sameFolderPath(workFolderPath, root) && displayItemRef.current) {
        await persistCurrentJson(displayItemRef.current, boxesRef.current);
      }

      setLabelExportBusy(true);
      setStatusMessage('Label.txt 통합 중…');

      const res = await exportPpocrLabelTxtFromFolder(
        root,
        (folderPath) => window.electron!.scanFolder(folderPath),
        (jsonPath) => window.electron!.readJsonFile(jsonPath),
        (labelPath, content) => window.electron!.writeTxt(labelPath, content)
      );

      if (!res.ok) {
        setStatusMessage(res.error || 'Label.txt 생성 실패');
        window.alert(res.error || 'Label.txt 생성에 실패했습니다.');
        return;
      }

      setStatusMessage(
        `Label.txt 생성 — ${res.labeledImageCount}/${res.imageCount}장 · 박스 ${res.boxCount.toLocaleString()}개 · ${res.labelPath}`
      );
    } catch (e) {
      setStatusMessage(`Label.txt 생성 실패: ${(e as Error).message}`);
      window.alert(`Label.txt 생성 실패: ${(e as Error).message}`);
    } finally {
      setLabelExportBusy(false);
    }
  }, [persistCurrentJson, workFolderPath]);

  const saveCurrent = useCallback(async () => {
    if (!window.electron || !displayItem) return true;
    return persistCurrentJson(displayItem, boxesRef.current);
  }, [displayItem, persistCurrentJson]);

  const goToIndex = useCallback(
    async (next: number) => {
      if (navCount <= 0 || next < 0 || next >= navCount || next === currentIndex) return;
      const ok = await saveCurrent();
      if (!ok) return;
      setCurrentIndex(next);
    },
    [currentIndex, navCount, saveCurrent]
  );

  const goPrev = useCallback(() => void goToIndex(currentIndex - 1), [currentIndex, goToIndex]);
  const goNext = useCallback(() => void goToIndex(currentIndex + 1), [currentIndex, goToIndex]);
  const goPrevRef = useRef(goPrev);
  const goNextRef = useRef(goNext);
  goPrevRef.current = goPrev;
  goNextRef.current = goNext;

  const handleOcrInit = useCallback(async (): Promise<boolean> => {
    if (!window.electron?.ocrInit) return false;
    setOcrBusy(true);
    const presetLabel = PRESET_LABELS[modelPreset];
    setStatusMessage(`${presetLabel} 로딩 중… (최초 1회 · 모델 다운로드)`);
    try {
      const res = await window.electron.ocrInit('korean', modelPreset, detectOptionsRef.current);
      if (!res.ok) throw new Error(res.error || 'init failed');
      setOcrReady(true);
      setLoadedModelPreset(modelPreset);
      const load = typeof res.loadMs === 'number' ? ` · ${res.loadMs}ms` : '';
      const model = res.modelLabel ? ` · ${res.modelLabel}` : presetLabel;
      setStatusMessage(`OCR 준비 완료${load}${model}`);
      return true;
    } catch (e) {
      setOcrReady(false);
      setStatusMessage(`OCR 초기화 실패: ${(e as Error).message}`);
      return false;
    } finally {
      setOcrBusy(false);
    }
  }, [modelPreset]);

  const ensureOcrReady = useCallback(async (): Promise<boolean> => {
    if (ocrReadyRef.current) return true;
    return handleOcrInit();
  }, [handleOcrInit]);

  const reportOcrProgress = useCallback((next: OcrJobProgress, force = false) => {
    const now = Date.now();
    if (!force && next.current < next.total && now - lastProgressUiAtRef.current < PROGRESS_UI_MS) {
      return;
    }
    lastProgressUiAtRef.current = now;
    setOcrProgress(next);
    if (next.mode === 'batch') {
      const pct =
        next.total > 0 ? Math.min(100, Math.round((next.current / next.total) * 100)) : 0;
      const name = next.fileName ? ` — ${next.fileName}` : '';
      setStatusMessage(`폴더 자동 인식 ${next.current.toLocaleString()}/${next.total.toLocaleString()} (${pct}%)${name}`);
    }
  }, []);

  const pushHistory = useCallback(() => {
    undoStackRef.current = [...undoStackRef.current, cloneOcrBoxes(boxesRef.current)];
    redoStackRef.current = [];
  }, []);

  pushHistoryRef.current = pushHistory;

  const handleBoxesChange = useCallback(
    (next: OcrBoxPixel[], options?: { recordHistory?: boolean }) => {
      if (options?.recordHistory !== false) {
        pushHistory();
      }
      applyBoxes(next);
      const item = displayItemRef.current;
      if (item && window.electron) {
        void persistCurrentJson(item, next);
      }
    },
    [applyBoxes, persistCurrentJson, pushHistory]
  );

  const applyUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1]!;
    undoStackRef.current = stack.slice(0, -1);
    redoStackRef.current = [...redoStackRef.current, cloneOcrBoxes(boxesRef.current)];
    handleBoxesChange(prev, { recordHistory: false });
    setStatusMessage('실행 취소');
  }, [handleBoxesChange]);

  const applyRedo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const next = stack[stack.length - 1]!;
    redoStackRef.current = stack.slice(0, -1);
    undoStackRef.current = [...undoStackRef.current, cloneOcrBoxes(boxesRef.current)];
    handleBoxesChange(next, { recordHistory: false });
    setStatusMessage('다시 실행');
  }, [handleBoxesChange]);

  const syncBoxesToMapAndSave = useCallback(
    async (next: OcrBoxPixel[], options?: { recordHistory?: boolean }) => {
      handleBoxesChange(next, options);
    },
    [handleBoxesChange]
  );

  const recognizeBox = useCallback(async (box: OcrBoxPixel): Promise<OcrBoxPixel> => {
    const item = displayItemRef.current;
    if (!window.electron?.ocrRecognizeQuad || !item) return box;
    const res = await window.electron.ocrRecognizeQuad(item.imagePath, box.points);
    if (!res.ok) throw new Error(res.error || 'recognize failed');
    const text = String(res.text ?? '').trim() || '###';
    return { ...box, text, score: res.score };
  }, []);

  const recognizeAndUpdateBox = useCallback(
    async (boxId: string) => {
      const cur = boxesRef.current;
      const box = cur.find((b) => b.id === boxId);
      if (!box) return;
      const ready = await ensureOcrReady();
      if (!ready) return;
      setOcrBusy(true);
      try {
        const updated = await recognizeBox(box);
        const next = boxesRef.current.map((b) => (b.id === boxId ? updated : b));
        await syncBoxesToMapAndSave(next);
      } catch (e) {
        setStatusMessage(`재인식 실패: ${(e as Error).message}`);
      } finally {
        setOcrBusy(false);
      }
    },
    [ensureOcrReady, recognizeBox, syncBoxesToMapAndSave]
  );

  const handleNewBox = useCallback(
    (box: OcrBoxPixel) => {
      if (focusTextOnNewBox) {
        setActiveTool('select');
        pendingFocusBoxIdRef.current = box.id;
      }
      if (!autoReRecognizeRef.current) return;
      void recognizeAndUpdateBox(box.id);
    },
    [focusTextOnNewBox, recognizeAndUpdateBox]
  );

  const handleTextChange = useCallback(
    (id: string, text: string) => {
      handleBoxesChange(
        boxes.map((b) => (b.id === id ? { ...b, text } : b)),
        { recordHistory: true }
      );
    },
    [boxes, handleBoxesChange]
  );

  const handleAutoDetect = useCallback(async () => {
    if (!window.electron?.ocrDetectRecognize || !displayItem) return;
    if (boxes.length > 0) {
      const ok = window.confirm(
        '기존 박스를 모두 지우고 이미지 전체를 다시 검출합니다. 계속할까요?'
      );
      if (!ok) return;
    }
    const ready = await ensureOcrReady();
    if (!ready) return;
    setOcrBusy(true);
    ocrCancelRef.current = false;
    setOcrProgress({
      mode: 'single',
      current: 0,
      total: 1,
      fileName: displayItem.name,
      startedAt: Date.now(),
      phase: 'detect',
    });
    setStatusMessage('자동 인식 중… (현재 이미지)');
    try {
      const res = await window.electron.ocrDetectRecognize(
        displayItem.imagePath,
        'korean',
        detectOptionsRef.current
      );
      if (!res.ok) throw new Error(res.error || 'detect failed');
      const detected = (res.boxes ?? []).map((r) => pointsFromDetectResult(r));
      await syncBoxesToMapAndSave(detected);
      const ms = typeof res.predictMs === 'number' ? res.predictMs : undefined;
      const timing = ms != null ? ` · ${ms}ms` : '';
      setStatusMessage(`자동 인식 완료 — ${detected.length}개${timing}`);
    } catch (e) {
      setStatusMessage(`자동 검출 실패: ${(e as Error).message}`);
    } finally {
      setOcrProgress(null);
      setOcrBusy(false);
    }
  }, [boxes.length, displayItem, ensureOcrReady, syncBoxesToMapAndSave]);

  const handleBatchAutoDetect = useCallback(async () => {
    const list = imageListRef.current;
    if (!window.electron?.ocrBatchDetect || list.length === 0) return;

    const ok = window.confirm(
      `폴더 내 ${list.length}개 이미지에 자동 인식을 실행합니다.\n기존 JSON 라벨이 모두 덮어씌워집니다. 계속할까요?`
    );
    if (!ok) return;

    const ready = await ensureOcrReady();
    if (!ready) return;

    if (displayItemRef.current) {
      await persistCurrentJson(displayItemRef.current, boxesRef.current);
    }
    setOcrBusy(true);
    ocrCancelRef.current = false;
    lastProgressUiAtRef.current = 0;
    let totalBoxes = 0;
    let failures = 0;
    const startedAt = Date.now();
    let processed = 0;
    let cancelled = false;
    let totalPredictMs = 0;

    try {
      for (let offset = 0; offset < list.length; offset += OCR_BATCH_CHUNK) {
        if (ocrCancelRef.current) {
          cancelled = true;
          break;
        }
        const chunk = list.slice(offset, offset + OCR_BATCH_CHUNK);
        const paths = chunk.map((item) => item.imagePath);
        reportOcrProgress(
          {
            mode: 'batch',
            current: processed,
            total: list.length,
            fileName: chunk[0]?.name,
            failures,
            totalBoxes,
            startedAt,
            phase: 'detect',
          },
          offset === 0
        );
        const res = await window.electron.ocrBatchDetect(paths, 'korean', detectOptionsRef.current);
        if (!res.ok) throw new Error(res.error || 'batch detect failed');
        if (typeof res.totalPredictMs === 'number') totalPredictMs += res.totalPredictMs;

        for (let j = 0; j < chunk.length; j++) {
          const item = chunk[j]!;
          const row = res.results?.[j];
          processed += 1;
          if (!row?.ok) {
            failures += 1;
          } else {
            const detected = (row.boxes ?? []).map((r) => pointsFromDetectResult(r));
            const saved = await persistCurrentJson(item, detected);
            if (!saved) failures += 1;
            else totalBoxes += detected.length;
            if (displayItemRef.current?.imagePath === item.imagePath) {
              applyBoxes(detected);
              setSelectedBoxId(null);
            }
          }
          reportOcrProgress(
            {
              mode: 'batch',
              current: processed,
              total: list.length,
              fileName: item.name,
              failures,
              totalBoxes,
              startedAt,
              phase: 'detect',
            },
            processed === list.length || processed % 10 === 0
          );
        }
      }

      reportOcrProgress(
        {
          mode: 'batch',
          current: processed,
          total: list.length,
          failures,
          totalBoxes,
          startedAt,
          phase: 'save',
        },
        true
      );

      undoStackRef.current = [];
      redoStackRef.current = [];

      const cur = displayItemRef.current;
      if (cur) {
        const loaded = await loadBoxesForItem(cur);
        applyBoxes(loaded);
        setSelectedBoxId(null);
      }

      const failMsg = failures > 0 ? `, 실패 ${failures}장` : '';
      const cancelMsg = cancelled ? ` (사용자 중단 — ${processed.toLocaleString()}장까지 반영)` : '';
      const avgMs = processed > 0 ? Math.round(totalPredictMs / processed) : 0;
      const timingMsg = processed > 0 ? ` · 평균 ${avgMs}ms/장` : '';
      setStatusMessage(
        `폴더 자동 인식 ${cancelled ? '중단' : '완료'} — ${processed.toLocaleString()}/${list.length.toLocaleString()}장 · 박스 ${totalBoxes.toLocaleString()}개${failMsg}${cancelMsg}${timingMsg}`
      );
    } catch (e) {
      setStatusMessage(`폴더 자동 인식 실패: ${(e as Error).message}`);
    } finally {
      setOcrProgress(null);
      setOcrBusy(false);
      ocrCancelRef.current = false;
    }
  }, [applyBoxes, ensureOcrReady, loadBoxesForItem, persistCurrentJson, reportOcrProgress]);

  const handleReRecognizeAll = useCallback(async () => {
    if (!displayItem || boxes.length === 0) return;
    const ready = await ensureOcrReady();
    if (!ready) return;
    setOcrBusy(true);
    ocrCancelRef.current = false;
    const total = boxesRef.current.length;
    const startedAt = Date.now();
    setOcrProgress({ mode: 'recognize', current: 0, total, startedAt });
    setStatusMessage('전체 박스 재인식 중…');
    try {
      pushHistory();
      const next: OcrBoxPixel[] = [];
      for (let i = 0; i < boxesRef.current.length; i++) {
        const box = boxesRef.current[i]!;
        next.push(await recognizeBox(box));
        reportOcrProgress(
          { mode: 'recognize', current: i + 1, total, startedAt },
          i === 0 || i + 1 === total || (i + 1) % 5 === 0
        );
      }
      await syncBoxesToMapAndSave(next, { recordHistory: false });
      setStatusMessage('전체 재인식 완료');
    } catch (e) {
      setStatusMessage(`재인식 실패: ${(e as Error).message}`);
    } finally {
      setOcrProgress(null);
      setOcrBusy(false);
    }
  }, [boxes.length, displayItem, ensureOcrReady, pushHistory, recognizeBox, reportOcrProgress, syncBoxesToMapAndSave]);

  const handleReRecognizeSelected = useCallback(async () => {
    if (!selectedBoxId) {
      setStatusMessage('재인식할 박스를 목록에서 선택하세요');
      return;
    }
    await recognizeAndUpdateBox(selectedBoxId);
    setStatusMessage('선택 박스 재인식 완료');
  }, [recognizeAndUpdateBox, selectedBoxId]);

  const handleAddManualBox = useCallback(() => {
    const ns = naturalSizeRef.current;
    if (!ns) return;
    const w = Math.min(120, ns.w * 0.2);
    const h = Math.min(40, ns.h * 0.08);
    const box = newManualOcrBox(ns.w / 2, ns.h / 2, w, h);
    const next = [...boxesRef.current, box];
    void syncBoxesToMapAndSave(next);
    setSelectedBoxId(box.id);
    handleNewBox(box);
  }, [handleNewBox, syncBoxesToMapAndSave]);

  const selectedBoxIdRef = useRef(selectedBoxId);
  useEffect(() => {
    selectedBoxIdRef.current = selectedBoxId;
  }, [selectedBoxId]);

  const deleteSelectedBox = useCallback(() => {
    const id = selectedBoxIdRef.current;
    if (!id) return;
    const next = boxesRef.current.filter((b) => b.id !== id);
    void syncBoxesToMapAndSave(next);
    setSelectedBoxId(null);
  }, [syncBoxesToMapAndSave]);

  const applyUndoRef = useRef(applyUndo);
  const applyRedoRef = useRef(applyRedo);
  applyUndoRef.current = applyUndo;
  applyRedoRef.current = applyRedo;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const key = e.key.toLowerCase();
      const isCtrl = e.ctrlKey || e.metaKey;
      if (isCtrl && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        applyUndoRef.current();
        return;
      }
      if (isCtrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        applyRedoRef.current();
        return;
      }
      if (e.ctrlKey && key === 'o') {
        e.preventDefault();
        void handleOpenFolder();
        return;
      }
      if (e.ctrlKey && key === 's') {
        e.preventDefault();
        void saveCurrent();
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
      if (key === 'w' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        void handleAutoDetect();
        return;
      }
      if (key === 'f' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setActiveTool((t) => {
          const next = t === 'drawRect' ? 'select' : 'drawRect';
          setStatusMessage(next === 'drawRect' ? 'RectBox 그리기 모드 — 드래그로 영역을 지정하세요' : '선택 모드');
          return next;
        });
        return;
      }
      if (key === 'r' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        deleteSelectedBox();
        return;
      }
      if (e.ctrlKey && e.shiftKey && key === 'r') {
        e.preventDefault();
        void handleReRecognizeAll();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && key === 'r') {
        e.preventDefault();
        void handleReRecognizeSelected();
        return;
      }
      if (key === 'escape') {
        setActiveTool('select');
      }
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
      if (e.key === 'Escape' && shortcutsOpen) setShortcutsOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [deleteSelectedBox, handleAutoDetect, handleOpenFolder, handleReRecognizeAll, handleReRecognizeSelected, saveCurrent, shortcutsOpen]);

  if (!isElectron) {
    return <div className="h-full flex items-center justify-center text-slate-400">Electron으로 실행해 주세요</div>;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <header className="glass flex-shrink-0 border-b border-white/10 px-4 py-2.5 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => void handleOpenFolder()}
          className="px-3 py-1.5 rounded-xl glass border border-white/10 text-sm font-medium text-sky-300 hover:border-sky-400/50"
        >
          폴더 (Ctrl+O)
        </button>
        <button
          type="button"
          disabled={labelExportBusy || ocrBusy}
          onClick={() => void handleExportLabelTxt()}
          className="px-3 py-1.5 rounded-xl glass border border-violet-400/40 text-sm font-medium text-violet-200 hover:border-violet-400/60 disabled:opacity-50"
          title="루트 폴더 선택 → 이미지별 JSON을 PPOCRLabel Label.txt로 통합"
        >
          {labelExportBusy ? 'Label.txt…' : 'Label.txt 통합'}
        </button>
        <button
          type="button"
          onClick={() => void saveCurrent()}
          className="px-3 py-1.5 rounded-xl text-sm font-medium border border-amber-400/50 bg-amber-500/20 text-amber-100"
        >
          저장 (Ctrl+S)
        </button>
        {displayItem && (
          <button
            type="button"
            onClick={() => window.electron!.showItemInFolder(displayItem.imagePath)}
            className="px-3 py-1.5 rounded-xl glass border border-white/10 text-sm text-slate-300"
          >
            탐색기
          </button>
        )}
        <span className="text-xs text-slate-400 font-mono truncate flex-1 min-w-0">
          {ocrBusy && statusMessage
            ? statusMessage
            : displayItem
              ? displayItem.name
              : statusMessage || workFolderPath || '폴더를 열어 주세요'}
        </span>
        <button type="button" onClick={() => setShortcutsOpen(true)} className="px-2 py-1 rounded-lg text-xs text-slate-500 border border-white/10">
          ?
        </button>
      </header>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <aside className="glass w-80 flex-shrink-0 border-r border-white/10 flex flex-col min-h-0">
          <div className="p-2.5 border-b border-white/10 space-y-1.5 flex-shrink-0">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={ocrBusy}
                onClick={() => void handleOcrInit()}
                className="flex-1 min-w-[5.5rem] px-2 py-1.5 rounded-lg text-[11px] border border-emerald-400/40 bg-emerald-500/15 text-emerald-100 disabled:opacity-50"
              >
                {ocrReady ? 'OCR 준비됨' : 'OCR 준비'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTool((t) => {
                    const next = t === 'drawRect' ? 'select' : 'drawRect';
                    setStatusMessage(next === 'drawRect' ? 'RectBox 그리기 — 드래그 후 자동 재인식(옵션)' : '선택 모드');
                    return next;
                  });
                }}
                className={`flex-1 min-w-[5.5rem] px-2 py-1.5 rounded-lg text-[11px] border ${
                  activeTool === 'drawRect'
                    ? 'border-amber-400/70 bg-amber-500/25 text-amber-50'
                    : 'border-cyan-400/60 bg-cyan-500/15 text-cyan-100'
                }`}
                title="F"
              >
                {activeTool === 'drawRect' ? 'RectBox (F)' : '선택 (F)'}
              </button>
              <button
                type="button"
                disabled={ocrBusy || !displayItem}
                onClick={() => void handleAutoDetect()}
                className="flex-1 min-w-[5.5rem] px-2 py-1.5 rounded-lg text-[11px] border border-cyan-400/40 bg-cyan-500/15 text-cyan-100 disabled:opacity-50"
                title="W — PPOCRLabel autoRecognitionCurrent"
              >
                자동 인식 (현재)
              </button>
              <button
                type="button"
                disabled={ocrBusy || imageList.length === 0}
                onClick={() => void handleBatchAutoDetect()}
                className="flex-1 min-w-[5.5rem] px-2 py-1.5 rounded-lg text-[11px] border border-violet-400/40 bg-violet-500/15 text-violet-100 disabled:opacity-50"
                title={`폴더 ${imageList.length}장 — PPOCRLabel autoRecognition`}
              >
                자동 인식 (폴더)
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={ocrBusy || boxes.length === 0}
                onClick={() => void handleReRecognizeAll()}
                className="flex-1 min-w-[5.5rem] px-2 py-1.5 rounded-lg text-[11px] border border-white/10 text-slate-200 disabled:opacity-50"
                title="Ctrl+Shift+R"
              >
                전체 재인식
              </button>
              <button
                type="button"
                disabled={ocrBusy || !selectedBoxId}
                onClick={() => void handleReRecognizeSelected()}
                className="flex-1 min-w-[5.5rem] px-2 py-1.5 rounded-lg text-[11px] border border-white/10 text-slate-300 disabled:opacity-50"
                title="Ctrl+R"
              >
                선택 재인식
              </button>
            </div>

            <details className="rounded-lg border border-white/10 bg-slate-900/40 px-2 py-1.5 group">
              <summary className="cursor-pointer select-none text-[11px] font-semibold text-slate-300 list-none flex items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
                <span>인식 옵션</span>
                <span className="text-slate-500 text-[10px] font-normal group-open:hidden">펼치기</span>
              </summary>
              <div className="pt-2 space-y-2 border-t border-white/5 mt-1.5">
                <div className="flex flex-wrap gap-1.5 items-center">
                  <label className="text-[10px] text-slate-500 shrink-0 w-14">모델</label>
                  <select
                    value={modelPreset}
                    disabled={ocrBusy}
                    onChange={(e) => {
                      const v = e.target.value;
                      setModelPreset(
                        v === 'server' ? 'server' : v === 'v6_tiny' ? 'v6_tiny' : 'mobile'
                      );
                    }}
                    className="flex-1 min-w-0 text-[10px] rounded-lg border border-white/10 bg-slate-900/80 text-slate-200 px-2 py-1 disabled:opacity-50"
                    title="v6 tiny: 기본 · mobile: v5 · server: v5 정확도"
                  >
                    <option value="mobile">PP-OCRv5 mobile</option>
                    <option value="server">PP-OCRv5 server</option>
                    <option value="v6_tiny">PP-OCRv6 tiny</option>
                  </select>
                </div>
                <div className="flex flex-wrap gap-1.5 items-center">
                  <label className="text-[10px] text-slate-500 shrink-0 w-14" htmlFor="ocr-min-text-len">
                    최소 글자
                  </label>
                  <input
                    id="ocr-min-text-len"
                    type="number"
                    min={1}
                    max={32}
                    step={1}
                    disabled={ocrBusy}
                    value={detectOptions.minTextLen}
                    onChange={(e) =>
                      setDetectOptions((prev) =>
                        clampOcrDetectOptions({ ...prev, minTextLen: Number(e.target.value) })
                      )
                    }
                    className="flex-1 min-w-0 text-[10px] rounded-lg border border-white/10 bg-slate-900/80 text-slate-200 px-2 py-1 disabled:opacity-50 tabular-nums"
                    title="이 글자 수 미만인 검출 박스는 제외 (1 = 1글자도 포함)"
                  />
                </div>
                <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoReRecognize}
                    onChange={(e) => setAutoReRecognize(e.target.checked)}
                    className="rounded border-white/20 shrink-0"
                  />
                  박스 생성 시 재인식
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={focusTextOnNewBox}
                    onChange={(e) => setFocusTextOnNewBox(e.target.checked)}
                    className="rounded border-white/20 shrink-0"
                  />
                  박스 생성 후 텍스트 입력 포커스 (선택 모드로 전환)
                </label>
                <p className="text-[9px] text-slate-500 leading-relaxed">
                  검출 옵션은 자동 인식 시 적용됩니다. 표시·최소 박스는 캔버스 왼쪽 플로팅 메뉴에서 조절합니다.
                </p>
              </div>
            </details>
          </div>
          <div className="p-3 border-b border-white/10 flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">인식 텍스트 (4pt)</span>
            <button
              type="button"
              onClick={handleAddManualBox}
              disabled={!displayItem || !naturalSize}
              className="text-[10px] px-2 py-1 rounded-lg border border-white/10 text-slate-300 disabled:opacity-40"
            >
              + 박스
            </button>
          </div>
          <div className="flex-1 overflow-auto p-2 space-y-2">
            {boxes.length === 0 ? (
              <p className="text-xs text-slate-500 p-2">
                W 자동 인식(현재), F RectBox/선택. {PRESET_LABELS[modelPreset]} · OCR 준비 후 사용.
              </p>
            ) : (
              boxes.map((box, idx) => {
                const { w, h } = quadBounds(box.points);
                return (
                  <div
                    key={box.id}
                    className={`rounded-xl border p-2 ${selectedBoxId === box.id ? 'border-amber-400/60 bg-amber-500/10' : 'border-white/10 bg-white/[0.02]'}`}
                    onClick={() => setSelectedBoxId(box.id)}
                  >
                    <div className="text-[10px] text-slate-500 mb-1 font-mono">
                      #{idx + 1} · {Math.round(w)}×{Math.round(h)}px · 4pt
                      {box.score != null ? ` · ${(box.score * 100).toFixed(0)}%` : ''}
                    </div>
                    <input
                      ref={(el) => {
                        if (el) boxInputRefs.current.set(box.id, el);
                        else boxInputRefs.current.delete(box.id);
                      }}
                      type="text"
                      value={box.text}
                      onChange={(e) => handleTextChange(box.id, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full px-2 py-1.5 rounded-lg bg-slate-900/80 border border-white/10 text-sm text-white font-mono"
                      placeholder="transcription"
                    />
                  </div>
                );
              })
            )}
          </div>
          {displayItem?.jsonPath && (
            <div className="p-2 border-t border-white/10 text-[10px] text-slate-600 font-mono truncate" title={displayItem.jsonPath}>
              {displayItem.jsonPath}
            </div>
          )}
        </aside>

        <main className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 relative">
            {displayItem ? (
              <OcrQuadCanvas
                imageUrl={displayItem.imageUrl}
                boxes={boxes}
                onBoxesChange={handleBoxesChange}
                pushHistoryRef={pushHistoryRef}
                onNewBox={handleNewBox}
                selectedBoxId={selectedBoxId}
                onSelectedBoxIdChange={setSelectedBoxId}
                activeTool={activeTool}
                showBoxLabels={boxLabelDisplay.show}
                boxLabelFontPx={boxLabelDisplay.fontPx}
                pointSizePx={boxLabelDisplay.pointSize}
                boxLineWidthPx={boxLabelDisplay.lineThickness}
                minRectPx={detectOptions.minBoxSize}
                onNaturalSize={(w, h) => setNaturalSize({ w, h })}
                onShowBoxLabelsChange={(show) => setBoxLabelDisplay((prev) => ({ ...prev, show }))}
                onBoxLabelFontPxChange={(fontPx) => setBoxLabelDisplay((prev) => ({ ...prev, fontPx }))}
                onPointSizePxChange={(pointSize) =>
                  setBoxLabelDisplay((prev) => ({ ...prev, pointSize: clampOcrPointSize(pointSize) }))
                }
                onBoxLineWidthPxChange={(lineThickness) =>
                  setBoxLabelDisplay((prev) => ({
                    ...prev,
                    lineThickness: clampOcrLineThickness(lineThickness),
                  }))
                }
                onMinRectPxChange={(minBoxSize) =>
                  setDetectOptions((prev) => clampOcrDetectOptions({ ...prev, minBoxSize }))
                }
                focusTextOnNewBox={focusTextOnNewBox}
                onFocusTextOnNewBoxChange={setFocusTextOnNewBox}
                onOpenShortcuts={() => setShortcutsOpen(true)}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-slate-500 text-sm">
                {imageList.length === 0 ? 'Ctrl+O로 이미지 폴더를 열어 주세요' : '이미지 로딩 중…'}
              </div>
            )}
            {ocrProgress && (
              <OcrProgressPanel
                progress={ocrProgress}
                cancellable={ocrProgress.mode === 'batch' && ocrProgress.phase !== 'save'}
                onCancel={() => {
                  ocrCancelRef.current = true;
                  setStatusMessage('중단 요청됨 — 현재 이미지 처리 후 저장합니다…');
                }}
              />
            )}
            {ocrBusy && !ocrProgress && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center pointer-events-none">
                <span className="px-4 py-2 rounded-xl bg-slate-900/90 border border-white/10 text-sm text-white">OCR 처리 중…</span>
              </div>
            )}
          </div>
          <footer className="glass flex-shrink-0 border-t border-white/10 px-4 py-2.5 flex items-center gap-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={goPrev}
                disabled={ocrBusy || navCount <= 0 || currentIndex <= 0}
                className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_16px_rgba(82,182,255,0.15)] disabled:hover:border-white/10 disabled:hover:shadow-none"
                style={{ color: 'var(--accent-blue)' }}
              >
                이전 (A)
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={ocrBusy || navCount <= 0 || currentIndex >= navCount - 1}
                className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_16px_rgba(82,182,255,0.15)] disabled:hover:border-white/10 disabled:hover:shadow-none"
                style={{ color: 'var(--accent-blue)' }}
              >
                다음 (D)
              </button>
            </div>
            {navCount > 0 && (
              <>
                <span
                  className="shrink-0 text-lg font-bold tabular-nums whitespace-nowrap"
                  style={{ color: 'var(--accent-blue)' }}
                >
                  {currentIndex + 1} / {navCount}
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, navCount - 1)}
                  value={Math.min(currentIndex, Math.max(0, navCount - 1))}
                  disabled={ocrBusy}
                  onChange={(e) => {
                    const next = parseInt(e.target.value, 10);
                    if (next !== currentIndex) {
                      goToIndex(next);
                    }
                  }}
                  className="progress-slider flex-1 min-w-0 h-2 rounded-lg appearance-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white/30 [&::-webkit-slider-thumb]:shadow-lg [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0"
                  style={{ background: 'rgba(255,255,255,0.1)' }}
                />
              </>
            )}
          </footer>
        </main>
      </div>

      {shortcutsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setShortcutsOpen(false)}>
          <div className="glass border border-white/10 rounded-2xl p-5 max-w-md w-full text-sm text-slate-300" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-white mb-3">OCR 라벨 단축키 (PPOCRLabel 기준)</h3>
            <ul className="space-y-1.5 text-xs">
              <li><kbd className="text-amber-200">Ctrl+O</kbd> 폴더 열기</li>
              <li><kbd className="text-amber-200">—</kbd> Label.txt 통합 — 루트 폴더 선택 후 학습용 파일 생성</li>
              <li><kbd className="text-amber-200">Ctrl+S</kbd> 현재 이미지 JSON 저장</li>
              <li><kbd className="text-amber-200">A</kbd> / <kbd className="text-amber-200">D</kbd> 이전·다음 이미지</li>
              <li><kbd className="text-amber-200">W</kbd> 자동 인식 (현재 이미지)</li>
              <li><kbd className="text-amber-200">F</kbd> RectBox ↔ 선택 모드 전환</li>
              <li><kbd className="text-amber-200">R</kbd> 선택 박스 삭제</li>
              <li><kbd className="text-amber-200">Ctrl+Z</kbd> 실행 취소</li>
              <li><kbd className="text-amber-200">Ctrl+Shift+Z</kbd> / <kbd className="text-amber-200">Ctrl+Y</kbd> 다시 실행</li>
              <li><kbd className="text-amber-200">Ctrl+R</kbd> 선택 박스 재인식</li>
              <li><kbd className="text-amber-200">Ctrl+Shift+R</kbd> 전체 박스 재인식</li>
              <li><kbd className="text-amber-200">Esc</kbd> 선택 모드</li>
              <li><kbd className="text-amber-200">]</kbd> 캔버스 플로팅 메뉴 표시/숨김</li>
              <li>꼭짓점·박스 드래그 편집 · Del 삭제 · 휠 확대 · Space+드래그 이동</li>
              <li>플로팅 메뉴: 박스 텍스트·표시, 확대 초기화, 표시 설정, 모든 박스 삭제</li>
            </ul>
            <p className="mt-3 text-[10px] text-slate-500">재인식은 4점 투시 크롭(PPOCRLabel get_rotate_crop_image) 사용.</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default OcrLabelWorkspace;
