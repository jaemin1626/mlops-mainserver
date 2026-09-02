import type {
  LandmarkAnnotationFile,
  LandmarkBndbox,
  LandmarkObjectPixel,
  LandmarkPoint,
} from './landmarkTypes';
import { LANDMARK_POINT_COUNT } from './landmarkTypes';

export function deriveXmlPath(imagePath: string): string {
  const slash = Math.max(imagePath.lastIndexOf('/'), imagePath.lastIndexOf('\\'));
  const dir = slash >= 0 ? imagePath.slice(0, slash) : '';
  const file = slash >= 0 ? imagePath.slice(slash + 1) : imagePath;
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const sep = imagePath.includes('\\') ? '\\' : '/';
  return dir ? `${dir}${sep}${base}.xml` : `${base}.xml`;
}

export function imageBasename(imagePath: string): string {
  const n = imagePath.replace(/\\/g, '/');
  const li = n.lastIndexOf('/');
  return li >= 0 ? n.slice(li + 1) : imagePath;
}

function fmtCoord(n: number): string {
  return Number(n).toFixed(3);
}

export function bndboxFromCorners(xmin: number, ymin: number, xmax: number, ymax: number): LandmarkBndbox {
  const left = Math.min(xmin, xmax);
  const right = Math.max(xmin, xmax);
  const top = Math.min(ymin, ymax);
  const bottom = Math.max(ymin, ymax);
  return { xmin: left, ymin: top, xmax: right, ymax: bottom };
}

export function cornerPointsFromBndbox(box: LandmarkBndbox): LandmarkPoint[] {
  const { xmin, ymin, xmax, ymax } = box;
  return [
    { index: 0, x: xmin, y: ymin },
    { index: 1, x: xmax, y: ymin },
    { index: 2, x: xmax, y: ymax },
    { index: 3, x: xmin, y: ymax },
  ];
}

export function syncBndboxFromPoints(obj: LandmarkObjectPixel): LandmarkObjectPixel {
  if (!obj.points.length) return obj;
  const xs = obj.points.map((p) => p.x);
  const ys = obj.points.map((p) => p.y);
  return {
    ...obj,
    bndbox: {
      xmin: Math.min(...xs),
      ymin: Math.min(...ys),
      xmax: Math.max(...xs),
      ymax: Math.max(...ys),
    },
  };
}

export function newLandmarkObjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `lm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createLandmarkObject(
  index: number,
  name: string,
  box: LandmarkBndbox,
  type: string = 'Normal'
): LandmarkObjectPixel {
  return {
    id: newLandmarkObjectId(),
    index,
    name,
    type,
    bndbox: { ...box },
    points: cornerPointsFromBndbox(box),
  };
}

function parsePointEntry(tag: string, text: string): LandmarkPoint | null {
  const m = tag.match(/^p(\d+)$/i);
  if (!m) return null;
  const parts = text.split(',').map((s) => Number(s.trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return { index: Number(m[1]), x: parts[0]!, y: parts[1]! };
}

function readText(el: Element | null): string {
  return (el?.textContent ?? '').trim();
}

function readNum(el: Element | null): number {
  return Number(readText(el));
}

export function parseLandmarkXml(text: string): { ok: true; data: LandmarkAnnotationFile } | { ok: false; error: string } {
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) return { ok: false, error: parseErr.textContent || 'XML parse error' };

    const root = doc.querySelector('Annotation');
    if (!root) return { ok: false, error: 'missing Annotation root' };

    const filename = readText(root.querySelector('filename'));
    const objectEls = Array.from(root.querySelectorAll('object'));
    const objects: LandmarkObjectPixel[] = [];

    objectEls.forEach((objEl, i) => {
      const bndEl = objEl.querySelector('bndbox');
      if (!bndEl) return;

      const bndbox: LandmarkBndbox = {
        xmin: readNum(bndEl.querySelector('xmin')),
        ymin: readNum(bndEl.querySelector('ymin')),
        xmax: readNum(bndEl.querySelector('xmax')),
        ymax: readNum(bndEl.querySelector('ymax')),
      };

      const points: LandmarkPoint[] = [];
      const pointsEl = objEl.querySelector('points');
      if (pointsEl) {
        for (const child of Array.from(pointsEl.children)) {
          const pt = parsePointEntry(child.tagName, readText(child));
          if (pt) points.push(pt);
        }
      }
      points.sort((a, b) => a.index - b.index);

      if (points.length === 0) {
        points.push(...cornerPointsFromBndbox(bndbox));
      }

      const indexRaw = readText(objEl.querySelector('index'));
      const index = indexRaw !== '' && Number.isFinite(Number(indexRaw)) ? Number(indexRaw) : i;

      objects.push({
        id: newLandmarkObjectId(),
        index,
        name: readText(objEl.querySelector('name')) || 'unknown',
        type: readText(objEl.querySelector('type')) || 'Normal',
        bndbox,
        points,
      });
    });

    return { ok: true, data: { filename, objects } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function serializeLandmarkXml(file: LandmarkAnnotationFile): string {
  const lines: string[] = ['<?xml version="1.0" ?>', '<Annotation>'];
  lines.push(`  <filename>${escapeXml(file.filename)}</filename>`);

  const sorted = [...file.objects].sort((a, b) => a.index - b.index);
  for (const obj of sorted) {
    const synced = syncBndboxFromPoints(obj);
    const { bndbox } = synced;
    const points = [...synced.points].sort((a, b) => a.index - b.index);

    lines.push('  <object>');
    lines.push(`    <index>${obj.index}</index>`);
    lines.push(`    <name>${escapeXml(obj.name)}</name>`);
    lines.push('    <bndbox>');
    lines.push(`      <xmin>${fmtCoord(bndbox.xmin)}</xmin>`);
    lines.push(`      <ymin>${fmtCoord(bndbox.ymin)}</ymin>`);
    lines.push(`      <xmax>${fmtCoord(bndbox.xmax)}</xmax>`);
    lines.push(`      <ymax>${fmtCoord(bndbox.ymax)}</ymax>`);
    lines.push('    </bndbox>');
    lines.push('    <points>');
    for (let i = 0; i < LANDMARK_POINT_COUNT; i++) {
      const pt = points.find((p) => p.index === i) ?? points[i];
      if (!pt) continue;
      lines.push(`      <p${i}>${fmtCoord(pt.x)},${fmtCoord(pt.y)}</p${i}>`);
    }
    lines.push('    </points>');
    lines.push(`    <type>${escapeXml(obj.type || 'Normal')}</type>`);
    lines.push('  </object>');
  }

  lines.push('</Annotation>');
  return lines.join('\n');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildLandmarkFile(filename: string, objects: LandmarkObjectPixel[]): LandmarkAnnotationFile {
  return { filename, objects };
}

export function extractEditableObjects(file: LandmarkAnnotationFile): LandmarkObjectPixel[] {
  return file.objects.map((o) => ({
    ...o,
    points: o.points.map((p) => ({ ...p })),
    bndbox: { ...o.bndbox },
  }));
}
