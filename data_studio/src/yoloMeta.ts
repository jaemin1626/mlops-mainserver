import type { ReadJsonFileResult } from './electron';

export type YoloWorkflowStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type YoloWorkflowRole = 'worker' | 'reviewer';
export type YoloChangeAction = 'label_save' | 'submit' | 'approve' | 'reject' | 'resubmit';

export interface YoloReviewInfo {
  status: 'none' | 'pending' | 'approved' | 'rejected';
  inspector: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
}

export interface YoloChangeEntry {
  revision: number;
  at: string;
  by: string;
  role: YoloWorkflowRole;
  action: YoloChangeAction;
  summary: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface YoloImageMeta {
  schemaVersion: 1;
  workflowStatus: YoloWorkflowStatus;
  worker: string | null;
  submittedAt: string | null;
  review: YoloReviewInfo;
  currentRevision: number;
  changeHistory: YoloChangeEntry[];
}

const WORKFLOW_STATUSES: YoloWorkflowStatus[] = ['draft', 'submitted', 'approved', 'rejected'];

function isoNow(): string {
  return new Date().toISOString();
}

export function createDefaultYoloMeta(): YoloImageMeta {
  return {
    schemaVersion: 1,
    workflowStatus: 'draft',
    worker: null,
    submittedAt: null,
    review: {
      status: 'none',
      inspector: null,
      reviewedAt: null,
      rejectReason: null,
    },
    currentRevision: 0,
    changeHistory: [],
  };
}

/** YOLO 이미지·VLM 미디어 공통 — `{stem}.meta.json` 은 미디어와 같은 폴더 */
export function yoloMetaPathForImage(imagePath: string): string {
  const normalized = String(imagePath || '').replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const file = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
  const dot = file.lastIndexOf('.');
  const stem = dot >= 0 ? file.slice(0, dot) : file;
  return dir ? `${dir}/${stem}.meta.json` : `${stem}.meta.json`;
}

function isWorkflowStatus(value: unknown): value is YoloWorkflowStatus {
  return typeof value === 'string' && WORKFLOW_STATUSES.includes(value as YoloWorkflowStatus);
}

export function parseYoloMeta(text: string): YoloImageMeta {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid meta');
  }
  const base = createDefaultYoloMeta();
  const reviewRaw = raw.review as Record<string, unknown> | undefined;
  return {
    ...base,
    workflowStatus: isWorkflowStatus(raw.workflowStatus) ? raw.workflowStatus : base.workflowStatus,
    worker: typeof raw.worker === 'string' ? raw.worker : raw.worker === null ? null : base.worker,
    submittedAt:
      typeof raw.submittedAt === 'string' ? raw.submittedAt : raw.submittedAt === null ? null : base.submittedAt,
    currentRevision:
      typeof raw.currentRevision === 'number' && Number.isFinite(raw.currentRevision)
        ? Math.max(0, Math.floor(raw.currentRevision))
        : base.currentRevision,
    review: {
      status: ['none', 'pending', 'approved', 'rejected'].includes(String(reviewRaw?.status))
        ? (reviewRaw!.status as YoloReviewInfo['status'])
        : base.review.status,
      inspector:
        typeof reviewRaw?.inspector === 'string'
          ? reviewRaw.inspector
          : reviewRaw?.inspector === null
            ? null
            : base.review.inspector,
      reviewedAt:
        typeof reviewRaw?.reviewedAt === 'string'
          ? reviewRaw.reviewedAt
          : reviewRaw?.reviewedAt === null
            ? null
            : base.review.reviewedAt,
      rejectReason:
        typeof reviewRaw?.rejectReason === 'string'
          ? reviewRaw.rejectReason
          : reviewRaw?.rejectReason === null
            ? null
            : base.review.rejectReason,
    },
    changeHistory: Array.isArray(raw.changeHistory)
      ? raw.changeHistory
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
          .map((entry) => ({
            revision: typeof entry.revision === 'number' ? entry.revision : 0,
            at: typeof entry.at === 'string' ? entry.at : isoNow(),
            by: typeof entry.by === 'string' ? entry.by : '',
            role: entry.role === 'reviewer' ? 'reviewer' : 'worker',
            action: (['label_save', 'submit', 'approve', 'reject', 'resubmit'] as const).includes(
              entry.action as YoloChangeAction
            )
              ? (entry.action as YoloChangeAction)
              : 'label_save',
            summary: typeof entry.summary === 'string' ? entry.summary : '',
            before: entry.before && typeof entry.before === 'object' ? (entry.before as Record<string, unknown>) : {},
            after: entry.after && typeof entry.after === 'object' ? (entry.after as Record<string, unknown>) : {},
          }))
      : [],
  };
}

