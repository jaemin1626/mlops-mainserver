import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LandmarkBndbox, LandmarkObjectPixel, LandmarkPoint } from '../landmarkTypes';
import {
  bndboxFromCorners,
  createLandmarkObject,
} from '../landmarkFormat';
import LandmarkMagnifier from './LandmarkMagnifier';

type ShapesChangeOptions = { recordHistory?: boolean };

type ResizeHandle = 'tl' | 'tr' | 'br' | 'bl';

type DragState =
  | { kind: 'draw'; start: [number, number] }
  | { kind: 'point'; objectId: string; pointIndex: number }
  | { kind: 'body'; objectId: string; origin: [number, number]; pts0: LandmarkPoint[]; box0: LandmarkBndbox }
  | { kind: 'resize'; objectId: string; handle: ResizeHandle; box0: LandmarkBndbox };

interface LandmarkCanvasProps {
  imageUrl: string;
  objects: LandmarkObjectPixel[];
  onObjectsChange: (next: LandmarkObjectPixel[], options?: ShapesChangeOptions) => void;
  pushHistoryRef?: React.MutableRefObject<(() => void) | null>;
  activeLabel: string;
  colorForLabel: (label: string) => string;
  selectedObjectId: string | null;
  onSelectedObjectIdChange: (id: string | null) => void;
  selectedPointIndex: number | null;
  onSelectedPointIndexChange: (index: number | null) => void;
  onNaturalSize?: (w: number, h: number) => void;
  readOnly?: boolean;
  suppressEscapeClear?: boolean;
}

const MIN_BOX = 6;

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

function pointInBox(p: [number, number], box: LandmarkBndbox): boolean {
  return p[0] >= box.xmin && p[0] <= box.xmax && p[1] >= box.ymin && p[1] <= box.ymax;
}

function pointInRect(p: [number, number], x: number, y: number, w: number, h: number): boolean {
  return p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h;
}

const LABEL_SIZE_MIN = 34;
const LABEL_SIZE_MAX = 56;

function getLabelMetrics(obj: LandmarkObjectPixel): { lw: number; lh: number } {
  const bw = Math.max(1, obj.bndbox.xmax - obj.bndbox.xmin);
  const bh = Math.max(1, obj.bndbox.ymax - obj.bndbox.ymin);
  const boxMin = Math.min(bw, bh);
  const side = Math.max(LABEL_SIZE_MIN, Math.min(LABEL_SIZE_MAX, boxMin * 0.38));
  return { lw: side, lh: side };
}

type LabelAnchor = 'tl' | 'tr' | 'bl' | 'br';

function labelRectForPoint(
  pi: number,
  px: number,
  py: number,
  lw: number,
  lh: number
): { x: number; y: number; w: number; h: number; anchor: LabelAnchor } {
  switch (pi) {
    case 0:
      return { x: px - lw, y: py - lh, w: lw, h: lh, anchor: 'br' };
    case 1:
      return { x: px, y: py - lh, w: lw, h: lh, anchor: 'bl' };
    case 2:
      return { x: px, y: py, w: lw, h: lh, anchor: 'tl' };
    default:
      return { x: px - lw, y: py, w: lw, h: lh, anchor: 'tr' };
  }
}

function anchorCorner(rect: { x: number; y: number; w: number; h: number }, anchor: LabelAnchor): [number, number] {
  switch (anchor) {
    case 'tl':
      return [rect.x, rect.y];
    case 'tr':
      return [rect.x + rect.w, rect.y];
    case 'bl':
      return [rect.x, rect.y + rect.h];
    case 'br':
      return [rect.x + rect.w, rect.y + rect.h];
  }
}

function labelInnerPad(side: number): number {
  return Math.max(4, side * 0.17);
}

type LabelContentLayout = {
  textX: number;
  textY: number;
  arrow: { x1: number; y1: number; x2: number; y2: number };
};

