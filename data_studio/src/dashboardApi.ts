import type { YoloDashboardSummary } from './dashboardTypes';

const API = '/data-studio/api';
const DEFAULT_DETECTOR_ROOT = '/data/datasets/detector';

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

export { DEFAULT_DETECTOR_ROOT };
