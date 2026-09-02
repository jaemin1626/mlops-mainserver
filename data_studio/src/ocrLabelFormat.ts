import type { OcrBoxPixel } from './ocrTypes';
import { normalizeQuadPoints } from './ocrTypes';

export type PpocrLabelEntry = {
  /** Label.txt 키 — 작업 폴더 기준 상대 경로 (예: test2_ko/tt2/foo.jpg) */
  imageKey: string;
  boxes: OcrBoxPixel[];
};

/** 작업 폴더에 대한 상대 경로 (scanFolder item.name) */
export function labelImageKeyFromRelative(relativePath: string): string {
  return normalizeImageKey(relativePath);
}

/** PPOCRLabel getImglabelidx — 구형 Label.txt 호환용 (마지막 2 path segment) */
export function ppocrLabelImageKey(imagePath: string): string {
  const normalized = normalizeImageKey(imagePath);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) return normalized;
  const lastTwo = parts.slice(-2);
  return `${lastTwo[0]}/${lastTwo[1]}`;
}

function lastTwoPathSegments(key: string): string | null {
  const parts = normalizeImageKey(key).split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function roundPoints(points: [number, number][]): [number, number][] {
  return points.map((p) => [Math.round(p[0]), Math.round(p[1])] as [number, number]);
}

/** PPOCRLabel json.dumps(…, ensure_ascii=False) 한 박스 문자열 */
export function serializePpocrBoxJson(box: OcrBoxPixel): string {
  const pts = roundPoints(box.points)
    .map((p) => `[${p[0]}, ${p[1]}]`)
    .join(', ');
  const transcription = JSON.stringify(box.text);
  return `{"transcription": ${transcription}, "points": [${pts}], "difficult": false}`;
}

/** 한 이미지의 박스 배열 — 콤마로 연결된 JSON 배열 */
export function serializePpocrLabelArray(boxes: OcrBoxPixel[]): string {
  return `[${boxes.map(serializePpocrBoxJson).join(', ')}]`;
}

export function serializeBoxForPpocr(box: OcrBoxPixel): Record<string, unknown> {
  return {
    transcription: box.text,
    points: roundPoints(box.points),
    difficult: false,
  };
}

export function parsePpocrLabelLine(line: string): { imageKey: string; boxes: OcrBoxPixel[] } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const tab = trimmed.indexOf('\t');
  if (tab < 0) return null;
  const imageKey = trimmed.slice(0, tab).trim().replace(/\\/g, '/');
  const jsonPart = trimmed.slice(tab + 1).trim();
  if (!imageKey || !jsonPart) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(jsonPart);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const boxes: OcrBoxPixel[] = [];
  for (let i = 0; i < arr.length; i++) {
    const row = arr[i];
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const rawPts = r.points as [number, number][];
    if (!Array.isArray(rawPts) || rawPts.length < 3) continue;
    const points = normalizeQuadPoints(
      rawPts.map((p) => [Number(p[0]), Number(p[1])] as [number, number])
    );
    const text = String(r.transcription ?? r.text ?? '').trim();
    boxes.push({
      id: `ppocr_${i}_${imageKey}`,
      text: text || '###',
      points,
      difficult: Boolean(r.difficult),
      auto: true,
    });
  }
  return { imageKey, boxes };
}

export function parsePpocrLabelFile(content: string): Map<string, OcrBoxPixel[]> {
  const map = new Map<string, OcrBoxPixel[]>();
  for (const line of content.split(/\r?\n/)) {
    const parsed = parsePpocrLabelLine(line);
    if (!parsed) continue;
    map.set(normalizeImageKey(parsed.imageKey), parsed.boxes);
  }
  return map;
}

export function normalizeImageKey(key: string): string {
  return String(key || '').trim().replace(/\\/g, '/');
}

export function imageLookupKeys(imagePath: string, imageName: string): string[] {
  const name = normalizeImageKey(imageName);
  const full = normalizeImageKey(imagePath);
  const base = name.split('/').pop() || name;
  const ppocrKey = ppocrLabelImageKey(imagePath);
  const lastTwoFromName = lastTwoPathSegments(name);
  const keys = new Set<string>([name, base, full, ppocrKey]);
  if (lastTwoFromName) keys.add(lastTwoFromName);
  const winFull = full.replace(/\//g, '\\');
  if (winFull !== full) keys.add(winFull);
  return [...keys];
}

export function lookupBoxesForImage(
  map: Map<string, OcrBoxPixel[]>,
  imagePath: string,
  imageName: string
): OcrBoxPixel[] | undefined {
  for (const k of imageLookupKeys(imagePath, imageName)) {
    const hit = map.get(k);
    if (hit) {
      return hit.map((b) => ({
        ...b,
        points: b.points.map((p) => [p[0], p[1]] as [number, number]),
      }));
    }
  }
  const name = normalizeImageKey(imageName);
  const base = name.split('/').pop() || name;
  for (const [mapKey, boxes] of map) {
    const mk = normalizeImageKey(mapKey);
    if (mk === name || mk.endsWith(`/${name}`)) {
      return boxes.map((b) => ({
        ...b,
        points: b.points.map((p) => [p[0], p[1]] as [number, number]),
      }));
    }
    const lastTwo = lastTwoPathSegments(name);
    if (lastTwo && (mk === lastTwo || mk.endsWith(`/${lastTwo}`))) {
      return boxes.map((b) => ({
        ...b,
        points: b.points.map((p) => [p[0], p[1]] as [number, number]),
      }));
    }
    if (mk === base && !name.includes('/')) {
      return boxes.map((b) => ({
        ...b,
        points: b.points.map((p) => [p[0], p[1]] as [number, number]),
      }));
    }
  }
  return undefined;
}

export function buildPpocrLabelFileContent(entries: PpocrLabelEntry[]): string {
  const lines: string[] = [];
  const sorted = [...entries].sort((a, b) => a.imageKey.localeCompare(b.imageKey, undefined, { numeric: true }));
  for (const entry of sorted) {
    if (!entry.imageKey || entry.boxes.length === 0) continue;
    lines.push(`${entry.imageKey}\t${serializePpocrLabelArray(entry.boxes)}`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