function labelContentLayout(
  rect: { x: number; y: number; w: number; h: number },
  anchor: LabelAnchor
): LabelContentLayout {
  const pad = labelInnerPad(rect.w);
  const [ax, ay] = anchorCorner(rect, anchor);
  const tipInset = pad * 0.5;

  switch (anchor) {
    case 'br':
      return {
        textX: rect.x + pad + rect.w * 0.12,
        textY: rect.y + pad + rect.h * 0.2,
        arrow: {
          x1: rect.x + rect.w * 0.42,
          y1: rect.y + rect.h * 0.42,
          x2: ax - tipInset,
          y2: ay - tipInset,
        },
      };
    case 'bl':
      return {
        textX: rect.x + rect.w - pad - rect.w * 0.12,
        textY: rect.y + pad + rect.h * 0.2,
        arrow: {
          x1: rect.x + rect.w * 0.58,
          y1: rect.y + rect.h * 0.42,
          x2: ax + tipInset,
          y2: ay - tipInset,
        },
      };
    case 'tl':
      return {
        textX: rect.x + rect.w - pad - rect.w * 0.12,
        textY: rect.y + rect.h - pad - rect.h * 0.2,
        arrow: {
          x1: rect.x + rect.w * 0.58,
          y1: rect.y + rect.h * 0.58,
          x2: ax + tipInset,
          y2: ay + tipInset,
        },
      };
    case 'tr':
      return {
        textX: rect.x + pad + rect.w * 0.12,
        textY: rect.y + rect.h - pad - rect.h * 0.2,
        arrow: {
          x1: rect.x + rect.w * 0.42,
          y1: rect.y + rect.h * 0.58,
          x2: ax - tipInset,
          y2: ay + tipInset,
        },
      };
  }
}

function clampCoord(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}

function resizeHitRadius(nw: number): number {
  return Math.max(7, nw * 0.008);
}

function boxCornerCenters(box: LandmarkBndbox): Record<ResizeHandle, [number, number]> {
  const { xmin, ymin, xmax, ymax } = box;
  return {
    tl: [xmin, ymin],
    tr: [xmax, ymin],
    br: [xmax, ymax],
    bl: [xmin, ymax],
  };
}

function applyResize(box: LandmarkBndbox, handle: ResizeHandle, cursor: [number, number]): LandmarkBndbox | null {
  const [cx, cy] = cursor;
  let { xmin, ymin, xmax, ymax } = box;
  if (handle === 'tl') {
    xmin = cx;
    ymin = cy;
  } else if (handle === 'tr') {
    xmax = cx;
    ymin = cy;
  } else if (handle === 'br') {
    xmax = cx;
    ymax = cy;
  } else {
    xmin = cx;
    ymax = cy;
  }
  const next = bndboxFromCorners(xmin, ymin, xmax, ymax);
  if (next.xmax - next.xmin < MIN_BOX || next.ymax - next.ymin < MIN_BOX) return null;
  return next;
}

