export interface OcrDetectOptions {
  /** 인식 텍스트 최소 글자 수 (1이면 1글자 박스도 유지) */
  minTextLen: number;
  /** 검출 박스 최소 가로·세로 (px) */
  minBoxSize: number;
}

export const DEFAULT_OCR_DETECT_OPTIONS: OcrDetectOptions = {
  minTextLen: 2,
  minBoxSize: 5,
};

const DETECT_OPTIONS_LS = 'intellivixOcr.detectOptionsV1';

export function clampOcrDetectOptions(
  raw: Partial<OcrDetectOptions> | null | undefined
): OcrDetectOptions {
  const minTextLen =
    typeof raw?.minTextLen === 'number' && Number.isFinite(raw.minTextLen)
      ? Math.min(32, Math.max(1, Math.round(raw.minTextLen)))
      : DEFAULT_OCR_DETECT_OPTIONS.minTextLen;
  const minBoxSize =
    typeof raw?.minBoxSize === 'number' && Number.isFinite(raw.minBoxSize)
      ? Math.min(512, Math.max(1, Math.round(raw.minBoxSize)))
      : DEFAULT_OCR_DETECT_OPTIONS.minBoxSize;
  return { minTextLen, minBoxSize };
}

export function loadOcrDetectOptions(): OcrDetectOptions {
  try {
    const raw = localStorage.getItem(DETECT_OPTIONS_LS);
    if (!raw) return { ...DEFAULT_OCR_DETECT_OPTIONS };
    return clampOcrDetectOptions(JSON.parse(raw) as Partial<OcrDetectOptions>);
  } catch {
    return { ...DEFAULT_OCR_DETECT_OPTIONS };
  }
}

export function saveOcrDetectOptions(opts: OcrDetectOptions): void {
  try {
    localStorage.setItem(DETECT_OPTIONS_LS, JSON.stringify(clampOcrDetectOptions(opts)));
  } catch {
    /* ignore */
  }
}
