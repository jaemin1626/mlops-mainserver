import type { OfflineImageItem, ReadJsonFileResult } from './electron.d';
import { getWebMediaBaseRoot, setWebMediaBaseRoot, setWebWorkspaceRoot } from './webMediaBase';

const API = '/data-studio/api';

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      message = body.error || message;
    } catch {
      // The response did not contain a JSON error body.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function pickFolder(initialPath?: string, pickerRoot?: string): Promise<string | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent('data-studio:pick-folder', {
        detail: {
          mode: 'dir',
          initialPath,
          pickerRoot,
          done: (path: string | null) => resolve(path),
        },
      })
    );
  });
}

function pickJson(initialPath?: string): Promise<string | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent('data-studio:pick-folder', {
        detail: {
          mode: 'json',
          initialPath,
          done: (path: string | null) => resolve(path),
        },
      })
    );
  });
}

function pickSaveName(directory: string, defaultName?: string): Promise<string | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent('data-studio:pick-folder', {
        detail: {
          mode: 'save-name',
          directory,
          defaultName,
          done: (path: string | null) => resolve(path),
        },
      })
    );
  });
}

function pickLabel(initialPath?: string, pickerRoot?: string): Promise<string | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent('data-studio:pick-label', {
        detail: {
          mode: 'label',
          initialPath,
          pickerRoot,
          done: (path: string | null) => resolve(path),
        },
      })
    );
  });
}

export function installWebFsBridge(): void {
  if (typeof window === 'undefined' || window.electron) return;

  window.__DATA_STUDIO_WEB__ = true;
  let workspaceRoot: string | null = null;

  window.electron = {
    openFolderDialog: (opts) => pickFolder(opts?.initialPath, opts?.pickerRoot),
    openLabelFileDialog: (opts) => pickLabel(opts?.initialPath, opts?.pickerRoot),
    setWorkspaceRoot: async (path) => {
      workspaceRoot = path;
      setWebWorkspaceRoot(path);
      return true;
    },
    setMediaBaseRoot: async (path) => {
      setWebMediaBaseRoot(path);
      return true;
    },
    getMediaBaseRoot: async () => getWebMediaBaseRoot(),
    scanYoloDashboard: async (detectorRoot) => {
      return apiJson(`${API}/dashboard/yolo-summary?root=${encodeURIComponent(detectorRoot || '/data/datasets/detector')}`);
    },
    scanVlmDashboard: async (vlmRoot) => {
      return apiJson(`${API}/dashboard/vlm-summary?root=${encodeURIComponent(vlmRoot || '/data/datasets/vlm')}`);
    },
    scanFolder: async (dirPath) => {
      const data = await apiJson<{ items: OfflineImageItem[] }>(
        `${API}/fs/images?path=${encodeURIComponent(dirPath)}`
      );
      return data.items;
    },
    scanMediaFolder: async (dirPath) => {
      const data = await apiJson<{ items: OfflineImageItem[] }>(
        `${API}/fs/media?path=${encodeURIComponent(dirPath)}`
      );
      return data.items;
    },
    readTxt: async (filePath) => {
      const response = await fetch(`${API}/fs/file?path=${encodeURIComponent(filePath)}`);
      if (response.status === 404) return '';
      if (!response.ok) throw new Error('readTxt failed');
      return response.text();
    },
    writeTxt: async (filePath, content) => {
      try {
        const data = await apiJson<{ ok: boolean }>(`${API}/fs/file`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, content }),
        });
        return Boolean(data.ok);
      } catch {
        return false;
      }
    },
    readLabelFile: async (filePath) => {
      const response = await fetch(`${API}/fs/file?path=${encodeURIComponent(filePath)}`);
      if (!response.ok) throw new Error('readLabelFile failed');
      return response.text();
    },
    showItemInFolder: async () => undefined,
    deleteImageAndTxt: async () => ({ ok: false, error: 'not supported in web v1' }),
    deleteImagePolygonJson: async () => ({ ok: false, error: 'not supported in web v1' }),
    openJsonFileDialog: () => pickJson('/data/datasets'),
    saveJsonFileDialog: async (defaultPath) => {
      const full = String(defaultPath || '');
      const separatorIndex = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
      const directory = separatorIndex >= 0 ? full.slice(0, separatorIndex) : '/data/datasets';
      const defaultName = separatorIndex >= 0 ? full.slice(separatorIndex + 1) : 'export.json';
      return pickSaveName(directory, defaultName);
    },
    readJsonFile: async (filePath): Promise<ReadJsonFileResult> => {
      try {
        const response = await fetch(`${API}/fs/file?path=${encodeURIComponent(filePath)}`);
        if (!response.ok) return { ok: false, error: response.statusText };
        return { ok: true, text: await response.text() };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
    writeJsonFile: async (filePath, content) => {
      try {
        const data = await apiJson<{ ok: boolean }>(`${API}/fs/file`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, content }),
        });
        return Boolean(data.ok);
      } catch {
        return false;
      }
    },
    ocrInit: async () => ({ ok: false, error: 'ocr not in web v1' }),
    ocrDetectRecognize: async () => ({ ok: false, error: 'ocr not in web v1' }),
    ocrBatchDetect: async () => ({ ok: false, error: 'ocr not in web v1' }),
    ocrRecognizeQuad: async () => ({ ok: false, error: 'ocr not in web v1' }),
  };

  void workspaceRoot;
}
