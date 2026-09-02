import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OcrBoxPixel } from '../ocrTypes';
import { newOcrBoxId, quadBounds, rectDragToQuad } from '../ocrTypes';

type Tool = 'select' | 'drawRect';

type BoxesChangeOptions = { recordHistory?: boolean };

const FLOATING_UI_LS = 'intellivixOcr.floatingUiVisibleV1';
const AUTO_FIXED_DISPLAY_LS = 'intellivixOcr.autoFixedDisplayV1';
const FIXED_DISPLAY_WIDTH_LS = 'intellivixOcr.fixedDisplayWidthV1';
const DEFAULT_FIXED_DISPLAY_WIDTH = 640;

function loadAutoFixedDisplay(): boolean {
  try {
    const v = localStorage.getItem(AUTO_FIXED_DISPLAY_LS);
    if (v == null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

function loadFixedDisplayWidth(): number {
  try {
    const raw = localStorage.getItem(FIXED_DISPLAY_WIDTH_LS);
    if (!raw) return DEFAULT_FIXED_DISPLAY_WIDTH;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(3840, Math.max(320, Math.round(n))) : DEFAULT_FIXED_DISPLAY_WIDTH;
  } catch {
    return DEFAULT_FIXED_DISPLAY_WIDTH;
  }
}

function computeFixedDisplayScale(naturalW: number, targetWidthPx: number): number {
  if (naturalW <= 0 || targetWidthPx <= 0) return 1;
  return Math.min(12, Math.max(0.15, targetWidthPx / naturalW));
}

const Tooltip = ({ text, children }: { text: string; children: React.ReactNode }) => (
  <div className="group relative flex items-center">
    <div className="absolute left-full ml-4 px-3 py-2 bg-slate-900/95 backdrop-blur-xl border border-white/10 text-white text-[12px] font-bold tracking-wide rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.5)] whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0 transition-all duration-300 z-[100]">
      {text}
    </div>
    {children}
  </div>
);

interface OcrQuadCanvasProps {
  imageUrl: string;
  boxes: OcrBoxPixel[];
  onBoxesChange: (next: OcrBoxPixel[], options?: BoxesChangeOptions) => void;
  pushHistoryRef?: React.MutableRefObject<(() => void) | null>;
  onNewBox?: (box: OcrBoxPixel) => void;
  selectedBoxId: string | null;
  onSelectedBoxIdChange: (id: string | null) => void;
  activeTool: Tool;
  strokeColor?: string;
  showBoxLabels?: boolean;
  boxLabelFontPx?: number;
  /** 화면 기준 꼭짓점 핸들 크기 (px, 확대 시 일정) */
  pointSizePx?: number;
  /** 화면 기준 박스 테두리 두께 (px) */
  boxLineWidthPx?: number;
  minRectPx?: number;
  onNaturalSize?: (w: number, h: number) => void;
  onShowBoxLabelsChange?: (show: boolean) => void;
  onBoxLabelFontPxChange?: (px: number) => void;
  onPointSizePxChange?: (px: number) => void;
  onBoxLineWidthPxChange?: (px: number) => void;
  onMinRectPxChange?: (px: number) => void;
  focusTextOnNewBox?: boolean;
  onFocusTextOnNewBoxChange?: (enabled: boolean) => void;
  onOpenShortcuts?: () => void;
  readOnly?: boolean;
}

function clientToNatural(
  clientX: number,
  clientY: number,
  img: HTMLImageElement,
  nw: number,
  nh: number
): [number, number] {
  const rect = img.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * nw;
  const y = ((clientY - rect.top) / rect.height) * nh;
  return [Math.min(nw, Math.max(0, x)), Math.min(nh, Math.max(0, y))];
}

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}


function clientDistSqToNaturalPoint(
  clientX: number,
  clientY: number,
  img: HTMLImageElement,
  pt: [number, number],
  nw: number,
  nh: number
): number {
  const rect = img.getBoundingClientRect();
  const sx = rect.left + (pt[0] / nw) * rect.width;
  const sy = rect.top + (pt[1] / nh) * rect.height;
  const dx = clientX - sx;
  const dy = clientY - sy;
  return dx * dx + dy * dy;
}

function vertexScreenHitRadiusPx(pointSize: number): number {
  return Math.max(6, Math.min(11, pointSize + 2));
}

const DEFAULT_MIN_RECT_PX = 5;
const DEFAULT_POINT_SIZE_PX = 7;

const OcrQuadCanvas: React.FC<OcrQuadCanvasProps> = ({
  imageUrl,
  boxes,
  onBoxesChange,
  pushHistoryRef,
  onNewBox,
  selectedBoxId,
  onSelectedBoxIdChange,
  activeTool,
  strokeColor = '#22d3ee',
  showBoxLabels = true,
  boxLabelFontPx = 30,
  pointSizePx = DEFAULT_POINT_SIZE_PX,
  boxLineWidthPx = 4,
  minRectPx = DEFAULT_MIN_RECT_PX,
  onNaturalSize,
  onShowBoxLabelsChange,
  onBoxLabelFontPxChange,
  onPointSizePxChange,
  onBoxLineWidthPxChange,
  onMinRectPxChange,
  focusTextOnNewBox = true,
  onFocusTextOnNewBoxChange,
  onOpenShortcuts,
  readOnly = false,
}) => {
  const displayUrl = useMemo(() => {
    let normalized = imageUrl;
    try {
      normalized = decodeURIComponent(imageUrl);
    } catch {
      /* ignore */
    }
    normalized = normalized.replace(/\\/g, '/');
    return normalized
      .split('/')
      .map((part) => (part.endsWith(':') ? part : encodeURIComponent(part)))
      .join('/');
  }, [imageUrl]);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const boxesRef = useRef(boxes);
  const [nw, setNw] = useState(0);
  const [nh, setNh] = useState(0);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState<{ x: number; y: number } | null>(null);
  const isSpaceHeldRef = useRef(false);
  const [rectDrag, setRectDrag] = useState<{ start: [number, number]; end: [number, number] } | null>(null);
  const [showFloatingUi, setShowFloatingUi] = useState(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(FLOATING_UI_LS) === '0' ? false : true
  );
  const [autoFixedDisplay, setAutoFixedDisplay] = useState(() => loadAutoFixedDisplay());
  const [fixedDisplayWidthPx, setFixedDisplayWidthPx] = useState(() => loadFixedDisplayWidth());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDeleteAllConfirmOpen, setIsDeleteAllConfirmOpen] = useState(false);
  const [boxesVisible, setBoxesVisible] = useState(true);
  const dragRef = useRef<
    | { kind: 'vertex'; boxId: string; vi: number }
    | { kind: 'body'; boxId: string; origin: [number, number]; pts0: [number, number][] }
    | null
  >(null);
  const onNaturalSizeRef = useRef(onNaturalSize);
  onNaturalSizeRef.current = onNaturalSize;
  /** displayUrl당 자동 맞춤은 최초 1회만 (박스 편집·리렌더 시 줌/팬 유지) */
  const autoFitAppliedForUrlRef = useRef<string | null>(null);

  useEffect(() => {
    boxesRef.current = boxes;
  }, [boxes]);

  useEffect(() => {
    try {
      localStorage.setItem(FLOATING_UI_LS, showFloatingUi ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [showFloatingUi]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_FIXED_DISPLAY_LS, autoFixedDisplay ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [autoFixedDisplay]);

  useEffect(() => {
    try {
      localStorage.setItem(FIXED_DISPLAY_WIDTH_LS, String(fixedDisplayWidthPx));
    } catch {
      /* ignore */
    }
  }, [fixedDisplayWidthPx]);

  const applyFixedDisplayScale = useCallback(
    (naturalW: number, opts?: { resetPan?: boolean; force?: boolean }) => {
      if (!autoFixedDisplay || naturalW <= 0) return;
      if (!opts?.force && autoFitAppliedForUrlRef.current === displayUrl) return;
      autoFitAppliedForUrlRef.current = displayUrl;
      setScale(computeFixedDisplayScale(naturalW, fixedDisplayWidthPx));
      if (opts?.resetPan !== false) {
        setPan({ x: 0, y: 0 });
      }
    },
    [autoFixedDisplay, fixedDisplayWidthPx, displayUrl]
  );

  const syncNaturalSizeFromImg = useCallback((img: HTMLImageElement) => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w <= 0 || h <= 0) return;
    setNw(w);
    setNh(h);
    onNaturalSizeRef.current?.(w, h);
  }, []);

  const handleImgLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      syncNaturalSizeFromImg(img);
      applyFixedDisplayScale(img.naturalWidth, { force: true });
    },
    [syncNaturalSizeFromImg, applyFixedDisplayScale]
  );

  const resetView = useCallback(() => {
    if (autoFixedDisplay && nw > 0) {
      applyFixedDisplayScale(nw, { force: true });
      return;
    }
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, [applyFixedDisplayScale, autoFixedDisplay, nw]);

  useEffect(() => {
    autoFitAppliedForUrlRef.current = null;
    setNw(0);
    setNh(0);
    setPan({ x: 0, y: 0 });
    setScale(1);
  }, [displayUrl]);

  /** 캐시된 이미지는 onLoad가 다시 안 뜰 수 있음 */
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) {
      syncNaturalSizeFromImg(img);
      applyFixedDisplayScale(img.naturalWidth, { force: true });
    }
  }, [displayUrl, syncNaturalSizeFromImg, applyFixedDisplayScale]);

  useEffect(() => {
    if (nw <= 0 || !autoFixedDisplay) return;
    applyFixedDisplayScale(nw, { force: true });
  }, [autoFixedDisplay, fixedDisplayWidthPx, nw, applyFixedDisplayScale]);

  const handleDeleteAll = useCallback(() => {
    if (boxesRef.current.length === 0) return;
    pushHistoryRef?.current?.();
    onBoxesChange([], { recordHistory: false });
    onSelectedBoxIdChange(null);
    setIsDeleteAllConfirmOpen(false);
  }, [onBoxesChange, onSelectedBoxIdChange, pushHistoryRef]);

  const findVertexHit = useCallback(
    (clientX: number, clientY: number): { boxId: string; vi: number } | null => {
      if (!boxesVisible) return null;
      const img = imgRef.current;
      if (!img || nw <= 0) return null;
      const radius = vertexScreenHitRadiusPx(pointSizePx);
      const thr = radius * radius;
      for (let bi = boxes.length - 1; bi >= 0; bi--) {
        const box = boxes[bi]!;
        for (let vi = 0; vi < box.points.length; vi++) {
          const pt = box.points[vi]!;
          if (clientDistSqToNaturalPoint(clientX, clientY, img, pt, nw, nh) <= thr) {
            return { boxId: box.id, vi };
          }
        }
      }
      return null;
    },
    [boxes, nh, nw, pointSizePx, boxesVisible]
  );

  const findBoxHit = useCallback(
    (p: [number, number]): string | null => {
      if (!boxesVisible) return null;
      for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i]!;
        if (pointInPolygon(p[0], p[1], box.points)) return box.id;
      }
      return null;
    },
    [boxes, boxesVisible]
  );

  const commitRect = useCallback(
    (start: [number, number], end: [number, number]) => {
      const points = rectDragToQuad(start[0], start[1], end[0], end[1]);
      const { w, h } = quadBounds(points);
      if (w < minRectPx || h < minRectPx) return;
      const box: OcrBoxPixel = {
        id: newOcrBoxId(),
        text: '###',
        points,
        auto: false,
      };
      onBoxesChange([...boxesRef.current, box], { recordHistory: true });
      onSelectedBoxIdChange(box.id);
      onNewBox?.(box);
    },
    [minRectPx, onBoxesChange, onNewBox, onSelectedBoxIdChange]
  );

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((s) => Math.min(12, Math.max(0.15, s * delta)));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const onPointerDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-no-draw]')) return;
      if (readOnly || !imgRef.current || nw <= 0) return;
      const p = clientToNatural(e.clientX, e.clientY, imgRef.current, nw, nh);

      if (e.button === 1 || (e.button === 0 && (isSpaceHeldRef.current || e.shiftKey))) {
        e.preventDefault();
        setIsPanning(true);
        setLastPanPos({ x: e.clientX, y: e.clientY });
        return;
      }

      if (e.button !== 0) return;

      if (activeTool === 'drawRect') {
        setRectDrag({ start: p, end: p });
        return;
      }

      const vh = findVertexHit(e.clientX, e.clientY);
      if (vh) {
        pushHistoryRef?.current?.();
        dragRef.current = { kind: 'vertex', boxId: vh.boxId, vi: vh.vi };
        onSelectedBoxIdChange(vh.boxId);
        e.preventDefault();
        return;
      }

      const hitId = findBoxHit(p);
      onSelectedBoxIdChange(hitId);
      if (hitId) {
        const box = boxes.find((b) => b.id === hitId);
        if (box) {
          pushHistoryRef?.current?.();
          dragRef.current = {
            kind: 'body',
            boxId: hitId,
            origin: p,
            pts0: box.points.map((pt) => [pt[0], pt[1]] as [number, number]),
          };
          e.preventDefault();
        }
      }
    },
    [activeTool, boxes, findBoxHit, findVertexHit, nw, nh, onSelectedBoxIdChange, pushHistoryRef, readOnly]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if (e.key === ']' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShowFloatingUi((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (isPanning && lastPanPos) {
        const dx = e.clientX - lastPanPos.x;
        const dy = e.clientY - lastPanPos.y;
        setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
        setLastPanPos({ x: e.clientX, y: e.clientY });
        return;
      }

      if (rectDrag && imgRef.current && nw > 0) {
        const p = clientToNatural(e.clientX, e.clientY, imgRef.current, nw, nh);
        setRectDrag((d) => (d ? { ...d, end: p } : null));
        return;
      }

      const d = dragRef.current;
      if (!d || !imgRef.current || nw <= 0) return;
      const p = clientToNatural(e.clientX, e.clientY, imgRef.current, nw, nh);
      const cur = boxesRef.current;

      if (d.kind === 'vertex') {
        onBoxesChange(
          cur.map((b) => {
            if (b.id !== d.boxId) return b;
            const pts = b.points.map((pt, i) =>
              i === d.vi ? ([Math.min(nw, Math.max(0, p[0])), Math.min(nh, Math.max(0, p[1]))] as [number, number]) : pt
            );
            return { ...b, points: pts };
          }),
          { recordHistory: false }
        );
        return;
      }

      const dx = p[0] - d.origin[0];
      const dy = p[1] - d.origin[1];
      const newPts = d.pts0.map(
        ([x, y]) =>
          [Math.min(nw, Math.max(0, x + dx)), Math.min(nh, Math.max(0, y + dy))] as [number, number]
      );
      onBoxesChange(cur.map((b) => (b.id === d.boxId ? { ...b, points: newPts } : b)), { recordHistory: false });
    };

    const onUp = () => {
      if (rectDrag) {
        commitRect(rectDrag.start, rectDrag.end);
        setRectDrag(null);
      }
      if (isPanning) {
        setIsPanning(false);
        setLastPanPos(null);
      }
      dragRef.current = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [commitRect, isPanning, lastPanPos, nw, nh, onBoxesChange, rectDrag]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        isSpaceHeldRef.current = e.type === 'keydown';
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedBoxId) return;
        e.preventDefault();
        onBoxesChange(boxesRef.current.filter((b) => b.id !== selectedBoxId), { recordHistory: true });
        onSelectedBoxIdChange(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [onBoxesChange, onSelectedBoxIdChange, selectedBoxId]);

  const previewQuad = rectDrag ? rectDragToQuad(rectDrag.start[0], rectDrag.start[1], rectDrag.end[0], rectDrag.end[1]) : null;
  const u = useCallback((px: number) => px / scale, [scale]);
  /** 화면 기준 px — 줌·이미지 해상도와 무관하게 동일하게 보이도록 scale 보정 */
  const labelFontSize = u(Math.max(6, boxLabelFontPx));
  const labelOffsetY = u(4);
  const vertexR = pointSizePx;
  const vertexRSelected = pointSizePx + 1;
  const lineW = boxLineWidthPx;
  const lineWSelected = boxLineWidthPx + 0.5;
  const labelPadTop = Math.max(labelFontSize + labelOffsetY + u(4), u(12));

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-hidden bg-[#0a0f1a] relative select-none"
      onMouseDown={onPointerDown}
      style={{ cursor: activeTool === 'drawRect' ? 'crosshair' : isPanning ? 'grabbing' : 'default' }}
    >
      <div
        className="absolute left-1/2 top-1/2 origin-center overflow-visible"
        style={{ transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${scale})` }}
      >
        <div className="relative inline-block overflow-visible">
          <img
            ref={imgRef}
            src={displayUrl}
            alt=""
            draggable={false}
            className="block max-w-none"
            style={{ width: nw > 0 ? nw : undefined, height: nh > 0 ? nh : undefined }}
            onLoad={handleImgLoad}
          />
          {nw > 0 && nh > 0 && (
            <>
              <svg
                className="absolute inset-0 pointer-events-none"
                width={nw}
                height={nh}
                viewBox={`0 0 ${nw} ${nh}`}
              >
                {boxesVisible &&
                  boxes.map((box) => {
                    const selected = box.id === selectedBoxId;
                    const pts = box.points.map((p) => `${p[0]},${p[1]}`).join(' ');
                    return (
                      <g key={box.id}>
                        <polygon
                          points={pts}
                          fill={selected ? `${strokeColor}33` : `${strokeColor}18`}
                          stroke={selected ? '#fbbf24' : strokeColor}
                          strokeWidth={u(selected ? lineWSelected : lineW)}
                        />
                        {box.points.map((p, vi) => (
                          <circle
                            key={vi}
                            cx={p[0]}
                            cy={p[1]}
                            r={u(selected ? vertexRSelected : vertexR)}
                            fill={selected ? '#fbbf24' : strokeColor}
                            stroke="#0f172a"
                            strokeWidth={u(1.5)}
                          />
                        ))}
                      </g>
                    );
                  })}
                {previewQuad && (
                  <polygon
                    points={previewQuad.map((p) => `${p[0]},${p[1]}`).join(' ')}
                    fill={`${strokeColor}22`}
                    stroke={strokeColor}
                    strokeWidth={u(lineW)}
                    strokeDasharray={`${u(6)} ${u(4)}`}
                  />
                )}
              </svg>
              {showBoxLabels && (
                <svg
                  className="absolute left-0 pointer-events-none"
                  style={{ top: -labelPadTop, overflow: 'visible' }}
                  width={nw}
                  height={nh + labelPadTop}
                  viewBox={`0 ${-labelPadTop} ${nw} ${nh + labelPadTop}`}
                  overflow="visible"
                >
                  {boxesVisible &&
                    boxes.map((box) => {
                      if (!box.text || box.text === '###') return null;
                      const anchor = box.points[0]!;
                      return (
                        <text
                          key={`label-${box.id}`}
                          x={anchor[0]}
                          y={anchor[1] - labelOffsetY}
                          dominantBaseline="alphabetic"
                          fill="#000000"
                          stroke="#ffffff"
                          strokeWidth={u(0.5)}
                          paintOrder="stroke"
                          fontSize={labelFontSize}
                          fontFamily="monospace"
                          fontWeight="bold"
                        >
                          {box.text}
                        </text>
                      );
                    })}
                </svg>
              )}
            </>
          )}
        </div>
      </div>

      <div className="absolute bottom-3 right-3 z-40 pointer-events-none select-none text-[11px] font-mono text-slate-500 bg-slate-900/70 px-2 py-1 rounded-lg border border-white/10">
        {Math.round(scale * 100)}%
      </div>

      {!showFloatingUi && (
        <div data-no-draw className="absolute top-4 left-4 z-50">
          <Tooltip text="도구 패널 표시 (])">
            <button
              type="button"
              onClick={() => setShowFloatingUi(true)}
              className="p-3 rounded-xl shadow-2xl backdrop-blur-md border border-white/10 bg-slate-900/80 text-slate-200 hover:bg-slate-800 hover:text-white transition-all"
              aria-label="도구 패널 표시"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </Tooltip>
        </div>
      )}

      {showFloatingUi && (
        <div data-no-draw className="absolute top-4 left-4 flex flex-col gap-2 z-50">
          <Tooltip text="도구 패널 숨기기 (])">
            <button
              type="button"
              onClick={() => setShowFloatingUi(false)}
              className="p-2.5 rounded-xl shadow-2xl backdrop-blur-md border border-white/10 bg-slate-800/70 text-slate-400 hover:text-white hover:bg-slate-700/90 transition-all"
              aria-label="도구 패널 숨기기"
            >
              <svg className="w-4 h-4 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          </Tooltip>

          <Tooltip text="박스 텍스트 표시">
            <button
              type="button"
              onClick={() => onShowBoxLabelsChange?.(!showBoxLabels)}
              className={`p-3 rounded-xl shadow-2xl backdrop-blur-md border transition-all ${
                showBoxLabels
                  ? 'bg-cyan-600/90 text-white border-cyan-500/50'
                  : 'bg-slate-900/60 text-slate-300 border-white/10 hover:bg-slate-800/80 hover:text-white'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
            </button>
          </Tooltip>

          <Tooltip text="박스 표시 켜기/끄기">
            <button
              type="button"
              onClick={() => setBoxesVisible((v) => !v)}
              className={`p-3 rounded-xl shadow-2xl backdrop-blur-md border transition-all ${
                boxesVisible
                  ? 'bg-slate-900/60 text-slate-300 border-white/10 hover:bg-slate-800/80 hover:text-white'
                  : 'bg-cyan-600/90 text-white border-cyan-500/50'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
          </Tooltip>

          <div className="h-px bg-white/10 w-8 mx-auto my-0.5 rounded-full" />

          <Tooltip text={autoFixedDisplay ? '고정 표시 크기로 초기화' : '확대/이동 초기화'}>
            <button
              type="button"
              onClick={resetView}
              className="p-3 bg-slate-900/60 text-slate-300 rounded-xl shadow-2xl backdrop-blur-md border border-white/10 hover:bg-slate-800/80 hover:text-white transition-all"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            </button>
          </Tooltip>

          <Tooltip text="표시·꼭짓점 설정">
            <button
              type="button"
              onClick={() => setIsSettingsOpen((v) => !v)}
              className={`p-3 rounded-xl shadow-2xl backdrop-blur-md border transition-all ${
                isSettingsOpen
                  ? 'bg-cyan-600/90 text-white border-cyan-500/50'
                  : 'bg-slate-900/60 text-slate-300 border-white/10 hover:bg-slate-800/80 hover:text-white'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </Tooltip>

          {!readOnly && (
            <Tooltip text="모든 박스 삭제">
              <button
                type="button"
                onClick={() => setIsDeleteAllConfirmOpen(true)}
                disabled={boxes.length === 0}
                className="p-3 bg-slate-900/60 text-red-400 rounded-xl shadow-2xl backdrop-blur-md border border-white/10 hover:bg-red-500 hover:text-white hover:border-red-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-900/60 disabled:hover:text-red-400"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </Tooltip>
          )}

          {onOpenShortcuts && (
            <Tooltip text="단축키 안내">
              <button
                type="button"
                onClick={onOpenShortcuts}
                className="p-3 bg-slate-900/60 text-slate-300 rounded-xl shadow-2xl backdrop-blur-md border border-white/10 hover:bg-slate-800/80 hover:text-white transition-all font-bold font-mono"
              >
                ?
              </button>
            </Tooltip>
          )}
        </div>
      )}

      {isSettingsOpen && (
        <div
          data-no-draw
          className="absolute bottom-4 left-20 w-[300px] bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl p-5 z-50"
        >
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-white font-bold text-sm">캔버스 표시 설정</h3>
            <button type="button" onClick={() => setIsSettingsOpen(false)} className="p-1 rounded-lg text-slate-500 hover:text-white hover:bg-white/10">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="space-y-4">
            <div className="space-y-2 pb-1 border-b border-white/10">
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoFixedDisplay}
                  onChange={(e) => setAutoFixedDisplay(e.target.checked)}
                  className="rounded border-gray-600 accent-cyan-500"
                />
                작업 전환 시 고정 표시 크기
              </label>
              <p className="text-[11px] text-slate-500 leading-relaxed pl-6">
                이미지를 넘길 때마다 아래 너비(px)로 화면에 맞춥니다.
              </p>
              {autoFixedDisplay && (
                <div className="space-y-2 pl-6">
                  <div className="flex justify-between items-center">
                    <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">표시 너비</label>
                    <span className="text-cyan-400 font-mono text-xs px-1.5 py-0.5 bg-cyan-400/10 rounded">
                      {fixedDisplayWidthPx}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={320}
                    max={3840}
                    step={10}
                    value={fixedDisplayWidthPx}
                    onChange={(e) => setFixedDisplayWidthPx(Number(e.target.value))}
                    className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                  />
                </div>
              )}
            </div>
            {onMinRectPxChange && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">최소 박스</label>
                  <span className="text-cyan-400 font-mono text-xs px-1.5 py-0.5 bg-cyan-400/10 rounded">{minRectPx}px</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={128}
                  value={minRectPx}
                  onChange={(e) => onMinRectPxChange(Number(e.target.value))}
                  className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                />
              </div>
            )}
            {onBoxLabelFontPxChange && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">텍스트 크기</label>
                  <span className="text-cyan-400 font-mono text-xs px-1.5 py-0.5 bg-cyan-400/10 rounded">{boxLabelFontPx}px</span>
                </div>
                <input
                  type="range"
                  min={8}
                  max={96}
                  value={boxLabelFontPx}
                  onChange={(e) => onBoxLabelFontPxChange(Number(e.target.value))}
                  className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                />
              </div>
            )}
            {onPointSizePxChange && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">꼭짓점 크기</label>
                  <span className="text-cyan-400 font-mono text-xs px-1.5 py-0.5 bg-cyan-400/10 rounded">{pointSizePx}px</span>
                </div>
                <input
                  type="range"
                  min={3}
                  max={16}
                  value={pointSizePx}
                  onChange={(e) => onPointSizePxChange(Number(e.target.value))}
                  className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                />
              </div>
            )}
            {onBoxLineWidthPxChange && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">선 두께 (화면)</label>
                  <span className="text-cyan-400 font-mono text-xs px-1.5 py-0.5 bg-cyan-400/10 rounded">{boxLineWidthPx}px</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={boxLineWidthPx}
                  onChange={(e) => onBoxLineWidthPxChange(Number(e.target.value))}
                  className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                />
              </div>
            )}
            {onFocusTextOnNewBoxChange && (
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none pt-1">
                <input
                  type="checkbox"
                  checked={focusTextOnNewBox}
                  onChange={(e) => onFocusTextOnNewBoxChange(e.target.checked)}
                  className="rounded border-gray-600 accent-cyan-500"
                />
                박스 생성 후 텍스트 입력 포커스 (선택 모드로 전환)
              </label>
            )}
          </div>
        </div>
      )}

      {isDeleteAllConfirmOpen && (
        <div
          data-no-draw
          className="absolute inset-0 z-[100] bg-slate-950/80 backdrop-blur-xl flex items-center justify-center p-4"
          onClick={() => setIsDeleteAllConfirmOpen(false)}
        >
          <div
            className="bg-slate-900 border border-white/10 rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 text-center">
              <div className="w-16 h-16 bg-red-900/20 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-500/20">
                <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-white mb-2">모든 박스 삭제</h3>
              <p className="text-slate-400 text-sm leading-relaxed mb-6">
                현재 이미지의 <strong className="text-white">모든 OCR 박스</strong>를 삭제할까요?
                <span className="block text-red-400/90 text-xs mt-2">Ctrl+Z로 되돌릴 수 있습니다.</span>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setIsDeleteAllConfirmOpen(false)}
                  className="py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-xl border border-slate-700"
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={handleDeleteAll}
                  className="py-2.5 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl"
                >
                  모두 삭제
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-3 left-3 text-[10px] text-slate-500 font-mono pointer-events-none">
        {activeTool === 'drawRect' ? 'F: 사각 영역 드래그' : '선택 · R 삭제 · 꼭짓점 드래그'} · 휠 확대 · Space+드래그 이동
      </div>
    </div>
  );
};

export default OcrQuadCanvas;
