export interface OfflineImageItem {
  name: string;
  imagePath: string;
  txtPath: string;
  /** OCR 사이드카 — 이미지와 같은 경로·베이스명 `.json` */
  jsonPath: string;
  imageUrl: string;
}

export interface ReadJsonFileResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface OcrDetectBox {
  text: string;
  score?: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  points?: [number, number][];
}

export interface OcrBatchDetectItem {
  imagePath: string;
  ok: boolean;
  error?: string;
  boxes?: OcrDetectBox[];
  predictMs?: number;
}

export type OcrModelPreset = 'mobile' | 'server' | 'v6_tiny';

export interface OcrDetectOptions {
  minTextLen: number;
  minBoxSize: number;
}

export interface OcrWorkerResult {
  ok: boolean;
  error?: string;
  ready?: boolean;
  boxes?: OcrDetectBox[];
  text?: string;
  score?: number;
  device?: string;
  gpuAvailable?: boolean;
  runningOnCpu?: boolean;
  deviceWarning?: string | null;
  detModel?: string;
  recModel?: string;
  modelPreset?: OcrModelPreset;
  modelLabel?: string;
  detectOptions?: OcrDetectOptions;
  loadMs?: number;
  predictMs?: number;
  results?: OcrBatchDetectItem[];
  totalPredictMs?: number;
  count?: number;
}

declare global {
  interface Window {
    __DATA_STUDIO_WEB__?: boolean;
    electron?: {
      openFolderDialog: (opts?: { initialPath?: string }) => Promise<string | null>;
      setWorkspaceRoot: (path: string | null) => Promise<boolean>;
      /** VLM 미디어 상대 경로 기준 폴더 (null = JSON 폴더 자동) */
      setMediaBaseRoot: (path: string | null) => Promise<boolean>;
      getMediaBaseRoot: () => Promise<string | null>;
      scanFolder: (path: string) => Promise<OfflineImageItem[]>;
      readTxt: (path: string) => Promise<string>;
      writeTxt: (path: string, content: string) => Promise<boolean>;
      openLabelFileDialog: () => Promise<string | null>;
      readLabelFile: (path: string) => Promise<string>;
      showItemInFolder: (path: string) => Promise<void>;
      deleteImageAndTxt: (
        imagePath: string,
        txtPath: string,
        jsonPath?: string
      ) => Promise<{ ok: boolean; error?: string }>;
      deleteImagePolygonJson: (imagePath: string, jsonPath: string) => Promise<{ ok: boolean; error?: string }>;
      openJsonFileDialog: () => Promise<string | null>;
      saveJsonFileDialog: (defaultPath?: string) => Promise<string | null>;
      readJsonFile: (path: string) => Promise<ReadJsonFileResult>;
      writeJsonFile: (path: string, content: string) => Promise<boolean>;
      ocrInit: (
        lang?: string,
        modelPreset?: OcrModelPreset,
        detectOptions?: OcrDetectOptions
      ) => Promise<OcrWorkerResult>;
      ocrDetectRecognize: (
        imagePath: string,
        lang?: string,
        detectOptions?: OcrDetectOptions
      ) => Promise<OcrWorkerResult>;
      ocrBatchDetect: (
        imagePaths: string[],
        lang?: string,
        detectOptions?: OcrDetectOptions
      ) => Promise<OcrWorkerResult>;
      ocrRecognizeQuad: (imagePath: string, points: [number, number][], lang?: string) => Promise<OcrWorkerResult>;
    };
  }
}

export {};
