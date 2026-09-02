/** Landmark XML annotation — 편집용 픽셀 좌표 모델 (web 포팅 공유) */

export const LANDMARK_POINT_COUNT = 4;

export interface LandmarkBndbox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export interface LandmarkPoint {
  /** 0-based, XML pN 과 동일 */
  index: number;
  x: number;
  y: number;
}

export interface LandmarkObjectPixel {
  id: string;
  /** XML object.index */
  index: number;
  name: string;
  type: string;
  bndbox: LandmarkBndbox;
  points: LandmarkPoint[];
}

export interface LandmarkAnnotationFile {
  filename: string;
  objects: LandmarkObjectPixel[];
}

export const DEFAULT_LANDMARK_TYPES = ['Normal'] as const;

export const DEFAULT_LANDMARK_LABEL = 'plate';
