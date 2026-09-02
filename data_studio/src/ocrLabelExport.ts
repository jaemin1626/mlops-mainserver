/**
 * PPOCRLabel 학습용 Label.txt 통합 export.
 * 작업 폴더의 이미지별 `.json` 사이드카를 읽어 단일 Label.txt 로 만든다.
 * (UI 연동은 별도 — 형식·경로 규칙은 여기서 고정)
 */
import type { ReadJsonFileResult } from './electron.d';
import {
  buildPpocrLabelFileContent,
  labelImageKeyFromRelative,
  type PpocrLabelEntry,
} from './ocrLabelFormat';
import { parseOcrSidecar } from './ocrSidecarFormat';
import type { OfflineImageItem } from './electron.d';
import { cloneOcrBoxes } from './ocrTypes';

export type CollectSidecarOptions = {
  /** 박스 없는 이미지는 Label.txt 에서 제외 (PPOCRLabel 기본) */
  skipEmpty?: boolean;
};

/**
 * scanFolder 항목 + json 사이드카 → PPOCRLabel entries.
 * imageKey = 작업 루트 기준 상대 경로 (예: sub/foo.jpg)
 */
export async function collectPpocrEntriesFromSidecars(
  items: OfflineImageItem[],
  readJson: (path: string) => Promise<ReadJsonFileResult>,
  options: CollectSidecarOptions = {}
): Promise<PpocrLabelEntry[]> {
  const skipEmpty = options.skipEmpty !== false;
  const entries: PpocrLabelEntry[] = [];
  const used = new Set<string>();

  for (const item of items) {
    const imageKey = labelImageKeyFromRelative(item.name);
    if (used.has(imageKey)) continue;
    used.add(imageKey);

    const res = await readJson(item.jsonPath);
    const boxes = res.ok && res.text ? parseOcrSidecar(res.text) : [];
    if (skipEmpty && boxes.length === 0) continue;
    entries.push({ imageKey, boxes: cloneOcrBoxes(boxes) });
  }

  return entries;
}

/** 학습용 Label.txt 본문 (탭 구분, PPOCRLabel 호환) */
export async function buildPpocrLabelTxtFromSidecars(
  items: OfflineImageItem[],
  readJson: (path: string) => Promise<ReadJsonFileResult>,
  options?: CollectSidecarOptions
): Promise<string> {
  const entries = await collectPpocrEntriesFromSidecars(items, readJson, options);
  return buildPpocrLabelFileContent(entries);
}

export const PPOCR_LABEL_TXT_FILENAME = 'Label.txt';

export function labelTxtPathForRoot(rootDir: string): string {
  const trimmed = rootDir.replace(/[/\\]+$/, '');
  const sep = trimmed.includes('\\') ? '\\' : '/';
  return `${trimmed}${sep}${PPOCR_LABEL_TXT_FILENAME}`;
}

export type ExportPpocrLabelTxtResult = {
  ok: boolean;
  labelPath: string;
  imageCount: number;
  labeledImageCount: number;
  boxCount: number;
  error?: string;
};

/** 루트 폴더 스캔 → 사이드카 수집 → `{root}/Label.txt` 저장 */
export async function exportPpocrLabelTxtFromFolder(
  rootDir: string,
  scanFolder: (path: string) => Promise<OfflineImageItem[]>,
  readJson: (path: string) => Promise<ReadJsonFileResult>,
  writeTxt: (path: string, content: string) => Promise<boolean>,
  options?: CollectSidecarOptions
): Promise<ExportPpocrLabelTxtResult> {
  const labelPath = labelTxtPathForRoot(rootDir);
  const items = await scanFolder(rootDir);
  if (items.length === 0) {
    return {
      ok: false,
      labelPath,
      imageCount: 0,
      labeledImageCount: 0,
      boxCount: 0,
      error: '폴더에 이미지가 없습니다.',
    };
  }

  const entries = await collectPpocrEntriesFromSidecars(items, readJson, options);
  const labeledImageCount = entries.length;
  const boxCount = entries.reduce((sum, e) => sum + e.boxes.length, 0);
  if (labeledImageCount === 0) {
    return {
      ok: false,
      labelPath,
      imageCount: items.length,
      labeledImageCount: 0,
      boxCount: 0,
      error: '박스가 있는 JSON 라벨이 없습니다.',
    };
  }

  const content = buildPpocrLabelFileContent(entries);
  const ok = await writeTxt(labelPath, content);
  if (!ok) {
    return {
      ok: false,
      labelPath,
      imageCount: items.length,
      labeledImageCount,
      boxCount,
      error: 'Label.txt 저장에 실패했습니다.',
    };
  }

  return {
    ok: true,
    labelPath,
    imageCount: items.length,
    labeledImageCount,
    boxCount,
  };
}
