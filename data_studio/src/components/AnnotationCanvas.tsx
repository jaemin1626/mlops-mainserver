import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import type { BoundingBox, YoloClass } from '../types';

interface AnnotationCanvasProps {
  imageUrl: string;
  annotations: BoundingBox[];
  currentClass: YoloClass;
  classes: YoloClass[];
  readOnly?: boolean;
  onUpdateAnnotations: (newAnnotations: BoundingBox[]) => void;
  hiddenClassIds?: number[];
  customClassColors?: Record<number, string>;
  taskId?: string;
  undoSignal?: number;
  redoSignal?: number;
}

type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br';
type ToolMode = 'SELECT' | 'PAN';

const MIN_BOX_SIZE = 0.002; // Roughly 2-4 pixels on common image sizes, allows 11x11 easily.

const Tooltip = ({ text, children, position = 'right' }: { text: string; children: React.ReactNode; position?: 'right' | 'left' }) => (
  <div className="group relative flex items-center">
    <div className={`absolute ${position === 'right' ? 'left-full ml-4' : 'right-full mr-4'} px-3 py-2 bg-slate-900/95 backdrop-blur-xl border border-white/10 text-white text-[12px] font-bold tracking-wide rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.5)] whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 ${position === 'right' ? '-translate-x-2' : 'translate-x-2'} group-hover:translate-x-0 transition-all duration-300 z-[100] flex items-center gap-2`}>
      {text}
      <div className={`absolute top-1/2 -translate-y-1/2 ${position === 'right' ? 'right-full border-[6px]' : 'left-full border-[6px]'} border-transparent ${position === 'right' ? 'border-r-white/10' : 'border-l-white/10'}`}></div>
      <div className={`absolute top-1/2 -translate-y-1/2 ${position === 'right' ? 'right-full mr-[-10px] border-[5px]' : 'left-full ml-[-10px] border-[5px]'} border-transparent ${position === 'right' ? 'border-r-slate-900' : 'border-l-slate-900'}`}></div>
    </div>
    {children}
  </div>
);

