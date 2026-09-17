import type { VlmDashboardSummary, YoloDashboardSummary } from './dashboardTypes';

const API = '/data-studio/api';
const DEFAULT_DETECTOR_ROOT = '/data/datasets/detector';
const DEFAULT_VLM_ROOT = '/data/datasets/vlm';

export interface FolderListEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

export async function fetchFolderEntries(folderPath: string): Promise<FolderListEntry[]> {
  const response = await fetch(`${API}/fs/list?path=${encodeURIComponent(folderPath)}`);
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      message = body.error || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  const data = (await response.json()) as { entries?: FolderListEntry[] };
  return data.entries ?? [];
}

export async function fetchYoloDashboard(detectorRoot = DEFAULT_DETECTOR_ROOT): Promise<YoloDashboardSummary> {
  if (typeof window !== 'undefined' && window.electron?.scanYoloDashboard) {
    return window.electron.scanYoloDashboard(detectorRoot);
  }
  const response = await fetch(`${API}/dashboard/yolo-summary?root=${encodeURIComponent(detectorRoot)}`);
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      message = body.error || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return response.json() as Promise<YoloDashboardSummary>;
}

export async function fetchVlmDashboard(vlmRoot = DEFAULT_VLM_ROOT): Promise<VlmDashboardSummary> {
  if (typeof window !== 'undefined' && window.electron?.scanVlmDashboard) {
    return window.electron.scanVlmDashboard(vlmRoot);
  }
  const response = await fetch(`${API}/dashboard/vlm-summary?root=${encodeURIComponent(vlmRoot)}`);
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      message = body.error || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return response.json() as Promise<VlmDashboardSummary>;
}

export { DEFAULT_DETECTOR_ROOT, DEFAULT_VLM_ROOT };
