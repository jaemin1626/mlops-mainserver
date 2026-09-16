import type { YoloWorkflowRole, YoloWorkflowStatus } from './yoloMeta';

export interface YoloFolderStats {
  folderPath: string;
  folderName: string;
  totalImages: number;
  labeledImages: number;
  labelRate: number;
  byStatus: Record<YoloWorkflowStatus, number>;
}

export interface YoloRecentChange {
  folderPath: string;
  folderName: string;
  imagePath: string;
  imageName: string;
  revision: number;
  at: string;
  by: string;
  role: YoloWorkflowRole;
  action: string;
  summary: string;
}

export interface YoloDashboardTotals {
  totalImages: number;
  labeledImages: number;
  labelRate: number;
  byStatus: Record<YoloWorkflowStatus, number>;
  pendingReview: number;
  rejected: number;
}

export interface YoloDashboardSummary {
  scannedAt: string;
  detectorRoot: string;
  folders: YoloFolderStats[];
  recentChanges: YoloRecentChange[];
  totals: YoloDashboardTotals;
}

export interface YoloLaunchRequest {
  folderPath: string;
  statusFilter?: YoloWorkflowStatus;
}

/** VLM 작업 화면 딥링크 — YOLO와 동일 형식 */
export type VlmLaunchRequest = YoloLaunchRequest;
