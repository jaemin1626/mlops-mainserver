/** LabelMe / polygon_sample.json 호환 스키마 */

export const LABELME_JSON_VERSION = '0.4.8';

export interface LabelMePolygonShape {
  label: string;
  text: string;
  points: [number, number][];
  group_id: null;
  shape_type: 'polygon';
  flags: Record<string, unknown>;
}

export interface LabelMePolygonFile {
  version: string;
  flags: Record<string, unknown>;
  shapes: LabelMePolygonShape[];
  imagePath: string;
  imageData: null;
  imageHeight: number;
  imageWidth: number;
  text: string;
}

/** 편집용: 이미지 픽셀 좌표 */
export interface PolygonShapePixel {
  id: string;
  label: string;
  points: [number, number][];
}
