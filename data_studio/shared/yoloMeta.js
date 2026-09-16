/** @typedef {'draft' | 'submitted' | 'approved' | 'rejected'} YoloWorkflowStatus */
/** @typedef {'worker' | 'reviewer'} YoloWorkflowRole */
/** @typedef {'label_save' | 'submit' | 'approve' | 'reject' | 'resubmit'} YoloChangeAction */

/**
 * @typedef {Object} YoloReviewInfo
 * @property {'none' | 'pending' | 'approved' | 'rejected'} status
 * @property {string | null} inspector
 * @property {string | null} reviewedAt
 * @property {string | null} rejectReason
 */

/**
 * @typedef {Object} YoloChangeEntry
 * @property {number} revision
 * @property {string} at
 * @property {string} by
 * @property {YoloWorkflowRole} role
 * @property {YoloChangeAction} action
 * @property {string} summary
 * @property {Record<string, unknown>} before
 * @property {Record<string, unknown>} after
 */

/**
 * @typedef {Object} YoloImageMeta
 * @property {1} schemaVersion
 * @property {YoloWorkflowStatus} workflowStatus
 * @property {string | null} worker
 * @property {string | null} submittedAt
 * @property {YoloReviewInfo} review
 * @property {number} currentRevision
 * @property {YoloChangeEntry[]} changeHistory
 */

const WORKFLOW_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];

function isoNow() {
  return new Date().toISOString();
}

/** @returns {YoloImageMeta} */
function createDefaultYoloMeta() {
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

/** @param {string} imagePath */
function yoloMetaPathForImage(imagePath) {
  const normalized = String(imagePath || '').replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const file = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
  const dot = file.lastIndexOf('.');
  const stem = dot >= 0 ? file.slice(0, dot) : file;
  return dir ? `${dir}/${stem}.meta.json` : `${stem}.meta.json`;
}

/** @param {unknown} value @returns {value is YoloWorkflowStatus} */
function isWorkflowStatus(value) {
  return typeof value === 'string' && WORKFLOW_STATUSES.includes(value);
}

/** @param {string} text @returns {YoloImageMeta} */
function parseYoloMeta(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid meta');
  }
  const base = createDefaultYoloMeta();
  /** @type {YoloImageMeta} */
  const meta = {
    ...base,
    workflowStatus: isWorkflowStatus(raw.workflowStatus) ? raw.workflowStatus : base.workflowStatus,
    worker: typeof raw.worker === 'string' ? raw.worker : raw.worker === null ? null : base.worker,
    submittedAt: typeof raw.submittedAt === 'string' ? raw.submittedAt : raw.submittedAt === null ? null : base.submittedAt,
    currentRevision: typeof raw.currentRevision === 'number' && Number.isFinite(raw.currentRevision)
      ? Math.max(0, Math.floor(raw.currentRevision))
      : base.currentRevision,
    review: {
      status: ['none', 'pending', 'approved', 'rejected'].includes(raw.review?.status)
        ? raw.review.status
        : base.review.status,
      inspector: typeof raw.review?.inspector === 'string' ? raw.review.inspector : raw.review?.inspector === null ? null : base.review.inspector,
      reviewedAt: typeof raw.review?.reviewedAt === 'string' ? raw.review.reviewedAt : raw.review?.reviewedAt === null ? null : base.review.reviewedAt,
      rejectReason: typeof raw.review?.rejectReason === 'string' ? raw.review.rejectReason : raw.review?.rejectReason === null ? null : base.review.rejectReason,
    },
    changeHistory: Array.isArray(raw.changeHistory)
      ? raw.changeHistory.filter((entry) => entry && typeof entry === 'object').map((entry) => ({
          revision: typeof entry.revision === 'number' ? entry.revision : 0,
          at: typeof entry.at === 'string' ? entry.at : isoNow(),
          by: typeof entry.by === 'string' ? entry.by : '',
          role: entry.role === 'reviewer' ? 'reviewer' : 'worker',
          action: ['label_save', 'submit', 'approve', 'reject', 'resubmit'].includes(entry.action)
            ? entry.action
            : 'label_save',
          summary: typeof entry.summary === 'string' ? entry.summary : '',
          before: entry.before && typeof entry.before === 'object' ? entry.before : {},
          after: entry.after && typeof entry.after === 'object' ? entry.after : {},
        }))
      : [],
  };
  return meta;
}

