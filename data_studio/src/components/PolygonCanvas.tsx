import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PolygonShapePixel } from '../polygonTypes';

type Tool = 'draw' | 'select';

type ShapesChangeOptions = { recordHistory?: boolean };

type ViewTool = 'EDIT' | 'PAN';

const FLOATING_UI_LS = 'polygonLocalFloatingUiVisible';
const POLYGON_VIS_LS = 'polygonLocalCanvasVisualSettingsV1';

type PolygonVisualSettings = {
  lineThickness: number;
  pointSize: number;
  fillOpacity: number;
  showLabels: boolean;
};

function loadPolygonVisualSettings(): Partial<PolygonVisualSettings> {
  try {
    const raw = localStorage.getItem(POLYGON_VIS_LS);
    if (!raw) return {};
    const o = JSON.parse(raw) as Partial<PolygonVisualSettings>;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

const Tooltip = ({ text, children }: { text: string; children: React.ReactNode }) => (
  <div className="group relative flex items-center">
    <div className="absolute left-full ml-4 px-3 py-2 bg-slate-900/95 backdrop-blur-xl border border-white/10 text-white text-[12px] font-bold tracking-wide rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.5)] whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0 transition-all duration-300 z-[100]">
      {text}
    </div>
    {children}
  </div>
);

interface PolygonCanvasProps {
  imageUrl: string;
  shapes: PolygonShapePixel[];
  onShapesChange: (next: PolygonShapePixel[], options?: ShapesChangeOptions) => void;
  pushHistoryRef?: React.MutableRefObject<(() => void) | null>;
  activeTool: Tool;
  activeLabel: string;
  colorForLabel: (label: string) => string;
  selectedShapeIds: string[];
  onSelectedShapeIdsChange: (ids: string[]) => void;
  onNaturalSize?: (w: number, h: number) => void;
  readOnly?: boolean;
  /** false면 기존 폴리곤 렌더·히트 테스트 비활성 (그리기 초안은 유지) */
  shapesVisible?: boolean;
  /** true면 Esc로 그리기 초안을 비우지 않음(예: 상위 모달 열림) */
  suppressEscapeClear?: boolean;
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

function dist2(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
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

/** 화면상 꼭짓점 핸들(pointSize)과 비슷한 클릭 반경 */
function vertexScreenHitRadiusPx(pointSize: number): number {
  return Math.max(6, Math.min(11, pointSize + 2));
}

function findClosestVertexHit(
  clientX: number,
  clientY: number,
  img: HTMLImageElement,
  shapes: PolygonShapePixel[],
  nw: number,
  nh: number,
  radiusPx: number,
  preferredShapeIds: ReadonlySet<string> | null = null
): { shapeId: string; vi: number } | null {
  const maxDistSq = radiusPx * radiusPx;
  let best: { shapeId: string; vi: number; distSq: number; shapeIndex: number } | null = null;

  for (let s = shapes.length - 1; s >= 0; s--) {
    const sh = shapes[s]!;
    for (let vi = 0; vi < sh.points.length; vi++) {
      const distSq = clientDistSqToNaturalPoint(clientX, clientY, img, sh.points[vi]!, nw, nh);
      if (distSq > maxDistSq) continue;

      const curPreferred = preferredShapeIds?.has(sh.id) ?? false;
      const bestPreferred = best != null && (preferredShapeIds?.has(best.shapeId) ?? false);
      const isCloser = best == null || distSq < best.distSq - 0.25;
      const isSameDist = best != null && Math.abs(distSq - best.distSq) <= 0.25;
      const winsTie =
        isSameDist &&
        best != null &&
        ((curPreferred && !bestPreferred) || (curPreferred === bestPreferred && s > best.shapeIndex));

      if (isCloser || winsTie) {
        best = { shapeId: sh.id, vi, distSq, shapeIndex: s };
      }
    }
  }

  return best ? { shapeId: best.shapeId, vi: best.vi } : null;
}

function shouldCloseDraftAt(
  clientX: number,
  clientY: number,
  img: HTMLImageElement,
  p: [number, number],
  draft: [number, number][],
  nw: number,
  nh: number
): boolean {
  if (draft.length < 3) return false;
  const thr = hitThreshold(nw, nh);
  if (dist2(p, draft[0]!) <= thr) return true;
  const screenThr = 20;
  if (clientDistSqToNaturalPoint(clientX, clientY, img, draft[0]!, nw, nh) <= screenThr * screenThr) {
    return true;
  }
  return false;
}

function hitThreshold(nw: number, nh: number): number {
  const t = Math.max(8, Math.min(nw, nh) * 0.02);
  return t * t;
}

function distPointToSegmentSq(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): { distSq: number; point: [number, number]; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    return { distSq: dist2(p, a), point: a, t: 0 };
  }
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const point: [number, number] = [a[0] + t * dx, a[1] + t * dy];
  const ddx = p[0] - point[0];
  const ddy = p[1] - point[1];
  return { distSq: ddx * ddx + ddy * ddy, point, t };
}

function naturalPointToScreen(
  pt: [number, number],
  img: HTMLImageElement,
  nw: number,
  nh: number
): [number, number] {
  const rect = img.getBoundingClientRect();
  return [rect.left + (pt[0] / nw) * rect.width, rect.top + (pt[1] / nh) * rect.height];
}

function screenDistSq(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/** 변(E) 삽입: 커서↔변 거리·끝점 여백을 화면 픽셀 기준으로 판정 */
const EDGE_INSERT_MAX_DIST_PX = 12;
const EDGE_INSERT_MIN_END_PX = 4;

function findEdgeInsertAt(
  cursor: [number, number],
  img: HTMLImageElement,
  points: [number, number][],
  nw: number,
  nh: number,
  maxEdgeDistPx = EDGE_INSERT_MAX_DIST_PX,
  minEndpointDistPx = EDGE_INSERT_MIN_END_PX
): { insertAfterIndex: number; point: [number, number] } | null {
  if (points.length < 2) return null;
  const cursorScr = naturalPointToScreen(cursor, img, nw, nh);
  const maxEdgeDistSq = maxEdgeDistPx * maxEdgeDistPx;
  const minEndSq = minEndpointDistPx * minEndpointDistPx;
  let bestDistSq = Infinity;
  let bestInsertAfter = -1;
  let bestPoint: [number, number] | null = null;

  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const { point, t } = distPointToSegmentSq(cursor, a, b);
    const pointScr = naturalPointToScreen(point, img, nw, nh);
    const edgeDistSq = screenDistSq(cursorScr, pointScr);
    if (edgeDistSq > maxEdgeDistSq) continue;

    const aScr = naturalPointToScreen(a, img, nw, nh);
    const bScr = naturalPointToScreen(b, img, nw, nh);
    const segLenPx = Math.sqrt(screenDistSq(aScr, bScr));
    if (segLenPx < 2 * minEndpointDistPx) {
      if (t < 0.15 || t > 0.85) continue;
    } else {
      if (screenDistSq(pointScr, aScr) < minEndSq || screenDistSq(pointScr, bScr) < minEndSq) continue;
    }

    if (edgeDistSq < bestDistSq) {
      bestDistSq = edgeDistSq;
      bestInsertAfter = i;
      bestPoint = point;
    }
  }

  if (bestInsertAfter < 0 || !bestPoint) return null;
  return { insertAfterIndex: bestInsertAfter, point: bestPoint };
}

function polygonCentroid(points: [number, number][]): [number, number] {
  if (points.length === 0) return [0, 0];
  let sx = 0;
  let sy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
  }
  return [sx / points.length, sy / points.length];
}

function applyShapeClickSelection(current: string[], shapeId: string, shiftKey: boolean): string[] {
  if (shiftKey) {
    return current.includes(shapeId) ? current.filter((id) => id !== shapeId) : [...current, shapeId];
  }
  return [shapeId];
}

type DragState =
  | { kind: 'vertex'; shapeId: string; vi: number }
  | { kind: 'body'; shapeId: string; origin: [number, number]; pts0: [number, number][] };

const PolygonCanvas: React.FC<PolygonCanvasProps> = ({
  imageUrl,
  shapes,
  onShapesChange,
  activeTool,
  activeLabel,
  colorForLabel,
  selectedShapeIds,
  onSelectedShapeIdsChange,
  pushHistoryRef,
  onNaturalSize,
  readOnly = false,
  shapesVisible = true,
  suppressEscapeClear = false,
}) => {
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [nw, setNw] = useState(0);
  const [nh, setNh] = useState(0);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [hoverPt, setHoverPt] = useState<[number, number] | null>(null);
  const hoverPtRef = useRef<[number, number] | null>(null);
  hoverPtRef.current = hoverPt;
  const dragRef = useRef<DragState | null>(null);
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const activeLabelRef = useRef(activeLabel);
  activeLabelRef.current = activeLabel;
  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;
  const selectedShapeIdsRef = useRef(selectedShapeIds);
  selectedShapeIdsRef.current = selectedShapeIds;
  const selectedShapeIdSet = useMemo(() => new Set(selectedShapeIds), [selectedShapeIds]);
  const preferredShapeIdSet = useMemo(
    () => (selectedShapeIdSet.size > 0 ? selectedShapeIdSet : null),
    [selectedShapeIdSet]
  );
  const suppressEscapeRef = useRef(suppressEscapeClear);
  suppressEscapeRef.current = suppressEscapeClear;

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState<{ x: number; y: number } | null>(null);
  const [viewTool, setViewTool] = useState<ViewTool>('EDIT');
  const savedVis = loadPolygonVisualSettings();
  const [showLabels, setShowLabels] = useState(savedVis.showLabels !== false);
  const [showFloatingUi, setShowFloatingUi] = useState(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(FLOATING_UI_LS) === '0' ? false : true
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [lineThickness, setLineThickness] = useState(savedVis.lineThickness ?? 2);
  const [pointSize, setPointSize] = useState(savedVis.pointSize ?? 6);
  const [fillOpacity, setFillOpacity] = useState(savedVis.fillOpacity ?? 20);
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);
  const isSpacePressedRef = useRef(false);
  const isPanningRef = useRef(false);
  const lastPanPosRef = useRef<{ x: number; y: number } | null>(null);
  const viewToolRef = useRef(viewTool);
  viewToolRef.current = viewTool;

  useEffect(() => {
    try {
      localStorage.setItem(FLOATING_UI_LS, showFloatingUi ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [showFloatingUi]);

  useEffect(() => {
    try {
      const payload: PolygonVisualSettings = { lineThickness, pointSize, fillOpacity, showLabels };
      localStorage.setItem(POLYGON_VIS_LS, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }, [lineThickness, pointSize, fillOpacity, showLabels]);

  const resetDraft = useCallback(() => setDraft([]), []);

  useEffect(() => {
    resetDraft();
    setHoverPt(null);
    onSelectedShapeIdsChange([]);
    setNw(0);
    setNh(0);
    setIsPanning(false);
    setLastPanPos(null);
    isPanningRef.current = false;
    lastPanPosRef.current = null;
  }, [imageUrl, resetDraft, onSelectedShapeIdsChange]);

  const handleImgLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      setNw(w);
      setNh(h);
      onNaturalSize?.(w, h);
    },
    [onNaturalSize]
  );

  const findVertexHit = useCallback(
    (clientX: number, clientY: number): { shapeId: string; vi: number } | null => {
      if (!shapesVisible) return null;
      const img = imgRef.current;
      if (!img || nw <= 0 || nh <= 0) return null;
      return findClosestVertexHit(
        clientX,
        clientY,
        img,
        shapes,
        nw,
        nh,
        vertexScreenHitRadiusPx(pointSize),
        preferredShapeIdSet
      );
    },
    [shapes, nw, nh, pointSize, preferredShapeIdSet, shapesVisible]
  );

  const findPolygonHit = useCallback(
    (p: [number, number]): string | null => {
      if (!shapesVisible) return null;
      for (let s = shapes.length - 1; s >= 0; s--) {
        const sh = shapes[s];
        if (sh.points.length >= 3 && pointInPolygon(p[0], p[1], sh.points)) return sh.id;
      }
      return null;
    },
    [shapes, shapesVisible]
  );

  const commitDraftPoints = useCallback(
    (pts: [number, number][]) => {
      if (pts.length < 3) return;
      const next: PolygonShapePixel = {
        id: crypto.randomUUID(),
        label: activeLabelRef.current,
        points: pts.map(([x, y]) => [x, y] as [number, number]),
      };
      onShapesChange([...shapesRef.current, next], { recordHistory: true });
      setDraft([]);
      setHoverPt(null);
    },
    [onShapesChange]
  );

  const commitDraftPolygon = useCallback(() => {
    commitDraftPoints(draftRef.current);
  }, [commitDraftPoints]);

  const finishDraftWithHover = useCallback(() => {
    const pts = draftRef.current;
    const hp = hoverPtRef.current;
    if (hp && pts.length >= 2) {
      commitDraftPoints([...pts, hp]);
      return true;
    }
    if (pts.length >= 3) {
      commitDraftPoints(pts);
      return true;
    }
    return false;
  }, [commitDraftPoints]);

  const addPointOnSelectedEdge = useCallback(() => {
    const ids = selectedShapeIdsRef.current;
    const sid = ids.length === 1 ? ids[0] : null;
    const cursor = hoverPtRef.current;
    const img = imgRef.current;
    if (!sid || !cursor || !img || activeToolRef.current !== 'select' || nw <= 0 || nh <= 0) return false;
    const sh = shapesRef.current.find((s) => s.id === sid);
    if (!sh || sh.points.length < 2) return false;
    const hit = findEdgeInsertAt(cursor, img, sh.points, nw, nh);
    if (!hit) return false;
    const newPts = [
      ...sh.points.slice(0, hit.insertAfterIndex + 1),
      hit.point,
      ...sh.points.slice(hit.insertAfterIndex + 1),
    ];
    onShapesChange(
      shapesRef.current.map((s) => (s.id === sid ? { ...s, points: newPts } : s)),
      { recordHistory: true }
    );
    return true;
  }, [onShapesChange, nw, nh]);

  const startPan = useCallback((clientX: number, clientY: number) => {
    isPanningRef.current = true;
    lastPanPosRef.current = { x: clientX, y: clientY };
    setIsPanning(true);
    setLastPanPos({ x: clientX, y: clientY });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const ZOOM_SPEED = 0.001;
    const delta = -e.deltaY * ZOOM_SPEED;
    setScale((s) => Math.min(Math.max(0.1, s + delta), 10));
  }, []);

  const onPointerDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-no-draw]')) return;

      if (readOnly || nw <= 0 || !imgRef.current) return;
      const p = clientToNatural(e.clientX, e.clientY, imgRef.current, nw, nh);

      const isExplicitPan =
        viewToolRef.current === 'PAN' || e.button === 1 || (e.button === 0 && isSpacePressedRef.current);
      if (isExplicitPan && e.button !== 2) {
        e.preventDefault();
        startPan(e.clientX, e.clientY);
        return;
      }

      if (e.button === 2 && viewToolRef.current !== 'PAN') {
        e.preventDefault();
        if (activeTool === 'draw') {
          if (draftRef.current.length > 0) {
            setDraft((d) => d.slice(0, -1));
          }
          return;
        }
        if (activeTool === 'select') {
        const vh = findVertexHit(e.clientX, e.clientY);
        if (vh) {
          e.stopPropagation();
          const cur = shapesRef.current;
          const next: PolygonShapePixel[] = [];
          for (const sh of cur) {
            if (sh.id !== vh.shapeId) {
              next.push(sh);
              continue;
            }
            const newPts = sh.points.filter((_, i) => i !== vh.vi);
            if (newPts.length >= 3) next.push({ ...sh, points: newPts });
          }
          onShapesChange(next, { recordHistory: true });
          onSelectedShapeIdsChange(
            selectedShapeIdsRef.current.filter(
              (id) => id !== vh.shapeId || next.some((s) => s.id === vh.shapeId)
            )
          );
        }
        }
        return;
      }

      if (e.button !== 0) return;

      if (e.shiftKey && viewToolRef.current !== 'PAN') {
        const vh = findVertexHit(e.clientX, e.clientY);
        const pid = findPolygonHit(p);
        if (!vh && !pid) {
          e.preventDefault();
          startPan(e.clientX, e.clientY);
          return;
        }
      }

      if (viewToolRef.current === 'PAN') return;

      if (activeTool === 'draw') {
        if (draft.length >= 3 && shouldCloseDraftAt(e.clientX, e.clientY, imgRef.current, p, draft, nw, nh)) {
          commitDraftPolygon();
          return;
        }
        setDraft((d) => [...d, p]);
        return;
      }

      if (activeTool === 'select') {
        const vh = findVertexHit(e.clientX, e.clientY);
        if (vh) {
          onSelectedShapeIdsChange(
            e.shiftKey
              ? applyShapeClickSelection(selectedShapeIdsRef.current, vh.shapeId, true)
              : [vh.shapeId]
          );
          pushHistoryRef?.current?.();
          dragRef.current = { kind: 'vertex', shapeId: vh.shapeId, vi: vh.vi };
          e.preventDefault();
          return;
        }
        const pid = findPolygonHit(p);
        if (!pid) {
          if (!e.shiftKey) onSelectedShapeIdsChange([]);
          return;
        }
        if (e.shiftKey) {
          onSelectedShapeIdsChange(applyShapeClickSelection(selectedShapeIdsRef.current, pid, true));
          e.preventDefault();
          return;
        }
        onSelectedShapeIdsChange([pid]);
        const sh = shapes.find((s) => s.id === pid);
        if (sh && sh.points.length > 0) {
          pushHistoryRef?.current?.();
          const pts0 = sh.points.map(([x, y]) => [x, y] as [number, number]);
          dragRef.current = { kind: 'body', shapeId: pid, origin: p, pts0 };
          e.preventDefault();
        }
      }
    },
    [readOnly, nw, nh, activeTool, draft, shapes, findVertexHit, findPolygonHit, commitDraftPolygon, onShapesChange, onSelectedShapeIdsChange, pushHistoryRef, startPan]
  );

  const onPointerMove = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly || nw <= 0 || !imgRef.current || dragRef.current || isPanning) {
        if (!isPanning) setHoverPt(null);
        return;
      }
      if (viewToolRef.current === 'PAN') {
        setHoverPt(null);
        return;
      }
      const p = clientToNatural(e.clientX, e.clientY, imgRef.current, nw, nh);
      if (activeTool === 'draw' || (activeTool === 'select' && selectedShapeIds.length > 0)) {
        setHoverPt(p);
        return;
      }
      setHoverPt(null);
    },
    [readOnly, nw, nh, activeTool, selectedShapeIds.length, isPanning]
  );

  const onPointerLeave = useCallback(() => {
    setHoverPt(null);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (isPanningRef.current && lastPanPosRef.current) {
        const dx = e.clientX - lastPanPosRef.current.x;
        const dy = e.clientY - lastPanPosRef.current.y;
        setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
        lastPanPosRef.current = { x: e.clientX, y: e.clientY };
        setLastPanPos({ x: e.clientX, y: e.clientY });
        return;
      }
      const d = dragRef.current;
      if (!d || !imgRef.current || nw <= 0 || nh <= 0) return;
      const p = clientToNatural(e.clientX, e.clientY, imgRef.current, nw, nh);
      const cur = shapesRef.current;
      if (d.kind === 'vertex') {
        onShapesChange(
          cur.map((sh) => {
            if (sh.id !== d.shapeId) return sh;
            const pts = sh.points.map((pt, i) => (i === d.vi ? (p as [number, number]) : pt));
            return { ...sh, points: pts };
          }),
          { recordHistory: false }
        );
        return;
      }
      const dx = p[0] - d.origin[0];
      const dy = p[1] - d.origin[1];
      const newPts = d.pts0.map(([x, y]) => [
        Math.min(nw, Math.max(0, x + dx)),
        Math.min(nh, Math.max(0, y + dy)),
      ] as [number, number]);
      onShapesChange(
        cur.map((sh) => (sh.id === d.shapeId ? { ...sh, points: newPts } : sh)),
        { recordHistory: false }
      );
    };
    const onUp = () => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        lastPanPosRef.current = null;
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
  }, [onShapesChange, nw, nh]);

  useEffect(() => {
    const onSpaceDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      e.preventDefault();
      isSpacePressedRef.current = true;
      setIsSpaceHeld(true);
    };
    const onSpaceUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      isSpacePressedRef.current = false;
      setIsSpaceHeld(false);
    };
    window.addEventListener('keydown', onSpaceDown, true);
    window.addEventListener('keyup', onSpaceUp, true);
    return () => {
      window.removeEventListener('keydown', onSpaceDown, true);
      window.removeEventListener('keyup', onSpaceUp, true);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (readOnly) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      const keyLower = e.key.toLowerCase();
      if (e.key === 'Escape') {
        if (suppressEscapeRef.current) return;
        setDraft([]);
        setHoverPt(null);
        return;
      }
      if (e.key === ']' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShowFloatingUi((v) => !v);
        return;
      }
      if (keyLower === 'h' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setViewTool((v) => (v === 'PAN' ? 'EDIT' : 'PAN'));
        return;
      }
      if (e.key === 'Enter' && activeToolRef.current === 'draw') {
        if (finishDraftWithHover()) {
          e.preventDefault();
        }
        return;
      }
      if (keyLower === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey && activeToolRef.current === 'select') {
        if (selectedShapeIdsRef.current.length === 1 && addPointOnSelectedEdge()) {
          e.preventDefault();
        }
        return;
      }
      if (keyLower === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ids = selectedShapeIdsRef.current;
        if (ids.length > 0) {
          e.preventDefault();
          const drop = new Set(ids);
          onShapesChange(shapesRef.current.filter((s) => !drop.has(s.id)), { recordHistory: true });
          onSelectedShapeIdsChange([]);
        }
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [readOnly, onShapesChange, onSelectedShapeIdsChange, addPointOnSelectedEdge, finishDraftWithHover]);

  const draftFillColor = colorForLabel(activeLabel);
  const draftPreviewPoints: [number, number][] | null =
    draft.length >= 3
      ? hoverPt && activeTool === 'draw'
        ? [...draft, hoverPt]
        : draft
      : draft.length >= 2 && hoverPt && activeTool === 'draw'
        ? [...draft, hoverPt]
        : null;

  const edgeInsertPreview =
    shapesVisible &&
    activeTool === 'select' &&
    selectedShapeIds.length === 1 &&
    hoverPt &&
    nw > 0 &&
    viewTool !== 'PAN'
      ? (() => {
          const sh = shapes.find((s) => s.id === selectedShapeIds[0]);
          const img = imgRef.current;
          if (!sh || !img) return null;
          return findEdgeInsertAt(hoverPt, img, sh.points, nw, nh);
        })()
      : null;

  const u = useCallback((px: number) => px / scale, [scale]);
  const cursorStyle =
    viewTool === 'PAN' || isPanning || isSpaceHeld
      ? isPanning
        ? 'grabbing'
        : 'grab'
      : readOnly
        ? 'default'
        : activeTool === 'draw'
          ? 'crosshair'
          : 'default';

  const displayUrl = React.useMemo(() => {
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

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full overflow-hidden select-none outline-none bg-black"
      tabIndex={-1}
      onMouseDown={onPointerDown}
      onMouseMove={onPointerMove}
      onMouseLeave={onPointerLeave}
      onWheel={handleWheel}
      onContextMenu={(ev) => {
        if (!readOnly) ev.preventDefault();
      }}
      style={{ cursor: cursorStyle }}
    >
      {!showFloatingUi && (
        <div data-no-draw className="absolute top-4 left-4 z-50">
          <Tooltip text="도구 패널 표시 (])">
            <button
              type="button"
              onClick={() => setShowFloatingUi(true)}
              className="p-3 rounded-xl shadow-2xl backdrop-blur-md border border-white/10 bg-slate-900/80 text-slate-200 hover:bg-slate-800 hover:text-white transition-all duration-300"
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
          <Tooltip text={viewTool === 'PAN' ? '편집 모드 (H)' : '손 도구 · 스페이스로도 이동 (H)'}>
            <button
              type="button"
              onClick={() => setViewTool((v) => (v === 'PAN' ? 'EDIT' : 'PAN'))}
              className={`p-3 rounded-xl shadow-2xl backdrop-blur-md border transition-all ${
                viewTool === 'PAN'
                  ? 'bg-cyan-600/90 text-white border-cyan-500/50'
                  : 'bg-slate-900/60 text-slate-300 border-white/10 hover:bg-slate-800/80 hover:text-white'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip text="라벨 표시 켜기/끄기">
            <button
              type="button"
              onClick={() => setShowLabels((v) => !v)}
              className={`p-3 rounded-xl shadow-2xl backdrop-blur-md border transition-all ${
                showLabels
                  ? 'bg-cyan-600/90 text-white border-cyan-500/50'
                  : 'bg-slate-900/60 text-slate-300 border-white/10 hover:bg-slate-800/80 hover:text-white'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
            </button>
          </Tooltip>
          <div className="h-px bg-white/10 w-8 mx-auto my-0.5 rounded-full" />
          <Tooltip text="확대/이동 초기화">
            <button
              type="button"
              onClick={() => {
                setScale(1);
                setPan({ x: 0, y: 0 });
              }}
              className="p-3 bg-slate-900/60 text-slate-300 rounded-xl shadow-2xl backdrop-blur-md border border-white/10 hover:bg-slate-800/80 hover:text-white transition-all"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip text="선·점 크기 설정">
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
        </div>
      )}
      {isSettingsOpen && (
        <div
          data-no-draw
          className="absolute bottom-4 left-20 w-[300px] bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl p-5 z-50"
        >
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-white font-bold text-sm">캔버스 시각 설정</h3>
            <button type="button" onClick={() => setIsSettingsOpen(false)} className="p-1 rounded-lg text-slate-500 hover:text-white hover:bg-white/10">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">선 굵기</label>
                <span className="text-cyan-400 font-mono text-xs px-1.5 py-0.5 bg-cyan-400/10 rounded">{lineThickness}px</span>
              </div>
              <input type="range" min="1" max="10" value={lineThickness} onChange={(e) => setLineThickness(parseInt(e.target.value, 10))} className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500" />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">꼭짓점 크기</label>
                <span className="text-cyan-400 font-mono text-xs px-1.5 py-0.5 bg-cyan-400/10 rounded">{pointSize}px</span>
              </div>
              <input type="range" min="3" max="16" value={pointSize} onChange={(e) => setPointSize(parseInt(e.target.value, 10))} className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500" />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">채우기 투명도</label>
                <span className="text-cyan-400 font-mono text-xs px-1.5 py-0.5 bg-cyan-400/10 rounded">{fillOpacity}%</span>
              </div>
              <input type="range" min="0" max="80" value={fillOpacity} onChange={(e) => setFillOpacity(parseInt(e.target.value, 10))} className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-500" />
            </div>
          </div>
        </div>
      )}
      <div
        className="absolute bottom-3 right-3 z-40 pointer-events-none select-none text-[11px] font-mono text-slate-500 bg-slate-900/70 px-2 py-1 rounded-lg border border-white/10"
      >
        {Math.round(scale * 100)}%
      </div>
      <div
        className="relative origin-top-left w-fit h-fit"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transition: isPanning || dragRef.current ? 'none' : 'transform 0.075s ease-out',
        }}
      >
        <div className="relative inline-block">
      <img ref={imgRef} src={displayUrl} alt="" className="block max-h-[90vh] max-w-full pointer-events-none select-none shadow-2xl" draggable={false} onLoad={handleImgLoad} />
      {nw > 0 && nh > 0 && (
      <svg
        className="absolute left-0 top-0 w-full h-full pointer-events-none"
        viewBox={`0 0 ${nw} ${nh}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden
      >
        {shapesVisible &&
          shapes.map((sh) => {
          const pts = sh.points.map((x) => `${x[0]},${x[1]}`).join(' ');
          const stroke = colorForLabel(sh.label);
          const fill = stroke;
          const isSel = selectedShapeIdSet.has(sh.id);
          const [cx, cy] = polygonCentroid(sh.points);
          const labelFontSize = u(Math.max(12, Math.min(nw, nh) * 0.028));
          const showLabelBadge = showLabels && sh.points.length >= 3;
          return (
            <g key={sh.id}>
              <polygon
                points={pts}
                fill={fill}
                fillOpacity={isSel ? Math.min(0.95, fillOpacity / 100 + 0.15) : fillOpacity / 100}
                stroke={stroke}
                strokeWidth={u(isSel ? lineThickness + 1 : lineThickness)}
              />
              {showLabelBadge && (
                <g opacity={isSel ? 1 : 0.88}>
                  <rect
                    x={cx - sh.label.length * labelFontSize * 0.32}
                    y={cy - labelFontSize * 0.72}
                    width={sh.label.length * labelFontSize * 0.64 + u(12)}
                    height={labelFontSize * 1.35}
                    rx={labelFontSize * 0.25}
                    fill="rgba(15,23,42,0.88)"
                    stroke={stroke}
                    strokeWidth={u(1.5)}
                  />
                  <text
                    x={cx}
                    y={cy}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#f8fafc"
                    fontSize={labelFontSize}
                    fontWeight="700"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {sh.label}
                  </text>
                </g>
              )}
              {isSel &&
                sh.points.map((pt, i) => (
                  <circle key={i} cx={pt[0]} cy={pt[1]} r={u(pointSize)} fill="#fff" stroke={stroke} strokeWidth={u(1.5)} />
                ))}
              {isSel && edgeInsertPreview && selectedShapeIds.length === 1 && sh.id === selectedShapeIds[0] && (
                <circle
                  cx={edgeInsertPreview.point[0]}
                  cy={edgeInsertPreview.point[1]}
                  r={u(pointSize + 1)}
                  fill="#fff"
                  stroke="var(--accent-lime, #A8E61B)"
                  strokeWidth={u(2)}
                />
              )}
            </g>
          );
        })}
        {draft.length > 0 && (
          <g>
            {draftPreviewPoints && draftPreviewPoints.length >= 3 && (
              <polygon
                points={draftPreviewPoints.map((x) => `${x[0]},${x[1]}`).join(' ')}
                fill={draftFillColor}
                fillOpacity={fillOpacity / 100}
                stroke={draftFillColor}
                strokeWidth={u(lineThickness)}
              />
            )}
            <polyline
              points={draft.map((x) => `${x[0]},${x[1]}`).join(' ')}
              fill="none"
              stroke="var(--accent-lime, #A8E61B)"
              strokeWidth={u(lineThickness)}
            />
            {draft.length >= 3 && (
              <line
                x1={draft[draft.length - 1][0]}
                y1={draft[draft.length - 1][1]}
                x2={draft[0][0]}
                y2={draft[0][1]}
                stroke="var(--accent-lime, #A8E61B)"
                strokeWidth={u(lineThickness * 0.75)}
                strokeDasharray={`${u(4)} ${u(4)}`}
                strokeOpacity={0.55}
              />
            )}
            {hoverPt && activeTool === 'draw' && (
              <>
                <line
                  x1={draft[draft.length - 1][0]}
                  y1={draft[draft.length - 1][1]}
                  x2={hoverPt[0]}
                  y2={hoverPt[1]}
                  stroke="var(--accent-lime, #A8E61B)"
                  strokeWidth={u(lineThickness)}
                  strokeDasharray={`${u(6)} ${u(4)}`}
                  strokeOpacity={0.9}
                />
                {draft.length >= 2 && (
                  <line
                    x1={hoverPt[0]}
                    y1={hoverPt[1]}
                    x2={draft[0][0]}
                    y2={draft[0][1]}
                    stroke="var(--accent-lime, #A8E61B)"
                    strokeWidth={u(lineThickness * 0.75)}
                    strokeDasharray={`${u(4)} ${u(6)}`}
                    strokeOpacity={0.45}
                  />
                )}
                <circle
                  cx={hoverPt[0]}
                  cy={hoverPt[1]}
                  r={u(pointSize * 0.65)}
                  fill="var(--accent-lime, #A8E61B)"
                  fillOpacity={0.85}
                  stroke="#1a1a2e"
                  strokeWidth={u(1)}
                />
              </>
            )}
            {draft.map((pt, i) => (
              <circle key={i} cx={pt[0]} cy={pt[1]} r={u(pointSize * 0.85)} fill={i === 0 ? '#fff' : 'var(--accent-lime, #A8E61B)'} stroke="#1a1a2e" strokeWidth={u(1)} />
            ))}
          </g>
        )}
      </svg>
      )}
        </div>
      </div>
    </div>
  );
};

export default PolygonCanvas;
