import type { LabelMePolygonFile, LabelMePolygonShape, PolygonShapePixel } from './polygonTypes';
import { LABELME_JSON_VERSION } from './polygonTypes';

export function deriveJsonPath(imagePath: string): string {
  const slash = Math.max(imagePath.lastIndexOf('/'), imagePath.lastIndexOf('\\'));
  const dir = slash >= 0 ? imagePath.slice(0, slash) : '';
  const file = slash >= 0 ? imagePath.slice(slash + 1) : imagePath;
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const sep = imagePath.includes('\\') ? '\\' : '/';
  return dir ? `${dir}${sep}${base}.json` : `${base}.json`;
}

export function imageBasename(imagePath: string): string {
  const n = imagePath.replace(/\\/g, '/');
  const li = n.lastIndexOf('/');
  return li >= 0 ? n.slice(li + 1) : imagePath;
}

function toLabelMeShape(s: PolygonShapePixel): LabelMePolygonShape {
  return {
    label: s.label,
    text: '',
    points: s.points.map(([x, y]) => [x, y] as [number, number]),
    group_id: null,
    shape_type: 'polygon',
    flags: {},
  };
}

export function shapesToLabelMe(shapes: PolygonShapePixel[]): LabelMePolygonShape[] {
  return shapes.map(toLabelMeShape);
}

export function labelMeToShapes(shapes: LabelMePolygonShape[]): PolygonShapePixel[] {
  return shapes
    .filter((sh) => sh.shape_type === 'polygon' && Array.isArray(sh.points) && sh.points.length >= 3)
    .map((sh) => ({
      id: crypto.randomUUID(),
      label: sh.label || 'unknown',
      points: sh.points.map(([x, y]) => [Number(x), Number(y)] as [number, number]),
    }));
}

export function buildPolygonFile(
  imageFileName: string,
  imageWidth: number,
  imageHeight: number,
  shapes: PolygonShapePixel[]
): LabelMePolygonFile {
  return {
    version: LABELME_JSON_VERSION,
    flags: {},
    shapes: shapesToLabelMe(shapes),
    imagePath: imageFileName,
    imageData: null,
    imageHeight,
    imageWidth,
    text: '',
  };
}

export function serializePolygonFile(data: LabelMePolygonFile): string {
  return JSON.stringify(data, null, 2);
}

export function parsePolygonFileJson(text: string): { ok: true; data: LabelMePolygonFile } | { ok: false; error: string } {
  try {
    const o = JSON.parse(text) as LabelMePolygonFile;
    if (!o || typeof o !== 'object') return { ok: false, error: 'invalid root' };
    if (!Array.isArray(o.shapes)) return { ok: false, error: 'missing shapes' };
    return { ok: true, data: o };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function extractEditableShapes(file: LabelMePolygonFile): PolygonShapePixel[] {
  return labelMeToShapes(file.shapes as LabelMePolygonShape[]);
}