/** @param {YoloImageMeta} meta */
function serializeYoloMeta(meta) {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

/** @param {YoloWorkflowRole} role @param {YoloWorkflowStatus} status */
function canEditLabels(role, status) {
  if (role === 'reviewer') return false;
  return status === 'draft' || status === 'rejected' || status === 'submitted';
}

/** @param {YoloWorkflowStatus} status */
function workflowStatusLabel(status) {
  switch (status) {
    case 'draft':
      return '작업중';
    case 'submitted':
      return '검수대기';
    case 'approved':
      return '승인';
    case 'rejected':
      return '반려';
    default:
      return status;
  }
}

/** @param {string} beforeTxt @param {string} afterTxt */
function summarizeLabelChange(beforeTxt, afterTxt) {
  const beforeLines = beforeTxt.trim() ? beforeTxt.trim().split(/\r?\n/).filter(Boolean) : [];
  const afterLines = afterTxt.trim() ? afterTxt.trim().split(/\r?\n/).filter(Boolean) : [];
  if (beforeLines.length === afterLines.length) {
    return `bbox ${beforeLines.length}개 수정`;
  }
  return `bbox ${beforeLines.length}개 → ${afterLines.length}개`;
}

/**
 * @param {YoloImageMeta} meta
 * @param {string} by
 * @param {YoloWorkflowRole} role
 * @param {YoloChangeAction} action
 * @param {string} summary
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @returns {YoloImageMeta}
 */
function appendChangeEntry(meta, by, role, action, summary, before, after) {
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

/**
 * @param {YoloImageMeta} meta
 * @param {string} actor
 * @param {YoloWorkflowRole} role
 * @param {string} beforeTxt
 * @param {string} afterTxt
 * @returns {YoloImageMeta | null}
 */
function appendLabelSaveHistory(meta, actor, role, beforeTxt, afterTxt) {
  if (beforeTxt === afterTxt) return null;
  const summary = summarizeLabelChange(beforeTxt, afterTxt);
  return appendChangeEntry(
    meta,
    actor,
    role,
    'label_save',
    summary,
    { labelTxt: beforeTxt },
    { labelTxt: afterTxt }
  );
}

/**
 * @param {YoloImageMeta} meta
 * @param {string} actor
 * @returns {YoloImageMeta}
 */
function transitionSubmit(meta, actor) {
  if (meta.workflowStatus !== 'draft' && meta.workflowStatus !== 'rejected') {
    return meta;
  }
  const beforeStatus = meta.workflowStatus;
  const submittedAt = isoNow();
  let next = {
    ...meta,
    workflowStatus: /** @type {YoloWorkflowStatus} */ ('submitted'),
    worker: actor,
    submittedAt,
    review: {
      status: /** @type {'pending'} */ ('pending'),
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

/**
 * @param {YoloImageMeta} meta
 * @param {string} actor
 * @returns {YoloImageMeta}
 */
function transitionApprove(meta, actor) {
  if (meta.workflowStatus !== 'submitted') return meta;
  const reviewedAt = isoNow();
  let next = {
    ...meta,
    workflowStatus: /** @type {YoloWorkflowStatus} */ ('approved'),
    review: {
      status: /** @type {'approved'} */ ('approved'),
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

/**
 * @param {YoloImageMeta} meta
 * @param {string} actor
 * @param {string} reason
 * @returns {YoloImageMeta}
 */
function transitionReject(meta, actor, reason) {
  if (meta.workflowStatus !== 'submitted') return meta;
  const reviewedAt = isoNow();
  const trimmed = String(reason || '').trim();
  let next = {
    ...meta,
    workflowStatus: /** @type {YoloWorkflowStatus} */ ('rejected'),
    review: {
      status: /** @type {'rejected'} */ ('rejected'),
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

function appendVlmJsonSaveHistory(meta, actor, role, beforeJson, afterJson) {
  if (beforeJson === afterJson) return null;
  const summary = !String(beforeJson || '').trim() ? '태그 저장' : '태그 수정';
  return appendChangeEntry(meta, actor, role, 'label_save', summary, { vlmJson: beforeJson }, { vlmJson: afterJson });
}

module.exports = {
  WORKFLOW_STATUSES,
  createDefaultYoloMeta,
  yoloMetaPathForImage,
  workflowMetaPathForMedia: yoloMetaPathForImage,
  parseYoloMeta,
  serializeYoloMeta,
  canEditLabels,
  workflowStatusLabel,
  summarizeLabelChange,
  appendLabelSaveHistory,
  appendVlmJsonSaveHistory,
  transitionSubmit,
  transitionApprove,
  transitionReject,
};