const AnnotationCanvas: React.FC<AnnotationCanvasProps> = ({
  imageUrl,
  annotations,
  currentClass,
  classes,
  readOnly = false,
  onUpdateAnnotations,
  hiddenClassIds = [],
  customClassColors = {},
  taskId,
  undoSignal,
  redoSignal,
}) => {
  // Fix for special characters in filenames (e.g., #, [], spaces)
  const displayUrl = useMemo(() => {
    let normalized = imageUrl.replace(/\\/g, '/');

    if (/^https?:\/\//i.test(normalized) || (normalized.startsWith('/') && normalized.includes('?'))) {
      return normalized;
    }

    try {
      // 1. Try to decode first to prevent double encoding
      normalized = decodeURIComponent(normalized);
    } catch (e) {
      // Ignore error, assume raw
    }

    // 2. Encode path segments
    return normalized.split('/').map(part => {
      // If the part looks like a protocol (http:), don't encode the colon
      if (part.endsWith(':')) return part;
      return encodeURIComponent(part);
    }).join('/');
  }, [imageUrl]);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Transform State
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState<{ x: number; y: number } | null>(null);

  // UI State
  const [activeTool, setActiveTool] = useState<ToolMode>('SELECT');
  const [showLabels, setShowLabels] = useState(true);
  const [showPixelSizes, setShowPixelSizes] = useState(false);
  const [dimBoxes, setDimBoxes] = useState(false);
  const [imageNaturalSize, setImageNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    setHasError(false);
  }, [imageUrl]);

  // Style Customization State
  const [boxThickness, setBoxThickness] = useState(2);
  const [showCrosshair, setShowCrosshair] = useState(false);
  const [crosshairThickness, setCrosshairThickness] = useState(1);
  const [fillOpacity, setFillOpacity] = useState(20); // 0-100 percentage
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [mouseCanvasPos, setMouseCanvasPos] = useState<{ x: number; y: number } | null>(null);
  const [isDeleteAllConfirmOpen, setIsDeleteAllConfirmOpen] = useState(false);
  const FLOATING_UI_LS = 'yoloLocaltoolFloatingUiVisible';
  const [showFloatingUi, setShowFloatingUi] = useState(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(FLOATING_UI_LS) === '0' ? false : true
  );
  useEffect(() => {
    try {
      localStorage.setItem(FLOATING_UI_LS, showFloatingUi ? '1' : '0');
    } catch { /* ignore */ }
  }, [showFloatingUi]);

  // Track key states for temporary modes
  const isSpacePressedRef = useRef(false);

  // Drawing State
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStartPos, setDrawStartPos] = useState<{ x: number; y: number } | null>(null);
  const [currentMousePos, setCurrentMousePos] = useState<{ x: number; y: number } | null>(null);

  // Selection, Moving & Resizing State
  // Selection, Moving & Resizing State
  const [selectedBoxIds, setSelectedBoxIds] = useState<string[]>([]);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
  const [draggingBoxesSnapshot, setDraggingBoxesSnapshot] = useState<BoundingBox[]>([]);
  const [resizingHandle, setResizingHandle] = useState<ResizeHandle | null>(null);

  // Interaction State (Local)
  const [localAnnotations, setLocalAnnotations] = useState<BoundingBox[]>(annotations);
  const [recentlyPastedBoxIds, setRecentlyPastedBoxIds] = useState<string[]>([]);
  const [hoveredBoxId, setHoveredBoxId] = useState<string | null>(null);
  const localAnnotationsRef = useRef<BoundingBox[]>(annotations);
  const onUpdateRef = useRef(onUpdateAnnotations);
  const readOnlyRef = useRef(readOnly);

  // Undo/Redo & Clipboard
  const [undoStack, setUndoStack] = useState<BoundingBox[][]>([]);
  const [redoStack, setRedoStack] = useState<BoundingBox[][]>([]);
  const clipboardRef = useRef<BoundingBox[]>([]);

  const saveHistory = useCallback(() => {
    setUndoStack(prev => [...prev, localAnnotations]);
    setRedoStack([]);
  }, [localAnnotations]);
  const applyRedo = useCallback(() => {
    if (readOnlyRef.current) return;
    setRedoStack(prev => {
      if (prev.length === 0) return prev;
      const newStack = [...prev];
      const nextState = newStack.pop();
      if (nextState) {
        setUndoStack(uprev => [...uprev, localAnnotationsRef.current]);
        setLocalAnnotations(nextState);
        onUpdateRef.current(nextState);
      }
      return newStack;
    });
  }, []);
  const applyUndo = useCallback(() => {
    if (readOnlyRef.current) return;
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      const newStack = [...prev];
      const lastState = newStack.pop();
      if (lastState) {
        setRedoStack(rprev => [...rprev, localAnnotationsRef.current]);
        setLocalAnnotations(lastState);
        onUpdateRef.current(lastState);
      }
      return newStack;
    });
  }, []);
  const handleDelete = useCallback((ids: string[]) => {
    if (readOnly || ids.length === 0) return;
    saveHistory(); // Save before delete
    const updated = localAnnotations.filter(a => !ids.includes(a.id));
    setLocalAnnotations(updated);
    onUpdateAnnotations(updated);
    setSelectedBoxIds(prev => prev.filter(id => !ids.includes(id)));
  }, [localAnnotations, onUpdateAnnotations, readOnly, saveHistory]);

  const handleDeleteAll = useCallback(() => {
    if (readOnly || localAnnotations.length === 0) return;
    saveHistory();
    setLocalAnnotations([]);
    onUpdateAnnotations([]);
    setSelectedBoxIds([]);
    setIsDeleteAllConfirmOpen(false);
  }, [localAnnotations, onUpdateAnnotations, readOnly, saveHistory]);

  // Sync prop changes into local state (e.g. when changing tasks or undoing)
  useEffect(() => {
    if (!isDrawing && !dragStartPos && !isPanning) {
      setLocalAnnotations(annotations);
    }
  }, [annotations, isDrawing, dragStartPos, isPanning]);
  useEffect(() => {
    localAnnotationsRef.current = localAnnotations;
  }, [localAnnotations]);
  useEffect(() => {
    onUpdateRef.current = onUpdateAnnotations;
  }, [onUpdateAnnotations]);
  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);

  // Reset history and drawing state when switching tasks/images
  useEffect(() => {
    setUndoStack([]);
    setRedoStack([]);
    setSelectedBoxIds([]);
    setHoveredBoxId(null);
    setRecentlyPastedBoxIds([]);
    setIsDrawing(false);
    setDrawStartPos(null);
    setCurrentMousePos(null);
    setDragStartPos(null);
    setDraggingBoxesSnapshot([]);
    setResizingHandle(null);
  }, [taskId, imageUrl]);

  useEffect(() => {
    if (!redoSignal) return;
    applyRedo();
  }, [redoSignal, applyRedo]);
  useEffect(() => {
    if (!undoSignal) return;
    applyUndo();
  }, [undoSignal, applyUndo]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      if (e.key === ']' && !isCtrl) {
        const t = e.target as HTMLElement;
        if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
        e.preventDefault();
        setShowFloatingUi(prev => !prev);
        return;
      }
      if (readOnly) return;

      const typingTarget = e.target as HTMLElement;
      if (typingTarget?.tagName === 'INPUT' || typingTarget?.tagName === 'TEXTAREA' || typingTarget?.isContentEditable) {
        return;
      }

      const key = e.key.toLowerCase();

      if (isCtrl) {
        // Undo: Ctrl + Z
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          applyUndo();
          return;
        }

        // Redo: Ctrl + Y or Ctrl + Shift + Z
        if (key === 'y' || (key === 'z' && e.shiftKey)) {
          e.preventDefault();
          applyRedo();
          return;
        }
      }

      // 선택 박스 복사(C) / 전체 복사(X) / 붙여넣기(V) — 스페이스로 이미지 이동하므로 V는 팬 토글에 쓰지 않음
      if (key === 'c' && selectedBoxIds.length > 0) {
        e.preventDefault();
        const boxes = localAnnotations.filter((b) => selectedBoxIds.includes(b.id));
        if (boxes.length > 0) clipboardRef.current = boxes;
        return;
      }
      if (key === 'x' && !e.shiftKey) {
        e.preventDefault();
        if (localAnnotations.length > 0) clipboardRef.current = [...localAnnotations];
        return;
      }
      if (key === 'v') {
        e.preventDefault();
        if (clipboardRef.current.length > 0) {
          const tol = 1e-6;
          const samePos = (a: BoundingBox, b: BoundingBox) =>
            Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol && Math.abs(a.w - b.w) < tol && Math.abs(a.h - b.h) < tol;
          const toPaste = clipboardRef.current.filter((box) => !localAnnotations.some((existing) => samePos(box, existing)));
          if (toPaste.length === 0) return;
          saveHistory();
          const newBoxes = toPaste.map((box) => ({
            ...box,
            id: Math.random().toString(36).substr(2, 9),
            x: box.x,
            y: box.y,
            isAutoLabel: false,
          }));
          const updated = [...localAnnotations, ...newBoxes];
          setLocalAnnotations(updated);
          onUpdateAnnotations(updated);
          setSelectedBoxIds(newBoxes.map((b) => b.id));
          const newIds = newBoxes.map((b) => b.id);
          setRecentlyPastedBoxIds(newIds);
          setTimeout(() => {
            setRecentlyPastedBoxIds((prev) => prev.filter((id) => !newIds.includes(id)));
          }, 800);
        }
        return;
      }

      // Delete shortcuts (Del 은 Electron 로컬 앱 상단「이미지 삭제」와 연동 — 박스는 Bksp / R)
      if (e.key === 'Backspace' || key === 'r') {
        if (selectedBoxIds.length > 0) {
          e.preventDefault();
          handleDelete(selectedBoxIds);
        } else if (hoveredBoxId) {
          e.preventDefault();
          handleDelete([hoveredBoxId]);
          setHoveredBoxId(null);
        }
      }

      // Change Class of selected box or hovered box: 'e'
      if ((selectedBoxIds.length > 0 || hoveredBoxId) && key === 'e') {
        e.preventDefault();
        saveHistory(); // Save before modify
        const targetIds = selectedBoxIds.length > 0 ? selectedBoxIds : [hoveredBoxId!];
        const updated = localAnnotations.map(box =>
          targetIds.includes(box.id) ? { ...box, classId: currentClass.id, isAutoLabel: false } : box
        );
        setLocalAnnotations(updated);
        onUpdateAnnotations(updated);
      }

      if (e.key === 'Escape') {
        setSelectedBoxIds([]);
        setIsDrawing(false);
        setDrawStartPos(null);
        setCurrentMousePos(null);
        setDragStartPos(null);
        setDraggingBoxesSnapshot([]);
        setResizingHandle(null);
        setActiveTool('SELECT'); // Revert to select on Escape
      }

      // 손 도구(PAN) ↔ 박스 생성(SELECT) — 스페이스바는 일시 팬
      if (key === 'h') {
        e.preventDefault();
        setActiveTool((prev) => (prev === 'PAN' ? 'SELECT' : 'PAN'));
      }

      // Box Visibility Shortcut (B: dim; backtick is handled by parent for all hide/show)
      if (key === 'b') {
        setDimBoxes(prev => !prev);
      }

      // 다중 선택 추가: Shift+X (호버 중인 박스). 단일 X는 전체 박스 복사용.
      if (key === 'x' && e.shiftKey && hoveredBoxId) {
        e.preventDefault();
        setSelectedBoxIds((prev) => (prev.includes(hoveredBoxId) ? prev : [...prev, hoveredBoxId]));
        return;
      }

      /** F: 호버 중인 박스만 키로 선택 (Shift+F: 다중에 토글). 클릭은 F 없이도 선택·이동·리사이즈 가능 */
      if (key === 'f' && !isCtrl) {
        e.preventDefault();
        if (e.repeat) return;
        if (hoveredBoxId) {
          if (e.shiftKey) {
            setSelectedBoxIds((prev) =>
              prev.includes(hoveredBoxId) ? prev.filter((id) => id !== hoveredBoxId) : [...prev, hoveredBoxId]
            );
          } else {
            setSelectedBoxIds([hoveredBoxId]);
          }
        }
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedBoxIds, hoveredBoxId, handleDelete, readOnly, currentClass, localAnnotations, onUpdateAnnotations, saveHistory, applyRedo, applyUndo]);

  // --- Zoom Logic ---
  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    // Smooth zoom constant
    const ZOOM_SPEED = 0.001;
    const delta = -e.deltaY * ZOOM_SPEED;
    const newScale = Math.min(Math.max(0.1, scale + delta), 10);
    setScale(newScale);
  };

  // --- Coordinate Helper (Accounts for Zoom & Pan) ---
  const getNormalizedPos = (e: React.MouseEvent | MouseEvent) => {
    if (!imgRef.current) return { x: 0, y: 0 };

    // Get Mouse relative to the Image itself
    // getBoundingClientRect() on a transformed element gives the actual screen coordinates and size
    const rect = imgRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    // Clamp
    return {
      x: Math.min(Math.max(x, 0), 1),
      y: Math.min(Math.max(y, 0), 1)
    };
  };

  // Helper: Get contrast text color (Black or White)
  const getContrastColor = (hexColor: string) => {
    // Basic hex to rgb conversion
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return yiq >= 128 ? 'black' : 'white';
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // Only allow left click (0) and middle click (1) for interactions
    // Right click (2) is reserved for delete/context menu handled via onContextMenu
    if (e.button === 2) return;

    const target = e.target as HTMLElement;
    if (target.closest('[data-no-draw]')) return;

    const modEl =
      e.target instanceof Element
        ? ((target.closest('[data-handle]') || target.closest('[data-boxid]')) as HTMLElement | null)
        : null;
    const isModifying = !!modEl;

    // 1. Pan Checks (Middle Click, Spacebar, or Explicit Pan Tool)
    // Shift shortcut is now only for empty space to avoid multi-selection conflict
    const isExplicitPan = activeTool === 'PAN' || e.button === 1 || (e.button === 0 && isSpacePressedRef.current);
    const isShiftPanShortcut = e.button === 0 && e.shiftKey && !modEl;

    if (isExplicitPan || isShiftPanShortcut) {
      setIsPanning(true);
      setLastPanPos({ x: e.clientX, y: e.clientY });
      e.preventDefault();
      return;
    }

    if (readOnly) return;

    // 2. Second click to finish box (2-click mode)
    if (isDrawing && drawStartPos) {
      const pos = getNormalizedPos(e);
      const x = Math.min(drawStartPos.x, pos.x);
      const y = Math.min(drawStartPos.y, pos.y);
      const w = Math.abs(pos.x - drawStartPos.x);
      const h = Math.abs(pos.y - drawStartPos.y);
      if (w > MIN_BOX_SIZE && h > MIN_BOX_SIZE) {
        const newBox: BoundingBox = {
          id: Math.random().toString(36).substr(2, 9),
          classId: currentClass.id,
          x,
          y,
          w,
          h,
          isAutoLabel: false
        };
        const updated = [...localAnnotations, newBox];
        setLocalAnnotations(updated);
        onUpdateAnnotations(updated);
        setSelectedBoxIds([newBox.id]);
      }
      setIsDrawing(false);
      setDrawStartPos(null);
      setCurrentMousePos(null);
      return;
    }

    // 3. 박스/핸들 클릭: 선택·이동·리사이즈 (F 누를 필요 없음)
    if (isModifying) {
      // Check Resize Handle Click
      if (modEl?.dataset.handle) {
        const handle = modEl.dataset.handle as ResizeHandle;
        const boxId = modEl.dataset.boxid;
        if (boxId) {
          if (!selectedBoxIds.includes(boxId)) {
            setSelectedBoxIds([boxId]);
          }
          const box = localAnnotations.find(b => b.id === boxId);
          if (box) {
            setResizingHandle(handle);
            setDragStartPos(getNormalizedPos(e));
            setDraggingBoxesSnapshot([box]);
          }
          return;
        }
      }

      // Check Box Click (Select / Move)
      // Use elementsFromPoint to handle overlapping boxes (Cycle Selection)
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      const boxElements = elements.filter(el => (el as HTMLElement).dataset?.boxid);

      if (boxElements.length > 0) {
        // Find all box IDs under the cursor
        const boxIds = boxElements.map(el => (el as HTMLElement).dataset.boxid as string);

        // Determine next box to select
        let nextBoxId = boxIds[0];
        if (selectedBoxIds.length === 1 && boxIds.includes(selectedBoxIds[0])) {
          const currentIndex = boxIds.indexOf(selectedBoxIds[0]);
          nextBoxId = boxIds[(currentIndex + 1) % boxIds.length];
        }

        if (e.shiftKey) {
          // Toggle selection
          setSelectedBoxIds(prev =>
            prev.includes(nextBoxId) ? prev.filter(id => id !== nextBoxId) : [...prev, nextBoxId]
          );
        } else {
          if (!selectedBoxIds.includes(nextBoxId)) {
            setSelectedBoxIds([nextBoxId]);
          }
        }

        // Determine which boxes to drag
        const finalSelectionIds = e.shiftKey
          ? (selectedBoxIds.includes(nextBoxId) ? selectedBoxIds : [...selectedBoxIds, nextBoxId])
          : (selectedBoxIds.includes(nextBoxId) ? selectedBoxIds : [nextBoxId]);

        const boxesToDrag = localAnnotations.filter(b => finalSelectionIds.includes(b.id));

        if (boxesToDrag.length > 0) {
          saveHistory(); // Save before drag/resize
          const pos = getNormalizedPos(e);
          setDragStartPos(pos);
          setDraggingBoxesSnapshot(boxesToDrag);
        }
        return; // Stop drawing logic
      }
    }

    // 4. Default: First click -> Start Drawing (2-click: second click completes in step 2)
    saveHistory(); // Save before drawing new box
    if (!e.shiftKey) setSelectedBoxIds([]);
    setDragStartPos(null);
    setDraggingBoxesSnapshot([]);
    setResizingHandle(null);

    const pos = getNormalizedPos(e);
    setDrawStartPos(pos);
    setCurrentMousePos(pos);
    setIsDrawing(true);
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    // Always update mouse position for crosshair
    const pos = getNormalizedPos(e);
    setMouseCanvasPos(pos);

    // Panning
    if (isPanning && lastPanPos) {
      const dx = e.clientX - lastPanPos.x;
      const dy = e.clientY - lastPanPos.y;
      setPan(p => ({ x: p.x + dx, y: p.y + dy }));
      setLastPanPos({ x: e.clientX, y: e.clientY });
      return;
    }

    // 1. Resizing (Only supported for single box)
    if (resizingHandle && draggingBoxesSnapshot.length === 1 && dragStartPos && !readOnly) {
      const dx = pos.x - dragStartPos.x;
      const dy = pos.y - dragStartPos.y;

      const snapshot = draggingBoxesSnapshot[0];
      let { x, y, w, h } = snapshot;

      // Apply delta based on handle
      if (resizingHandle === 'br') {
        w = Math.max(MIN_BOX_SIZE, w + dx);
        h = Math.max(MIN_BOX_SIZE, h + dy);
      } else if (resizingHandle === 'bl') {
        const maxDX = w - MIN_BOX_SIZE;
        const actualDX = Math.min(maxDX, dx);
        x = x + actualDX;
        w = w - actualDX;
        h = Math.max(MIN_BOX_SIZE, h + dy);
      } else if (resizingHandle === 'tr') {
        const maxDY = h - MIN_BOX_SIZE;
        const actualDY = Math.min(maxDY, dy);
        y = y + actualDY;
        h = h - actualDY;
        w = Math.max(MIN_BOX_SIZE, w + dx);
      } else if (resizingHandle === 'tl') {
        const maxDX = w - MIN_BOX_SIZE;
        const actualDX = Math.min(maxDX, dx);
        const maxDY = h - MIN_BOX_SIZE;
        const actualDY = Math.min(maxDY, dy);

        x = x + actualDX;
        w = w - actualDX;
        y = y + actualDY;
        h = h - actualDY;
      }

      // Clamp to image bounds
      if (x < 0) { w += x; x = 0; }
      if (y < 0) { h += y; y = 0; }
      if (x + w > 1) { w = 1 - x; }
      if (y + h > 1) { h = 1 - y; }

      setLocalAnnotations(prev => prev.map(a =>
        a.id === snapshot.id
          ? { ...a, x, y, w, h, isAutoLabel: false } // Mark as modified
          : a
      ));
      return;
    }

    // 2. Moving selection (Single or Multiple)
    if (dragStartPos && draggingBoxesSnapshot.length > 0 && !resizingHandle && !readOnly) {
      const dx = pos.x - dragStartPos.x;
      const dy = pos.y - dragStartPos.y;

      const draggingIds = draggingBoxesSnapshot.map(b => b.id);

      setLocalAnnotations(prev => prev.map(a => {
        if (draggingIds.includes(a.id)) {
          const snapshot = draggingBoxesSnapshot.find(b => b.id === a.id)!;
          let newX = snapshot.x + dx;
          let newY = snapshot.y + dy;

          // Clamp to image bounds
          newX = Math.max(0, Math.min(newX, 1 - snapshot.w));
          newY = Math.max(0, Math.min(newY, 1 - snapshot.h));
          return { ...a, x: newX, y: newY, isAutoLabel: false };
        }
        return a;
      }));
      return;
    }

    // 3. Drawing a new box
    if (isDrawing) {
      setCurrentMousePos(pos);
    }
  }, [isDrawing, dragStartPos, draggingBoxesSnapshot, resizingHandle, readOnly, isPanning, lastPanPos, scale, pan]);

  const handleMouseUp = useCallback(() => {
    // Finish Panning
    if (isPanning) {
      setIsPanning(false);
      setLastPanPos(null);
      return;
    }

    // Finish Resizing or Moving
    if (dragStartPos) {
      onUpdateAnnotations(localAnnotations);
      setDragStartPos(null);
      setDraggingBoxesSnapshot([]);
      setResizingHandle(null);
      return;
    }

    // Drawing: 2-click mode — box is completed on second click (handleMouseDown), not on mouseUp
    if (isDrawing && drawStartPos) {
      return; // keep waiting for second click
    }
    if (isDrawing) {
      setIsDrawing(false);
      setDrawStartPos(null);
      setCurrentMousePos(null);
    }
  }, [isDrawing, drawStartPos, dragStartPos, isPanning, localAnnotations, onUpdateAnnotations]);

  // Spacebar to toggle pan cursor
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressedRef.current = true;
        if (activeTool !== 'PAN') document.body.style.cursor = 'grab';
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressedRef.current = false;
        if (activeTool !== 'PAN') document.body.style.cursor = 'default';
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      document.body.style.cursor = 'default';
    }
  }, [activeTool]);

  useEffect(() => {
    // Global listeners for drag/draw outside the div
    if (isDrawing || dragStartPos || isPanning) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    } else {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDrawing, dragStartPos, isPanning, handleMouseMove, handleMouseUp]);

  return (
    <>
      {/* Flash Animation Style */}
      <style>{`
        @keyframes box-flash {
          0% { filter: brightness(1); box-shadow: 0 0 0 0px rgba(255,255,255,0); }
          50% { filter: brightness(2); box-shadow: 0 0 20px 10px rgba(255,255,255,0.9); z-index: 100 !important; }
          100% { filter: brightness(1); box-shadow: 0 0 0 0px rgba(255,255,255,0); }
        }
        .animate-paste-flash {
          animation: box-flash 0.8s ease-out;
        }
      `}</style>

      <div
        ref={containerRef}
        className="relative w-full h-full bg-gray-950 overflow-hidden select-none"
        onMouseDown={handleMouseDown}
        onMouseMove={(e) => {
          if (showCrosshair) setMouseCanvasPos(getNormalizedPos(e));
        }}
        onMouseLeave={() => {
          if (showCrosshair) setMouseCanvasPos(null);
        }}
        onWheel={handleWheel}
        onContextMenu={(e) => {
          if (isDrawing && drawStartPos) {
            setIsDrawing(false);
            setDrawStartPos(null);
            setCurrentMousePos(null);
          }
          e.preventDefault();
        }}
        style={{ cursor: activeTool === 'PAN' || isPanning ? 'grab' : (readOnly ? 'default' : 'crosshair') }}
      >
        {/* Transform Container */}
        <div
          className="relative origin-top-left w-fit h-fit"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transition: (isPanning || dragStartPos || isDrawing) ? 'none' : 'transform 0.075s ease-out'
          }}
        >
          {/* Loading State - Removed per user request */}

          {hasError && (
            <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-gray-900/90 backdrop-blur-md">
              <svg className="w-16 h-16 text-red-500 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
              <p className="text-red-400 font-bold text-lg mb-2">Failed to load image</p>
              <button
                onClick={() => {
                  setHasError(false);
                  setIsLoading(true);
                  // Force retry by appending random param
                  const separator = displayUrl.includes('?') ? '&' : '?';
                  const retryUrl = `${displayUrl}${separator}retry=${Date.now()}`;
                  if (imgRef.current) imgRef.current.src = retryUrl;
                }}
                className="px-6 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-bold transition-colors shadow-lg"
              >
                Retry
              </button>
            </div>
          )}

          <img
            ref={imgRef}
            src={displayUrl}
            alt="Work Task"
            className="max-h-[90vh] block pointer-events-none select-none shadow-2xl"
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setImageNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
              setIsLoading(false);
              setHasError(false);
            }}
            onError={() => {
              // Only error if even the fallback fails
              setIsLoading(false);
              setHasError(true);
            }}
          />

          {localAnnotations.map((box) => {
            // Visibility Check
            if (hiddenClassIds.includes(box.classId)) return null;

            const cls = classes.find(c => c.id === box.classId);
            const isSelected = selectedBoxIds.includes(box.id);
            const canManipulateBox =
              isSelected && !readOnly && activeTool !== 'PAN' && selectedBoxIds.length === 1;
            const isRecentlyPasted = recentlyPastedBoxIds.includes(box.id);

            // Color Logic: Custom > Default > Fallback
            const color = customClassColors[box.classId] || cls?.color || '#fff';
            const borderStyle = box.isAutoLabel ? 'dashed' : 'solid';
            /** 선택 시 외곽 흰 링 대신 박스 테두리(inset+border) 자체를 흰색으로 */
            const outlineColor = isSelected ? '#ffffff' : color;

            // Convert hex to rgba for fill
            const hex = color.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            const fillColor = `rgba(${r}, ${g}, ${b}, ${isSelected ? (fillOpacity / 100) + 0.15 : (fillOpacity / 100)})`;

            return (
              <div
                key={box.id}
                onMouseEnter={() => setHoveredBoxId(box.id)}
                onMouseLeave={() => setHoveredBoxId(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (isDrawing && drawStartPos) {
                    setIsDrawing(false);
                    setDrawStartPos(null);
                    setCurrentMousePos(null);
                    return;
                  }
                  handleDelete([box.id]);
                }}
                data-boxid={box.id}
                className={`absolute ${isSelected ? 'z-50' : 'z-10 hover:z-40'} ${isRecentlyPasted ? 'animate-paste-flash' : ''}`}
                style={{
                  left: `${box.x * 100}%`,
                  top: `${box.y * 100}%`,
                  width: `${box.w * 100}%`,
                  height: `${box.h * 100}%`,
                  boxShadow: `inset 0 0 0 ${(boxThickness) / scale}px ${outlineColor}`,
                  border: `${(boxThickness / 2) / scale}px ${borderStyle} ${outlineColor}`,
                  backgroundColor: fillColor,
                  opacity: dimBoxes && !isSelected ? 0.15 : 1,
                  pointerEvents: 'auto', // Enabled for interior interaction
                  cursor: isSelected && !readOnly ? 'move' : (activeTool === 'SELECT' ? 'crosshair' : 'inherit')
                }}
              >
                {/* Hit Areas (Borders only) */}
                {!isPanning && !isDrawing && (
                  <>
                    {/* Top Edge */}
                    <div
                      data-boxid={box.id}
                      className="absolute left-0 right-0"
                      style={{ height: `${8 / scale}px`, top: `-${4 / scale}px`, cursor: canManipulateBox ? 'move' : 'inherit', pointerEvents: canManipulateBox ? 'auto' : 'none' }}
                    />
                    {/* Bottom Edge */}
                    <div
                      data-boxid={box.id}
                      className="absolute left-0 right-0"
                      style={{ height: `${8 / scale}px`, bottom: `-${4 / scale}px`, cursor: canManipulateBox ? 'move' : 'inherit', pointerEvents: canManipulateBox ? 'auto' : 'none' }}
                    />
                    {/* Left Edge */}
                    <div
                      data-boxid={box.id}
                      className="absolute top-0 bottom-0"
                      style={{ width: `${8 / scale}px`, left: `-${4 / scale}px`, cursor: canManipulateBox ? 'move' : 'inherit', pointerEvents: canManipulateBox ? 'auto' : 'none' }}
                    />
                    {/* Right Edge */}
                    <div
                      data-boxid={box.id}
                      className="absolute top-0 bottom-0"
                      style={{ width: `${8 / scale}px`, right: `-${4 / scale}px`, cursor: canManipulateBox ? 'move' : 'inherit', pointerEvents: canManipulateBox ? 'auto' : 'none' }}
                    />
                  </>
                )}
                {/* Label Tag (Conditional) */}
                {showLabels && (
                  <span
                    className={`absolute left-0 px-2 py-0.5 font-bold rounded-sm shadow-sm whitespace-nowrap pointer-events-none origin-bottom-left flex items-center justify-center gap-1.5`}
                    style={{
                      backgroundColor: color,
                      color: getContrastColor(color),
                      bottom: '100%',
                      fontSize: `${12 / scale}px`,
                      lineHeight: `${14 / scale}px`,
                      padding: `${2 / scale}px ${4 / scale}px`,
                      marginBottom: `${2 / scale}px`,
                    }}
                  >
                    <span>{cls?.name}</span>
                    {showPixelSizes && imageNaturalSize && (
                      <span
                        className="font-mono text-[0.9em] pl-1.5 ml-0.5"
                        style={{
                          borderLeft: `1px solid ${getContrastColor(color) === 'white' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'}`,
                          opacity: 0.9
                        }}
                      >
                        {Math.round(box.w * imageNaturalSize.width)}x{Math.round(box.h * imageNaturalSize.height)}
                      </span>
                    )}
                  </span>
                )}

                {/* Resize Handles (단일 선택 시) */}
                {isSelected && selectedBoxIds.length === 1 && !readOnly && activeTool !== 'PAN' && (
                  <div style={{ pointerEvents: 'auto' }}>
                    <div data-handle="tl" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-nw-resize z-50 hover:bg-blue-100"
                      style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, top: `-${5 / scale}px`, left: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                    <div data-handle="tr" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-ne-resize z-50 hover:bg-blue-100"
                      style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, top: `-${5 / scale}px`, right: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                    <div data-handle="bl" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-sw-resize z-50 hover:bg-blue-100"
                      style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, bottom: `-${5 / scale}px`, left: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                    <div data-handle="br" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-se-resize z-50 hover:bg-blue-100"
                      style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, bottom: `-${5 / scale}px`, right: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                  </div>
                )}

              </div>
            );
          })}

          {/* Drawing Box Preview */}
          {isDrawing && drawStartPos && currentMousePos && (
            <div
              className={`absolute border-dashed border-white bg-white/10 z-[60] pointer-events-none ${true ? 'animate-pulse' : ''}`}
              style={{
                left: `${Math.min(drawStartPos.x, currentMousePos.x) * 100}%`,
                top: `${Math.min(drawStartPos.y, currentMousePos.y) * 100}%`,
                width: `${Math.abs(currentMousePos.x - drawStartPos.x) * 100}%`,
                height: `${Math.abs(currentMousePos.y - drawStartPos.y) * 100}%`,
                borderWidth: `${2 / scale}px`
              }}
            />
          )}

          {/* Crosshair Overlay (Inside Transform Container for pixel alignment) */}
          {showCrosshair && mouseCanvasPos && (
            <div className="absolute inset-0 pointer-events-none z-40 overflow-hidden">
              <div
                className="absolute bg-white/50"
                style={{
                  left: 0,
                  right: 0,
                  top: `${mouseCanvasPos.y * 100}%`,
                  height: `${crosshairThickness / scale}px`,
                  transform: `translateY(-50%)`
                }}
              />
              <div
                className="absolute bg-white/50"
                style={{
                  top: 0,
                  bottom: 0,
                  left: `${mouseCanvasPos.x * 100}%`,
                  width: `${crosshairThickness / scale}px`,
                  transform: `translateX(-50%)`
                }}
              />
            </div>
          )}
        </div>



        {/* Floating Toolbar (Tools & Zoom) — hide/show: ] or top chevron */}
        {!showFloatingUi && (
          <div data-no-draw className="absolute top-6 left-6 z-50">
            <Tooltip text="도구 패널 표시 (])">
              <button
                type="button"
                onClick={() => setShowFloatingUi(true)}
                className="p-3 rounded-xl shadow-2xl backdrop-blur-md border border-white/10 bg-slate-900/80 text-slate-200 hover:bg-slate-800 hover:text-white transition-all duration-300 hover:scale-105"
                aria-label="도구 패널 표시"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              </button>
            </Tooltip>
          </div>
        )}
        {showFloatingUi && (
        <div data-no-draw className="absolute top-6 left-6 flex flex-col gap-3 z-50">
          <Tooltip text="도구 패널 숨기기 (])">
            <button
              type="button"
              onClick={() => setShowFloatingUi(false)}
              className="p-2.5 rounded-xl shadow-2xl backdrop-blur-md border border-white/10 bg-slate-800/70 text-slate-400 hover:text-white hover:bg-slate-700/90 transition-all duration-300"
              aria-label="도구 패널 숨기기"
            >
              <svg className="w-4 h-4 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </button>
          </Tooltip>
          <Tooltip text={activeTool === 'PAN' ? '박스 생성 모드로 (H)' : '손 도구 · 이미지 팬 (H) · 스페이스로도 이동'}>
            <button
              onClick={() => setActiveTool(activeTool === 'PAN' ? 'SELECT' : 'PAN')}
              className={`p-3 rounded-xl shadow-2xl backdrop-blur-md border transition-all duration-300 ${activeTool === 'PAN'
                ? 'bg-blue-600/90 text-white border-blue-500/50 shadow-blue-500/20'
                : 'bg-slate-900/60 text-slate-300 border-white/10 hover:bg-slate-800/80 hover:text-white hover:border-white/20 hover:scale-105'
                }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11" />
              </svg>
            </button>
          </Tooltip>

          <Tooltip text="레이블 표시 켜기/끄기">
            <button
              onClick={() => setShowLabels(!showLabels)}
              className={`p-3 rounded-xl shadow-2xl backdrop-blur-md border transition-all duration-300 ${showLabels
                ? 'bg-blue-600/90 text-white border-blue-500/50 shadow-blue-500/20'
                : 'bg-slate-900/60 text-slate-300 border-white/10 hover:bg-slate-800/80 hover:text-white hover:border-white/20 hover:scale-105'
                }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>
            </button>
          </Tooltip>

          <Tooltip text="객체 크기(px) 표시 켜기/끄기">
            <button
              onClick={() => setShowPixelSizes(!showPixelSizes)}
              className={`p-3 rounded-xl shadow-2xl backdrop-blur-md border transition-all duration-300 ${showPixelSizes
                ? 'bg-blue-600/90 text-white border-blue-500/50 shadow-blue-500/20'
                : 'bg-slate-900/60 text-slate-300 border-white/10 hover:bg-slate-800/80 hover:text-white hover:border-white/20 hover:scale-105'
                }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6h18a2 2 0 012 2v8a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6v4M10 6v3M14 6v4M18 6v3" />
              </svg>
            </button>
          </Tooltip>

          <Tooltip text="박스 표시 켜기/끄기 (B)">
            <button
              onClick={() => setDimBoxes(!dimBoxes)}
              className={`p-3 rounded-xl shadow-2xl backdrop-blur-md border transition-all duration-300 ${dimBoxes
                ? 'bg-blue-600/90 text-white border-blue-500/50 shadow-blue-500/20'
                : 'bg-slate-900/60 text-slate-300 border-white/10 hover:bg-slate-800/80 hover:text-white hover:border-white/20 hover:scale-105'
                }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
            </button>
          </Tooltip>

          <div className="h-px bg-white/10 w-8 mx-auto my-1 rounded-full"></div>

          <Tooltip text="이미지 크기 재조정">
            <button
              onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}
              className="p-3 bg-slate-900/60 text-slate-300 rounded-xl shadow-2xl backdrop-blur-md border border-white/10 hover:bg-slate-800/80 hover:text-white hover:border-white/20 transition-all duration-300 hover:scale-105"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
            </button>
          </Tooltip>

          <Tooltip text="캔버스 설정">
            <button
              onClick={() => setIsSettingsOpen(!isSettingsOpen)}
              className={`p-3 rounded-xl shadow-2xl backdrop-blur-md border transition-all duration-300 ${isSettingsOpen
                ? 'bg-blue-600/90 text-white border-blue-500/50 shadow-blue-500/20'
                : 'bg-slate-900/60 text-slate-300 border-white/10 hover:bg-slate-800/80 hover:text-white hover:border-white/20 hover:scale-105'
                }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            </button>
          </Tooltip>

          <Tooltip text="모든 박스 삭제">
            <button
              onClick={() => setIsDeleteAllConfirmOpen(true)}
              className="p-3 bg-slate-900/60 text-red-400 rounded-xl shadow-2xl backdrop-blur-md border border-white/10 hover:bg-red-500 hover:text-white hover:border-red-400 transition-all duration-300 hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:bg-slate-900/60 disabled:hover:text-red-400 disabled:hover:border-white/10"
              disabled={localAnnotations.length === 0}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          </Tooltip>

          <div className="flex-1 min-h-[4rem]"></div>
        </div>
        )}

        {/* Settings Overlay */}
        {isSettingsOpen && (
          <div data-no-draw className="absolute bottom-16 left-24 w-[320px] bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl p-6 z-50 animate-in slide-in-from-bottom-2 duration-300">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-white font-bold flex items-center gap-2">
                <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                캔버스 시각 설정
              </h3>
              <button onClick={() => setIsSettingsOpen(false)} className="p-1 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l18 18" /></svg>
              </button>
            </div>
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">박스 선 굵기</label>
                  <span className="text-blue-400 font-mono text-xs px-1.5 py-0.5 bg-blue-400/10 rounded">{boxThickness}px</span>
                </div>
                <input type="range" min="1" max="10" value={boxThickness} onChange={(e) => setBoxThickness(parseInt(e.target.value))} className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
              </div>
              <div className="h-px bg-gray-800" />
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">마우스 십자선</label>
                  <button onClick={() => setShowCrosshair(!showCrosshair)} className={`w-11 h-6 rounded-full transition-all relative ${showCrosshair ? 'bg-blue-600 shadow-[0_0_10px_rgba(37,99,235,0.4)]' : 'bg-gray-700'}`}><div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${showCrosshair ? 'left-6' : 'left-1'}`} /></button>
                </div>
                {showCrosshair && (
                  <div className="space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="flex justify-between items-center"><label className="text-gray-400 text-[11px] uppercase tracking-wider font-bold">십자선 굵기</label><span className="text-blue-400 font-mono text-xs px-1.5 py-0.5 bg-blue-400/10 rounded">{crosshairThickness}px</span></div>
                    <input type="range" min="1" max="5" value={crosshairThickness} onChange={(e) => setCrosshairThickness(parseInt(e.target.value))} className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                  </div>
                )}
              </div>
              <div className="h-px bg-gray-800" />
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">박스 투명도 (Fill)</label>
                  <span className="text-blue-400 font-mono text-xs px-1.5 py-0.5 bg-blue-400/10 rounded">{fillOpacity}%</span>
                </div>
                <input type="range" min="0" max="80" value={fillOpacity} onChange={(e) => setFillOpacity(parseInt(e.target.value))} className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
              </div>
              <div className="h-px bg-gray-800" />
              <div className="space-y-2">
                <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold block">박스 선택·수정</label>
                <p className="text-[11px] text-gray-500 leading-relaxed">
                  클릭으로 선택·이동(다중 선택 시 함께 이동). 단일 선택일 때만 모서리·핸들로 크기 조절. 호버 중 <span className="text-gray-400 font-mono">F</span>로 선택, <span className="text-gray-400 font-mono">Shift+F</span> 또는 <span className="text-gray-400">Shift+클릭</span>으로 다중 선택을 토글합니다.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Delete All Confirmation Modal */}
        {isDeleteAllConfirmOpen && (
          <div data-no-draw className="absolute inset-0 z-[100] bg-slate-950/80 backdrop-blur-xl flex items-center justify-center p-4 animate-in fade-in zoom-in-95 duration-300" onClick={() => setIsDeleteAllConfirmOpen(false)}>
            <div className="bg-slate-900 border border-white/5 rounded-3xl shadow-2xl max-w-sm w-full overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="p-8 text-center relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-red-600 to-rose-500"></div>
                <div className="w-20 h-20 bg-red-900/20 rounded-full flex items-center justify-center mx-auto mb-6 border border-red-500/20 shadow-[0_0_30px_rgba(239,68,68,0.15)] relative">
                  <div className="absolute inset-0 rounded-full border border-red-500/10 animate-ping"></div>
                  <svg className="w-10 h-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </div>
                <h3 className="text-2xl font-bold text-white mb-3 tracking-wide">모든 박스 삭제</h3>
                <p className="text-slate-400 text-sm leading-relaxed mb-8">
                  현재 이미지에 있는 <strong className="text-white font-semibold">모든 어노테이션 박스</strong>를<br />삭제하시겠습니까?<br />
                  <span className="text-red-400 font-medium text-xs mt-2 inline-block px-3 py-1 bg-red-900/20 rounded-lg">이 작업은 Ctrl+Z로 되돌릴 수 있습니다.</span>
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    onClick={() => setIsDeleteAllConfirmOpen(false)}
                    className="py-3.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-xl transition-all border border-slate-700 hover:border-slate-600 shadow-sm"
                  >
                    취소
                  </button>
                  <button
                    onClick={handleDeleteAll}
                    className="py-3.5 bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white font-bold rounded-xl shadow-[0_0_20px_rgba(239,68,68,0.3)] hover:shadow-[0_0_25px_rgba(239,68,68,0.4)] transition-all active:scale-[0.98]"
                  >
                    모두 삭제
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div >
    </>
  );
};

export default AnnotationCanvas;