const LandmarkCanvas: React.FC<LandmarkCanvasProps> = ({
  imageUrl,
  objects,
  onObjectsChange,
  pushHistoryRef,
  activeLabel,
  colorForLabel,
  selectedObjectId,
  onSelectedObjectIdChange,
  selectedPointIndex,
  onSelectedPointIndexChange,
  onNaturalSize,
  readOnly = false,
  suppressEscapeClear = false,
}) => {
  const imgRef = useRef<HTMLImageElement>(null);
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const activeLabelRef = useRef(activeLabel);
  activeLabelRef.current = activeLabel;
  const selectedObjectIdRef = useRef(selectedObjectId);
  selectedObjectIdRef.current = selectedObjectId;
  const selectedPointIndexRef = useRef(selectedPointIndex);
  selectedPointIndexRef.current = selectedPointIndex;
  const suppressEscapeRef = useRef(suppressEscapeClear);
  suppressEscapeRef.current = suppressEscapeClear;

  const [nw, setNw] = useState(0);
  const [nh, setNh] = useState(0);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState<{ x: number; y: number } | null>(null);
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);
  const [drawPreview, setDrawPreview] = useState<LandmarkBndbox | null>(null);
  const [magnifierOn, setMagnifierOn] = useState(true);
  const [showPoints, setShowPoints] = useState(true);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    onSelectedObjectIdChange(null);
    onSelectedPointIndexChange(null);
    setNw(0);
    setNh(0);
    setDrawPreview(null);
    dragRef.current = null;
  }, [imageUrl, onSelectedObjectIdChange, onSelectedPointIndexChange]);

  const handleImgLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      setNw(img.naturalWidth);
      setNh(img.naturalHeight);
      onNaturalSize?.(img.naturalWidth, img.naturalHeight);
    },
    [onNaturalSize]
  );

  const pushHistory = useCallback(() => {
    pushHistoryRef?.current?.();
  }, [pushHistoryRef]);

  const replaceObject = useCallback(
    (id: string, updater: (obj: LandmarkObjectPixel) => LandmarkObjectPixel, recordHistory = false) => {
      const next = objectsRef.current.map((o) => (o.id === id ? updater(o) : o));
      onObjectsChange(next, { recordHistory });
    },
    [onObjectsChange]
  );

  const findLabelHit = useCallback(
    (p: [number, number]): { objectId: string; pointIndex: number } | null => {
      const sid = selectedObjectIdRef.current;
      if (!sid || nw <= 0) return null;
      const obj = objects.find((o) => o.id === sid);
      if (!obj) return null;
      const { lw, lh } = getLabelMetrics(obj);
      for (const pt of obj.points) {
        const rect = labelRectForPoint(pt.index, pt.x, pt.y, lw, lh);
        if (pointInRect(p, rect.x, rect.y, rect.w, rect.h)) {
          return { objectId: obj.id, pointIndex: pt.index };
        }
      }
      return null;
    },
    [objects, nw]
  );

  const findObjectHit = useCallback(
    (p: [number, number]): string | null => {
      for (let i = objects.length - 1; i >= 0; i--) {
        const obj = objects[i]!;
        if (pointInBox(p, obj.bndbox)) return obj.id;
      }
      return null;
    },
    [objects]
  );

  const findHandleHit = useCallback(
    (p: [number, number]): { objectId: string; handle: ResizeHandle } | null => {
      if (nw <= 0) return null;
      const sid = selectedObjectIdRef.current;
      if (!sid) return null;
      const obj = objects.find((o) => o.id === sid);
      if (!obj) return null;
      const r = resizeHitRadius(nw);
      const r2 = r * r;
      const centers = boxCornerCenters(obj.bndbox);
      for (const handle of ['tl', 'tr', 'br', 'bl'] as const) {
        const [hx, hy] = centers[handle];
        const dx = p[0] - hx;
        const dy = p[1] - hy;
        if (dx * dx + dy * dy <= r2) {
          return { objectId: obj.id, handle };
        }
      }
      return null;
    },
    [objects, nw]
  );

  const commitDraw = useCallback(
    (box: LandmarkBndbox) => {
      const w = box.xmax - box.xmin;
      const h = box.ymax - box.ymin;
      if (w < MIN_BOX || h < MIN_BOX) return;
      const maxIndex = objectsRef.current.reduce((m, o) => Math.max(m, o.index), -1);
      const created = createLandmarkObject(maxIndex + 1, activeLabelRef.current, box);
      pushHistory();
      onObjectsChange([...objectsRef.current, created], { recordHistory: false });
      onSelectedObjectIdChange(created.id);
      onSelectedPointIndexChange(0);
    },
    [onObjectsChange, onSelectedObjectIdChange, onSelectedPointIndexChange, pushHistory]
  );

  const nudgeSelectedPoint = useCallback(
    (dx: number, dy: number) => {
      const sid = selectedObjectIdRef.current;
      const pi = selectedPointIndexRef.current;
      if (sid == null || pi == null || readOnly || nw <= 0 || nh <= 0) return;
      replaceObject(
        sid,
        (obj) => {
          const points = obj.points.map((pt) =>
            pt.index === pi
              ? {
                  ...pt,
                  x: clampCoord(pt.x + dx, nw),
                  y: clampCoord(pt.y + dy, nh),
                }
              : pt
          );
          return { ...obj, points };
        },
        false
      );
    },
    [nh, nw, readOnly, replaceObject]
  );

  const deleteObject = useCallback(
    (objectId: string) => {
      pushHistory();
      const next = objectsRef.current.filter((o) => o.id !== objectId);
      onObjectsChange(next, { recordHistory: false });
      if (selectedObjectIdRef.current === objectId) {
        onSelectedObjectIdChange(null);
        onSelectedPointIndexChange(null);
      }
    },
    [onObjectsChange, onSelectedObjectIdChange, onSelectedPointIndexChange, pushHistory]
  );

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const ZOOM_SPEED = 0.001;
    const delta = -e.deltaY * ZOOM_SPEED;
    setScale((s) => Math.min(12, Math.max(0.15, s * Math.exp(delta))));
  }, []);

  const onPointerDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-no-draw]')) return;

      const img = imgRef.current;
      if (!img || nw <= 0 || nh <= 0) return;

      if (e.button === 2) {
        e.preventDefault();
        if (readOnly) return;
        const p = clientToNatural(e.clientX, e.clientY, img, nw, nh);
        const objectHit = findObjectHit(p);
        if (objectHit) deleteObject(objectHit);
        return;
      }

      const isPan = e.button === 1 || isSpaceHeld;
      if (isPan) {
        setIsPanning(true);
        setLastPanPos({ x: e.clientX, y: e.clientY });
        e.preventDefault();
        return;
      }

      if (readOnly || e.button !== 0) return;

      const p = clientToNatural(e.clientX, e.clientY, img, nw, nh);

      const labelHit = showPoints ? findLabelHit(p) : null;
      if (labelHit) {
        pushHistory();
        onSelectedObjectIdChange(labelHit.objectId);
        onSelectedPointIndexChange(labelHit.pointIndex);
        dragRef.current = { kind: 'point', objectId: labelHit.objectId, pointIndex: labelHit.pointIndex };
        return;
      }

      const handleHit = findHandleHit(p);
      if (handleHit) {
        pushHistory();
        onSelectedObjectIdChange(handleHit.objectId);
        onSelectedPointIndexChange(null);
        const obj = objectsRef.current.find((o) => o.id === handleHit.objectId);
        if (obj) {
          dragRef.current = {
            kind: 'resize',
            objectId: handleHit.objectId,
            handle: handleHit.handle,
            box0: { ...obj.bndbox },
          };
        }
        return;
      }

      const objectHit = findObjectHit(p);
      if (objectHit) {
        pushHistory();
        onSelectedObjectIdChange(objectHit);
        onSelectedPointIndexChange(null);
        const obj = objectsRef.current.find((o) => o.id === objectHit);
        if (obj) {
          dragRef.current = {
            kind: 'body',
            objectId: objectHit,
            origin: p,
            pts0: obj.points.map((pt) => ({ ...pt })),
            box0: { ...obj.bndbox },
          };
        }
        return;
      }

      pushHistory();
      onSelectedObjectIdChange(null);
      onSelectedPointIndexChange(null);
      dragRef.current = { kind: 'draw', start: p };
      setDrawPreview(bndboxFromCorners(p[0], p[1], p[0], p[1]));
    },
    [deleteObject, findHandleHit, findLabelHit, findObjectHit, isSpaceHeld, nw, nh, onSelectedObjectIdChange, onSelectedPointIndexChange, pushHistory, readOnly, showPoints]
  );

  const onPointerMove = useCallback(
    (e: React.MouseEvent) => {
      const img = imgRef.current;
      if (!img || nw <= 0 || nh <= 0) return;
      const p = clientToNatural(e.clientX, e.clientY, img, nw, nh);

      if (isPanning && lastPanPos) {
        const dx = e.clientX - lastPanPos.x;
        const dy = e.clientY - lastPanPos.y;
        setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
        setLastPanPos({ x: e.clientX, y: e.clientY });
        return;
      }

      const d = dragRef.current;
      if (!d || readOnly) return;

      if (d.kind === 'draw') {
        setDrawPreview(bndboxFromCorners(d.start[0], d.start[1], p[0], p[1]));
        return;
      }

      if (d.kind === 'point') {
        replaceObject(d.objectId, (obj) => {
          const points = obj.points.map((pt) =>
            pt.index === d.pointIndex ? { ...pt, x: p[0], y: p[1] } : pt
          );
          return { ...obj, points };
        });
        return;
      }

      if (d.kind === 'body') {
        const dx = p[0] - d.origin[0];
        const dy = p[1] - d.origin[1];
        replaceObject(d.objectId, (obj) => {
          const points = d.pts0.map((pt) => ({ ...pt, x: pt.x + dx, y: pt.y + dy }));
          const bndbox = {
            xmin: d.box0.xmin + dx,
            ymin: d.box0.ymin + dy,
            xmax: d.box0.xmax + dx,
            ymax: d.box0.ymax + dy,
          };
          return { ...obj, points, bndbox };
        });
        return;
      }

      if (d.kind === 'resize') {
        replaceObject(d.objectId, (obj) => {
          const bndbox = applyResize(d.box0, d.handle, p);
          if (!bndbox) return obj;
          return { ...obj, bndbox };
        });
      }
    },
    [isPanning, lastPanPos, nw, nh, readOnly, replaceObject]
  );

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    if (d?.kind === 'draw' && drawPreview) {
      commitDraw(drawPreview);
      setDrawPreview(null);
    }
    dragRef.current = null;
    setIsPanning(false);
    setLastPanPos(null);
  }, [commitDraw, drawPreview]);

  const onPointerLeave = useCallback(() => {
    if (dragRef.current?.kind === 'draw') {
      setDrawPreview(null);
    }
    dragRef.current = null;
    setIsPanning(false);
    setLastPanPos(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (e.code === 'Space') {
        setIsSpaceHeld(true);
        e.preventDefault();
      }
      if (inField) return;

      if (e.key >= '1' && e.key <= '4' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const idx = Number(e.key) - 1;
        if (selectedObjectIdRef.current) {
          onSelectedPointIndexChange(idx);
        }
      }
      if (e.key === 'm' || e.key === 'M') {
        setMagnifierOn((v) => !v);
      }
      if ((e.key === '`' || e.code === 'Backquote') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setShowPoints((v) => !v);
      }
      if (
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        selectedObjectIdRef.current &&
        selectedPointIndexRef.current !== null &&
        !readOnly
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 1;
        let dx = 0;
        let dy = 0;
        if (e.key === 'ArrowLeft') dx = -step;
        if (e.key === 'ArrowRight') dx = step;
        if (e.key === 'ArrowUp') dy = -step;
        if (e.key === 'ArrowDown') dy = step;
        if (!e.repeat) pushHistory();
        nudgeSelectedPoint(dx, dy);
      }
      if (e.key === 'Escape' && !suppressEscapeRef.current) {
        setDrawPreview(null);
        dragRef.current = null;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setIsSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [nudgeSelectedPoint, onSelectedPointIndexChange, pushHistory, readOnly]);

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

  const u = (n: number) => n;

  const magnifierFocus = React.useMemo((): [number, number] | null => {
    if (!selectedObjectId || selectedPointIndex === null) return null;
    const obj = objects.find((o) => o.id === selectedObjectId);
    if (!obj) return null;
    const pt = obj.points.find((p) => p.index === selectedPointIndex);
    if (!pt) return null;
    return [pt.x, pt.y];
  }, [objects, selectedObjectId, selectedPointIndex]);

  const renderPointDecor = (obj: LandmarkObjectPixel, pt: LandmarkPoint, isSelectedObj: boolean) => {
    if (!showPoints) return null;
    const isActivePoint = isSelectedObj && selectedPointIndex === pt.index;
    const stroke = colorForLabel(obj.name);
    const uiNum = pt.index + 1;
    const px = pt.x;
    const py = pt.y;
    const { lw, lh } = getLabelMetrics(obj);
    const rect = labelRectForPoint(pt.index, px, py, lw, lh);
    const layout = labelContentLayout(rect, rect.anchor);
    const fontSize = u(Math.max(14, lw * 0.46));

    if (!isSelectedObj) {
      const { lw } = getLabelMetrics(obj);
      const r = u(Math.max(5, Math.min(9, lw * 0.14)));
      return (
        <g key={`pt-${pt.index}`}>
          <circle cx={px} cy={py} r={r} fill="#fff" stroke={stroke} strokeWidth={u(2)} opacity={0.95} />
        </g>
      );
    }

    return (
      <g key={`pt-${pt.index}`}>
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
          fill="rgba(255,255,255,0.92)"
          stroke={isActivePoint ? '#3b82f6' : '#e2e8f0'}
          strokeWidth={u(isActivePoint ? 2.5 : 2)}
        />
        <text
          x={layout.textX}
          y={layout.textY}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#ef4444"
          fontSize={fontSize}
          fontWeight="bold"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {uiNum}
        </text>
        <line
          x1={layout.arrow.x1}
          y1={layout.arrow.y1}
          x2={layout.arrow.x2}
          y2={layout.arrow.y2}
          stroke="#ef4444"
          strokeWidth={u(1.75)}
          markerEnd="url(#lm-arrow)"
        />
        <circle
          cx={px}
          cy={py}
          r={u(isActivePoint ? 2.5 : 1.5)}
          fill={isActivePoint ? '#3b82f6' : '#ef4444'}
          stroke="#fff"
          strokeWidth={u(1)}
          style={{ pointerEvents: 'none' }}
        />
      </g>
    );
  };

  const cursorStyle = isPanning || isSpaceHeld ? 'grab' : readOnly ? 'default' : 'crosshair';

  return (
    <div
      className="relative w-full h-full overflow-hidden select-none outline-none bg-black"
      tabIndex={-1}
      onMouseDown={onPointerDown}
      onMouseMove={onPointerMove}
      onMouseUp={onPointerUp}
      onMouseLeave={onPointerLeave}
      onWheel={handleWheel}
      onContextMenu={(ev) => {
        if (!readOnly) ev.preventDefault();
      }}
      style={{ cursor: cursorStyle }}
    >
      <div data-no-draw className="absolute top-4 left-4 z-50 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setMagnifierOn((v) => !v)}
          className={`px-3 py-2 rounded-xl text-xs font-bold border shadow-lg backdrop-blur-md transition-all ${
            magnifierOn
              ? 'bg-rose-500/90 text-white border-rose-400/50'
              : 'bg-slate-900/80 text-slate-300 border-white/10 hover:text-white'
          }`}
          title="돋보기 (M)"
        >
          돋보기
        </button>
        <button
          type="button"
          onClick={() => {
            setScale(1);
            setPan({ x: 0, y: 0 });
          }}
          className="px-3 py-2 rounded-xl text-xs font-bold border border-white/10 bg-slate-900/80 text-slate-300 hover:text-white shadow-lg backdrop-blur-md"
          title="확대/이동 초기화"
        >
          100%
        </button>
      </div>

      <LandmarkMagnifier
        imageUrl={displayUrl}
        naturalW={nw}
        naturalH={nh}
        focusNatural={magnifierFocus}
        focusLabel={showPoints && selectedPointIndex !== null ? String(selectedPointIndex + 1) : null}
        visible={magnifierOn && nw > 0 && showPoints}
      />

      <div className="absolute bottom-3 right-3 z-40 pointer-events-none text-[11px] font-mono text-slate-500 bg-slate-900/70 px-2 py-1 rounded-lg border border-white/10">
        {Math.round(scale * 100)}%
      </div>

      <div
        className="relative origin-top-left w-fit h-fit mx-auto"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transition: isPanning || dragRef.current ? 'none' : 'transform 0.075s ease-out',
        }}
      >
        <div className="relative inline-block">
          <img
            ref={imgRef}
            src={displayUrl}
            alt=""
            className="block max-h-[90vh] max-w-full pointer-events-none select-none shadow-2xl"
            draggable={false}
            onLoad={handleImgLoad}
          />
          {nw > 0 && nh > 0 && (
            <svg
              className="absolute left-0 top-0 w-full h-full pointer-events-none"
              viewBox={`0 0 ${nw} ${nh}`}
              preserveAspectRatio="xMidYMid meet"
              aria-hidden
            >
              <defs>
                <marker id="lm-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="#ef4444" />
                </marker>
              </defs>

              {objects.map((obj) => {
                const stroke = colorForLabel(obj.name);
                const isSel = obj.id === selectedObjectId;
                const { xmin, ymin, xmax, ymax } = obj.bndbox;
                const w = xmax - xmin;
                const h = ymax - ymin;

                return (
                  <g key={obj.id}>
                    <rect
                      x={xmin}
                      y={ymin}
                      width={w}
                      height={h}
                      fill={stroke}
                      fillOpacity={isSel ? 0.1 : 0.05}
                      stroke={stroke}
                      strokeWidth={u(isSel ? 4 : 3)}
                    />
                    <text
                      x={xmin + u(6)}
                      y={ymin + u(20)}
                      fill="#86efac"
                      fontSize={u(14)}
                      fontWeight="bold"
                      style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                      {obj.index}: {obj.type}
                    </text>
                    {obj.points.map((pt) => renderPointDecor(obj, pt, isSel))}
                  </g>
                );
              })}

              {drawPreview && (
                <rect
                  x={drawPreview.xmin}
                  y={drawPreview.ymin}
                  width={drawPreview.xmax - drawPreview.xmin}
                  height={drawPreview.ymax - drawPreview.ymin}
                  fill="rgba(34,211,238,0.08)"
                  stroke="#22d3ee"
                  strokeWidth={u(2)}
                  strokeDasharray={`${u(6)} ${u(4)}`}
                />
              )}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
};

export default LandmarkCanvas;
