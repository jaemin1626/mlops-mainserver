import type { YoloWorkflowRole, YoloWorkflowStatus } from './yoloMeta';

export type WorkflowNavPromptKind = 'worker_submit' | 'reviewer_approve';

export interface WorkflowNavPrompt {
  kind: WorkflowNavPromptKind;
  targetIndex: number;
}

export function shouldPromptWorkerSubmit(role: YoloWorkflowRole, status: YoloWorkflowStatus): boolean {
  return role === 'worker' && (status === 'draft' || status === 'rejected');
}

export function shouldPromptReviewerApprove(role: YoloWorkflowRole, status: YoloWorkflowStatus): boolean {
  return role === 'reviewer' && status === 'submitted';
}

export function resolveNavPrompt(
  role: YoloWorkflowRole,
  status: YoloWorkflowStatus | null | undefined,
  targetIndex: number
): WorkflowNavPrompt | null {
  if (!status) return null;
  if (shouldPromptWorkerSubmit(role, status)) {
    return { kind: 'worker_submit', targetIndex };
  }
  if (shouldPromptReviewerApprove(role, status)) {
    return { kind: 'reviewer_approve', targetIndex };
  }
  return null;
}
