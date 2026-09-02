import React, { useCallback, useEffect, useRef, useState } from 'react';

const PANEL_W = 336;
const PANEL_H = 200;
const ZOOM = 5;

interface LandmarkMagnifierProps {
  imageUrl: string;
  naturalW: number;
  naturalH: number;
  /** 선택된 포인트의 이미지 픽셀 좌표 */
  focusNatural: [number, number] | null;
  focusLabel?: string | null;
  visible: boolean;
}

const LandmarkMagnifier: React.FC<LandmarkMagnifierProps> = ({
  imageUrl,
  naturalW,
  naturalH,
  focusNatural,
  focusLabel,
  visible,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [pos, setPos] = useState({ x: 12, y: 12 });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageUrl;
    img.onload = () => {
      imgRef.current = img;
    };
    return () => {
      imgRef.current = null;
    };
  }, [imageUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ctx.clearRect(0, 0, PANEL_W, PANEL_H);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, PANEL_W, PANEL_H);

    if (!visible || !focusNatural || naturalW <= 0 || naturalH <= 0) return;

    const img = imgRef.current;
    if (!img || !img.complete) return;

    const [cx, cy] = focusNatural;
    const srcW = PANEL_W / ZOOM;
    const srcH = PANEL_H / ZOOM;
    let sx = cx - srcW / 2;
    let sy = cy - srcH / 2;
    sx = Math.max(0, Math.min(naturalW - srcW, sx));
    sy = Math.max(0, Math.min(naturalH - srcH, sy));

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, sx, sy, srcW, srcH, 0, 0, PANEL_W, PANEL_H);

    const px = ((cx - sx) / srcW) * PANEL_W;
    const py = ((cy - sy) / srcH) * PANEL_H;
    const gap = 6;

    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, py - gap);
    ctx.moveTo(px, py + gap);
    ctx.lineTo(px, PANEL_H);
    ctx.moveTo(0, py);
    ctx.lineTo(px - gap, py);
    ctx.moveTo(px + gap, py);
    ctx.lineTo(PANEL_W, py);
    ctx.stroke();

    ctx.fillStyle = '#4ade80';
    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#14532d';
    ctx.lineWidth = 1;
    ctx.stroke();
  }, [visible, focusNatural, naturalW, naturalH, imageUrl]);

  const coordText =
    focusNatural && visible
      ? `${focusNatural[0].toFixed(1)}, ${focusNatural[1].toFixed(1)}`
      : null;

  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [pos.x, pos.y]);

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      x: Math.max(0, d.originX + (e.clientX - d.startX)),
      y: Math.max(0, d.originY + (e.clientY - d.startY)),
    });
  }, []);

  const onHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  if (!visible) return null;

  return (
    <div
      className="absolute z-50 rounded-xl border border-white/20 bg-slate-950/95 shadow-2xl overflow-hidden select-none"
      style={{ left: pos.x, top: pos.y, width: PANEL_W + 2 }}
      data-no-draw
    >
      <div
        className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/10 cursor-move flex items-center justify-between gap-2 bg-slate-900/90"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <span>{focusLabel ? `포인트 ${focusLabel}` : '돋보기'}</span>
        <span className="text-slate-500 font-mono text-[9px]">{coordText ?? ''}</span>
        <span className="text-slate-600 font-mono">{ZOOM}×</span>
      </div>
      <canvas ref={canvasRef} width={PANEL_W} height={PANEL_H} className="block bg-black" />
    </div>
  );
};

export default LandmarkMagnifier;