export function serializeYoloMeta(meta: YoloImageMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

export function canEditLabels(role: YoloWorkflowRole, status: YoloWorkflowStatus): boolean {
  if (role === 'reviewer') return false;
  return status === 'draft' || status === 'rejected' || status === 'submitted';
}

export function workflowStatusLabel(status: YoloWorkflowStatus): string {
  switch (status) {
    case 'draft':
      return '작업중';
    case 'submitted':
      return '검수대기';
    case 'approved':
      return '승인';
    case 'rejected':
      return '반려';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function summarizeLabelChange(beforeTxt: string, afterTxt: string): string {
  const beforeLines = beforeTxt.trim() ? beforeTxt.trim().split(/\r?\n/).filter(Boolean) : [];
  const afterLines = afterTxt.trim() ? afterTxt.trim().split(/\r?\n/).filter(Boolean) : [];
  if (beforeLines.length === afterLines.length) {
    return `bbox ${beforeLines.length}개 수정`;
  }
  return `bbox ${beforeLines.length}개 → ${afterLines.length}개`;
}

function appendChangeEntry(
  meta: YoloImageMeta,
  by: string,
  role: YoloWorkflowRole,
  action: YoloChangeAction,
  summary: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): YoloImageMeta {
  const revision = meta.currentRevision + 1;
  return {
    ...meta,
    currentRevision: revision,
    changeHistory: [
      ...meta.changeHistory,
      {
        revision,
        at: isoNow(),
        by,
        role,
        action,
        summary,
        before,
        after,
      },
    ],
  };
}

export function appendLabelSaveHistory(
  meta: YoloImageMeta,
  actor: string,
  role: YoloWorkflowRole,
  beforeTxt: string,
  afterTxt: string
): YoloImageMeta | null {
  if (beforeTxt === afterTxt) return null;
  const summary = summarizeLabelChange(beforeTxt, afterTxt);
  return appendChangeEntry(meta, actor, role, 'label_save', summary, { labelTxt: beforeTxt }, { labelTxt: afterTxt });
}

export const workflowMetaPathForMedia = yoloMetaPathForImage;

export function appendVlmJsonSaveHistory(
  meta: YoloImageMeta,
  actor: string,
  role: YoloWorkflowRole,
  beforeJson: string,
  afterJson: string
): YoloImageMeta | null {
  if (beforeJson === afterJson) return null;
  const summary = !beforeJson.trim() ? '태그 저장' : '태그 수정';
  return appendChangeEntry(meta, actor, role, 'label_save', summary, { vlmJson: beforeJson }, { vlmJson: afterJson });
}

export function transitionSubmit(meta: YoloImageMeta, actor: string): YoloImageMeta {
  if (meta.workflowStatus !== 'draft' && meta.workflowStatus !== 'rejected') {
    return meta;
  }
  const beforeStatus = meta.workflowStatus;
  const submittedAt = isoNow();
  let next: YoloImageMeta = {
    ...meta,
    workflowStatus: 'submitted',
    worker: actor,
    submittedAt,
    review: {
      status: 'pending',
      inspector: null,
      reviewedAt: null,
      rejectReason: null,
    },
  };
  next = appendChangeEntry(
    next,
    actor,
    'worker',
    beforeStatus === 'rejected' ? 'resubmit' : 'submit',
    beforeStatus === 'rejected' ? '재검수 요청' : '검수 요청',
    { workflowStatus: beforeStatus },
    { workflowStatus: 'submitted' }
  );
  return next;
}

export function transitionApprove(meta: YoloImageMeta, actor: string): YoloImageMeta {
  if (meta.workflowStatus !== 'submitted') return meta;
  const reviewedAt = isoNow();
  let next: YoloImageMeta = {
    ...meta,
    workflowStatus: 'approved',
    review: {
      status: 'approved',
      inspector: actor,
      reviewedAt,
      rejectReason: null,
    },
  };
  next = appendChangeEntry(
    next,
    actor,
    'reviewer',
    'approve',
    '승인',
    { workflowStatus: 'submitted' },
    { workflowStatus: 'approved' }
  );
  return next;
}

export function transitionReject(meta: YoloImageMeta, actor: string, reason: string): YoloImageMeta {
  if (meta.workflowStatus !== 'submitted') return meta;
  const reviewedAt = isoNow();
  const trimmed = String(reason || '').trim();
  let next: YoloImageMeta = {
    ...meta,
    workflowStatus: 'rejected',
    review: {
      status: 'rejected',
      inspector: actor,
      reviewedAt,
      rejectReason: trimmed || null,
    },
  };
  next = appendChangeEntry(
    next,
    actor,
    'reviewer',
    'reject',
    trimmed ? `반려: ${trimmed}` : '반려',
    { workflowStatus: 'submitted' },
    { workflowStatus: 'rejected', rejectReason: trimmed || null }
  );
  return next;
}

type ReadJsonFn = (path: string) => Promise<ReadJsonFileResult>;
type WriteJsonFn = (path: string, content: string) => Promise<boolean>;

export async function loadYoloMeta(readJson: ReadJsonFn, imagePath: string): Promise<YoloImageMeta> {
  const metaPath = yoloMetaPathForImage(imagePath);
  const res = await readJson(metaPath);
  if (!res.ok || !res.text) return createDefaultYoloMeta();
  try {
    return parseYoloMeta(res.text);
  } catch {
    return createDefaultYoloMeta();
  }
}

export async function saveYoloMeta(
  writeJson: WriteJsonFn,
  imagePath: string,
  meta: YoloImageMeta
): Promise<boolean> {
  const metaPath = yoloMetaPathForImage(imagePath);
  return writeJson(metaPath, serializeYoloMeta(meta));
}
