import type { OcrBoxPixel } from './ocrTypes';
import { newOcrBoxId, normalizeQuadPoints } from './ocrTypes';
import { serializeBoxForPpocr } from './ocrLabelFormat';

export const OCR_SIDECAR_VERSION = 1;

export type OcrSidecarBox = {
  transcription: string;
  points: [number, number][];
  difficult?: boolean;
  score?: number;
  auto?: boolean;
};

export type OcrSidecarFile = {
  version: number;
  boxes: OcrSidecarBox[];
};

function sidecarBoxFromPixel(box: OcrBoxPixel, index: number): OcrSidecarBox {
  const row = serializeBoxForPpocr(box);
  const out: OcrSidecarBox = {
    transcription: String(row.transcription ?? box.text ?? ''),
    points: row.points as [number, number][],
    difficult: Boolean(row.difficult),
  };
  if (box.score != null) out.score = box.score;
  if (box.auto != null) out.auto = box.auto;
  return out;
}

function pixelFromSidecarBox(row: OcrSidecarBox, index: number): OcrBoxPixel | null {
  const rawPts = row.points;
  if (!Array.isArray(rawPts) || rawPts.length < 3) return null;
  const points = normalizeQuadPoints(
    rawPts.map((p) => [Number(p[0]), Number(p[1])] as [number, number])
  );
  const text = String(row.transcription ?? '').trim();
  return {
    id: newOcrBoxId(),
    text: text || '###',
    points,
    difficult: Boolean(row.difficult),
    score: typeof row.score === 'number' ? row.score : undefined,
    auto: row.auto !== false,
  };
}

/** 이미지 옆 `.json` 사이드카 파싱 */
export function parseOcrSidecar(content: string): OcrBoxPixel[] {
  const trimmed = String(content || '').trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const file = parsed as Partial<OcrSidecarFile>;
  const rows = Array.isArray(file.boxes) ? file.boxes : [];
  const boxes: OcrBoxPixel[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    const box = pixelFromSidecarBox(row as OcrSidecarBox, i);
    if (box) boxes.push(box);
  }
  return boxes;
}

/** 이미지 옆 `.json` 사이드카 직렬화 */
export function serializeOcrSidecar(boxes: OcrBoxPixel[]): string {
  const payload: OcrSidecarFile = {
    version: OCR_SIDECAR_VERSION,
    boxes: boxes.map(sidecarBoxFromPixel),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
