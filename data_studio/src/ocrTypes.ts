export const OCR_QUAD_POINT_COUNT = 4;

export interface OcrBoxPixel {
  id: string;
  text: string;
  /** 4점 폴리곤 (픽셀 좌표) — PPOCRLabel points 형식 */
  points: [number, number][];
  score?: number;
  difficult?: boolean;
  auto?: boolean;
}

export function newOcrBoxId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      /* non-secure context */
    }
  }
  return `ocr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function rectDragToQuad(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const xmin = Math.min(x0, x1);
  const xmax = Math.max(x0, x1);
  const ymin = Math.min(y0, y1);
  const ymax = Math.max(y0, y1);
  return [
    [xmin, ymin],
    [xmax, ymin],
    [xmax, ymax],
    [xmin, ymax],
  ];
}

export function normalizeQuadPoints(raw: [number, number][]): [number, number][] {
  if (!raw || raw.length < 3) return raw;
  if (raw.length === 4) {
    return raw.map((p) => [Number(p[0]), Number(p[1])] as [number, number]);
  }
  const xs = raw.map((p) => Number(p[0]));
  const ys = raw.map((p) => Number(p[1]));
  return rectDragToQuad(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

export function quadBounds(points: [number, number][]): { w: number; h: number } {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    w: Math.max(0, Math.max(...xs) - Math.min(...xs)),
    h: Math.max(0, Math.max(...ys) - Math.min(...ys)),
  };
}

export function cloneOcrBoxes(list: OcrBoxPixel[]): OcrBoxPixel[] {
  return list.map((b) => ({
    ...b,
    points: b.points.map((p) => [p[0], p[1]] as [number, number]),
  }));
}

export function pointsFromDetectResult(r: {
  xmin?: number;
  ymin?: number;
  xmax?: number;
  ymax?: number;
  text?: string;
  score?: number;
  points?: [number, number][];
}): OcrBoxPixel {
  const points =
    r.points && r.points.length >= 4
      ? normalizeQuadPoints(r.points)
      : rectDragToQuad(
          Number(r.xmin ?? 0),
          Number(r.ymin ?? 0),
          Number(r.xmax ?? 0),
          Number(r.ymax ?? 0)
        );
  return {
    id: newOcrBoxId(),
    text: String(r.text ?? '').trim() || '###',
    points,
    score: r.score,
    auto: true,
  };
}

export function newManualOcrBox(cx: number, cy: number, w: number, h: number): OcrBoxPixel {
  return {
    id: newOcrBoxId(),
    text: '###',
    points: rectDragToQuad(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2),
    auto: false,
  };
}
