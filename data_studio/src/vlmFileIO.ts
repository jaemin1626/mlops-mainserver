/**
 * 로컬 VLM JSON 파일 ↔ VlmReviewPanel 이 기대하는 sourceData 문자열
 * (웹 DB는 sourceData를 문자열로 두지만,보내기 JSON은 객체/배열인 경우가 많음)
 */

import { extractVlmMediaPathFromRecord, inferVlmMediaType, resolveVlmMediaFromSourceData } from './vlmMedia';
import {
  findVlmReviewOption,
  LOCAL_VLM_REVIEW_OPTIONS,
  resolveStoredReviewResult,
  storedReviewToExportLabel,
} from './vlmReviewOptions';

export type VlmFileEnvelope =
  | { kind: 'wrapper'; record: Record<string, unknown> }
  | { kind: 'raw'; originalText: string }
  | {
      kind: 'arrayRoot';
      /** 저장 시 직렬화할 배열 (첫 항목이 갱신됨) */
      items: unknown[];
      index: number;
      /** task = { sourceData, reviewerNotes, ... } / payload = 통째로 VLM 페이로드 */
      itemKind: 'taskSourceString' | 'taskSourceObject' | 'payload' | 'sharegptFlat';
    }
  | {
      kind: 'nestedArray';
      root: Record<string, unknown>;
      arrayKey: string;
      items: unknown[];
      index: number;
      itemKind: 'taskSourceString' | 'taskSourceObject' | 'payload' | 'sharegptFlat';
    }
  /** sample.json: { "0": { image, conversations }, "1": { ... } } */
  | {
      kind: 'indexedConversationMap';
      root: Record<string, unknown>;
      activeKey: string;
    };

function looksLikeVlmPayload(o: unknown): o is Record<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  return !!(r.rawData || r.rawResultData || r.resolvedMediaPath || r.resolvedImagePath || r.legacyMedia || r.legacyImage);
}

function extractFromTaskRecord(obj: Record<string, unknown>): { sourceDataStr: string; reviewerNotes: string } | null {
  const notes = String(obj.reviewerNotes ?? '');
  if (typeof obj.sourceData === 'string') {
    return { sourceDataStr: obj.sourceData, reviewerNotes: notes };
  }
  if (obj.sourceData && typeof obj.sourceData === 'object') {
    return { sourceDataStr: JSON.stringify(obj.sourceData), reviewerNotes: notes };
  }
  if (looksLikeVlmPayload(obj)) {
    return { sourceDataStr: JSON.stringify(obj), reviewerNotes: notes };
  }
  return null;
}

/** sample.json: [{ index, media|image, conversations }, …] */
function isSharegptFlatItem(o: Record<string, unknown>): boolean {
  return Boolean(extractVlmMediaPathFromRecord(o)) && Array.isArray(o.conversations);
}

function classifyArrayItem(item: unknown): {
  sourceDataStr: string;
  reviewerNotes: string;
  itemKind: 'taskSourceString' | 'taskSourceObject' | 'payload' | 'sharegptFlat';
} | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const notes = String(o.reviewerNotes ?? '');
  if (typeof o.sourceData === 'string') {
    return { sourceDataStr: o.sourceData, reviewerNotes: notes, itemKind: 'taskSourceString' };
  }
  if (o.sourceData && typeof o.sourceData === 'object') {
    return { sourceDataStr: JSON.stringify(o.sourceData), reviewerNotes: notes, itemKind: 'taskSourceObject' };
  }
  /** 저장 후 rawResultData/ui가 붙어도 배열 항목은 ShareGPT로 유지해야 A/D·항목 수가 깨지지 않음 */
  if (isSharegptFlatItem(o)) {
    return { sourceDataStr: sharegptLikeItemToCanonicalJson(o), reviewerNotes: '', itemKind: 'sharegptFlat' };
  }
  if (looksLikeVlmPayload(o)) {
    return { sourceDataStr: JSON.stringify(o), reviewerNotes: notes, itemKind: 'payload' };
  }
  return null;
}

const NESTED_ARRAY_KEYS = ['tasks', 'items', 'data', 'records', 'results', 'vlm_tasks'] as const;

/** "0","1",… 키 + 각 항목에 media|image·conversations (비숫자 메타 키는 무시) */
function isIndexedConversationMap(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj).filter((k) => /^\d+$/.test(k));
  if (keys.length === 0) return false;
  for (const k of keys) {
    const v = obj[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const rec = v as Record<string, unknown>;
    if (!extractVlmMediaPathFromRecord(rec)) return false;
    if (!Array.isArray(rec.conversations)) return false;
  }
  return true;
}

function sharegptLikeItemToCanonicalJson(item: Record<string, unknown>): string {
  const media = extractVlmMediaPathFromRecord(item);
  const mediaType = inferVlmMediaType(media, item.mediaType);
  const conversations = Array.isArray(item.conversations) ? item.conversations : [];
  let gptFromConv = '';
  for (const c of conversations) {
    if (!c || typeof c !== 'object') continue;
    const from = String((c as Record<string, unknown>).from ?? '').toLowerCase();
    if (from === 'gpt' || from === 'assistant' || from === 'model') {
      gptFromConv = String((c as Record<string, unknown>).value ?? '');
      break;
    }
  }
  const rrd =
    item.rawResultData && typeof item.rawResultData === 'object' && !Array.isArray(item.rawResultData)
      ? (item.rawResultData as Record<string, unknown>)
      : {};
  const uiItem = item.ui && typeof item.ui === 'object' && !Array.isArray(item.ui) ? (item.ui as Record<string, unknown>) : {};

  const dual = itemHasTopLevelReviewFields(item);
  const topOriginalResponse = String(item.original_response ?? '').trim();

  let originalAnswer: string;
  let editedAnswer: string;
  let reviewResult: string;

  if (dual) {
    /** 읽기 전용 GPT 영역 = original_response, 수정란 초기값 = conversations 의 gpt value */
    originalAnswer = topOriginalResponse || String(rrd.originalAnswer ?? rrd.answer ?? gptFromConv).trim() || gptFromConv;
    editedAnswer = String(rrd.editedAnswer ?? uiItem.editedGptResponse ?? '').trim();
    if (!editedAnswer) editedAnswer = gptFromConv;
    const fromRrd = String(rrd.reviewResult ?? uiItem.reviewResult ?? '').trim();
    reviewResult = fromRrd || mapTopLevelResultToStoredReview(item.result);
  } else {
    originalAnswer = String(rrd.originalAnswer ?? rrd.answer ?? gptFromConv).trim() || gptFromConv;
    editedAnswer = String(rrd.editedAnswer ?? uiItem.editedGptResponse ?? '').trim();
    reviewResult = String(rrd.reviewResult ?? uiItem.reviewResult ?? '').trim();
  }

  const rrdOut: Record<string, unknown> = { originalAnswer };
  if (dual) rrdOut.dualGptLayout = true;
  if (editedAnswer) rrdOut.editedAnswer = editedAnswer;
  if (reviewResult) rrdOut.reviewResult = reviewResult;

  return JSON.stringify({
    mediaType,
    resolvedMediaPath: media,
    resolvedImagePath: media,
    rawData: {
      media,
      mediaType,
      conversations,
      ...(item.image ? { image: item.image } : {}),
      ...(item.video ? { video: item.video } : {}),
    },
    rawResultData: rrdOut,
  });
}

function getGptValueFromConversations(conv: unknown): string {
  if (!Array.isArray(conv)) return '';
  for (const c of conv) {
    if (!c || typeof c !== 'object') continue;
    const from = String((c as Record<string, unknown>).from ?? '').toLowerCase();
    if (from === 'gpt' || from === 'assistant' || from === 'model') {
      return String((c as Record<string, unknown>).value ?? '');
    }
  }
  return '';
}

/** JSON 루트에 `result` + `original_response` 가 함께 있는보내기 양식 */
function itemHasTopLevelReviewFields(item: Record<string, unknown>): boolean {
  return 'result' in item && 'original_response' in item;
}

/** 상위 result 문자열 → rawResultData.reviewResult 저장값 */
function mapTopLevelResultToStoredReview(topResult: unknown): string {
  return resolveStoredReviewResult(topResult);
}

/** 저장 시 항목에 넣을 한글 result (UI 검수 결과 반영) */
function storedReviewToTopLevelResult(stored: string): string {
  return storedReviewToExportLabel(stored);
}

function isStoredReviewNormal(rr: Record<string, unknown> | undefined): boolean {
  const v = String(rr?.reviewResult ?? '').toUpperCase();
  return v === 'NORMAL' || v === '';
}

/**
 * conversations 의 gpt value 로 쓸 문자열.
 * 정상: 수정필요였다가 정상으로 바꾼 경우 등 → gpt 슬롯을 original_response(originalAnswer)로 맞춤.
 * dualGptLayout + 수정필요: editedAnswer 우선(짧은 수정본).
 * 그 외: canonical 원문 또는 대화 슬롯.
 */
function pickSharegptGptValueForExport(
  merged: Record<string, unknown>,
  originalItem: Record<string, unknown>
): string {
  const rr = merged.rawResultData as Record<string, unknown> | undefined;
  const originalFromItem = getGptValueFromConversations(originalItem.conversations);

  if (isStoredReviewNormal(rr)) {
    const fromCanon = String(rr?.originalAnswer ?? rr?.answer ?? rr?.response ?? '').trim();
    const fromTop = String(originalItem.original_response ?? '').trim();
    return (fromCanon || fromTop || originalFromItem).trim();
  }

  if (rr?.dualGptLayout === true) {
    const ed = String(rr?.editedAnswer ?? '').trim();
    return ed || originalFromItem;
  }
  const canonicalOrig = String(rr?.originalAnswer ?? rr?.answer ?? rr?.response ?? '').trim();
  return (canonicalOrig || originalFromItem).trim();
}

function mergedCanonicalToSharegptItem(merged: Record<string, unknown>, originalItem: Record<string, unknown>): Record<string, unknown> {
  const rawData = merged.rawData as Record<string, unknown> | undefined;
  const media = String(
    merged.resolvedMediaPath ??
      merged.resolvedImagePath ??
      extractVlmMediaPathFromRecord(rawData) ??
      extractVlmMediaPathFromRecord(originalItem) ??
      ''
  );
  const mediaType = inferVlmMediaType(media, merged.mediaType ?? rawData?.mediaType ?? originalItem.mediaType);
  let conversations: unknown[] = [];
  if (rawData && Array.isArray(rawData.conversations)) {
    conversations = [...rawData.conversations];
  } else if (Array.isArray(originalItem.conversations)) {
    conversations = [...originalItem.conversations];
  }
  const newGpt = pickSharegptGptValueForExport(merged, originalItem);
  const gptIdx = conversations.findIndex((c: unknown) => {
    if (!c || typeof c !== 'object') return false;
    const from = String((c as Record<string, unknown>).from ?? '').toLowerCase();
    return from === 'gpt' || from === 'assistant' || from === 'model';
  });
  if (gptIdx >= 0) {
    const prev = conversations[gptIdx] as Record<string, unknown>;
    conversations[gptIdx] = { ...prev, value: newGpt, from: prev.from ?? 'gpt' };
  }

  const rr = merged.rawResultData as Record<string, unknown> | undefined;

  /** 디스크에는 result / original_response 만 (rawResultData·dueDate 없음) */
  const out: Record<string, unknown> = { ...originalItem };
  delete out.ui;
  delete out.rawResultData;
  delete out.dueDate;

  out.index = originalItem.index;
  delete out.media;
  delete out.image;
  delete out.video;
  const hadVideo = String(originalItem.video ?? '').trim().length > 0;
  const hadImage = String(originalItem.image ?? '').trim().length > 0;
  if (hadVideo || mediaType === 'video') {
    out.video = media;
  } else if (hadImage) {
    out.image = media;
  } else {
    out.media = media;
  }
  out.mediaType = mediaType;
  out.conversations = conversations;
  out.original_response =
    String(rr?.originalAnswer ?? '').trim() ||
    String(originalItem.original_response ?? '').trim() ||
    newGpt;
  out.result = storedReviewToTopLevelResult(String(rr?.reviewResult ?? ''));

  return out;
}

/** indexedConversationMap 키 정렬 (0,1,2 / 01 등) */
export function sortedNumericKeys(root: Record<string, unknown>): string[] {
  return Object.keys(root)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

/** A/D 이동 지원: 배열·숫자키 맵 (ShareGPT·DB task 래퍼·payload 포함) */
export function vlmNavigableListCount(envelope: VlmFileEnvelope | null): number {
  if (!envelope) return 0;
  if (envelope.kind === 'arrayRoot') return envelope.items.length;
  if (envelope.kind === 'nestedArray') return envelope.items.length;
  if (envelope.kind === 'indexedConversationMap') return sortedNumericKeys(envelope.root).length;
  return 0;
}

export function vlmCurrentSlot(envelope: VlmFileEnvelope | null): number {
  if (!envelope) return 0;
  if (envelope.kind === 'arrayRoot') {
    const n = envelope.items.length;
    return n ? Math.max(0, Math.min(envelope.index, n - 1)) : 0;
  }
  if (envelope.kind === 'nestedArray') {
    const n = envelope.items.length;
    return n ? Math.max(0, Math.min(envelope.index, n - 1)) : 0;
  }
  if (envelope.kind === 'indexedConversationMap') {
    const keys = sortedNumericKeys(envelope.root);
    const i = keys.indexOf(envelope.activeKey);
    return i >= 0 ? i : 0;
  }
  return 0;
}

export function vlmEnvelopeAtSlot(envelope: VlmFileEnvelope, slot: number): VlmFileEnvelope {
  if (envelope.kind === 'arrayRoot') {
    const n = envelope.items.length;
    const i = n ? Math.max(0, Math.min(slot, n - 1)) : 0;
    return { ...envelope, index: i };
  }
  if (envelope.kind === 'nestedArray') {
    const n = envelope.items.length;
    const i = n ? Math.max(0, Math.min(slot, n - 1)) : 0;
    return { ...envelope, index: i };
  }
  if (envelope.kind === 'indexedConversationMap') {
    const keys = sortedNumericKeys(envelope.root);
    if (keys.length === 0) return envelope;
    const i = Math.max(0, Math.min(slot, keys.length - 1));
    return { ...envelope, activeKey: keys[i] };
  }
  return envelope;
}

/** 항목 객체의 `index` 필드가 있으면 그 값, 없으면 배열 순번(1-based) 또는 숫자 맵 키 */
export function vlmItemListIndex(envelope: VlmFileEnvelope, slot: number): string {
  if (envelope.kind === 'arrayRoot' || envelope.kind === 'nestedArray') {
    const n = envelope.items.length;
    if (n === 0) return '';
    const i = Math.max(0, Math.min(slot, n - 1));
    const item = envelope.items[i];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const idx = (item as Record<string, unknown>).index;
      if (idx !== undefined && idx !== null && String(idx).trim() !== '') return String(idx);
    }
    return String(i + 1);
  }
  if (envelope.kind === 'indexedConversationMap') {
    const keys = sortedNumericKeys(envelope.root);
    if (keys.length === 0) return '';
    const i = Math.max(0, Math.min(slot, keys.length - 1));
    const key = keys[i];
    const item = envelope.root[key];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const idx = (item as Record<string, unknown>).index;
      if (idx !== undefined && idx !== null && String(idx).trim() !== '') return String(idx);
    }
    return key;
  }
  return '';
}

export function vlmSourceDataForSlot(envelope: VlmFileEnvelope, slot: number): string | null {
  const meta = vlmSlotMetaForEnvelope(envelope, slot);
  return meta?.sourceDataStr ?? null;
}

export function vlmReviewerNotesForSlot(envelope: VlmFileEnvelope, slot: number): string {
  return vlmSlotMetaForEnvelope(envelope, slot)?.reviewerNotes ?? '';
}

function vlmSlotMetaForEnvelope(
  envelope: VlmFileEnvelope,
  slot: number
): { sourceDataStr: string; reviewerNotes: string } | null {
  const env = vlmEnvelopeAtSlot(envelope, slot);
  if (env.kind === 'arrayRoot' || env.kind === 'nestedArray') {
    const item = env.items[env.index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const hit = classifyArrayItem(item);
    if (!hit) return null;
    return { sourceDataStr: hit.sourceDataStr, reviewerNotes: hit.reviewerNotes };
  }
  if (env.kind === 'indexedConversationMap') {
    const item = env.root[env.activeKey];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    return {
      sourceDataStr: sharegptLikeItemToCanonicalJson(item as Record<string, unknown>),
      reviewerNotes: '',
    };
  }
  return null;
}

function firstHumanPromptFromConversations(conv: unknown): string {
  if (!Array.isArray(conv)) return '';
  for (const item of conv) {
    if (!item || typeof item !== 'object') continue;
    const from = String((item as Record<string, unknown>).from ?? '').toLowerCase();
    if (from === 'human' || from === 'user') {
      return String((item as Record<string, unknown>).value ?? '');
    }
  }
  return '';
}

/** sourceData 문자열을 VlmReviewPanel 과 같은 껍질까지 벗긴 payload 루트로 파싱 */
function parseVlmSourcePayloadRoot(sourceDataStr: string): Record<string, unknown> | null {
  const raw = String(sourceDataStr || '').trim();
  if (!raw) return null;
  try {
    let root = JSON.parse(raw) as unknown;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
    let pr = root as Record<string, unknown>;

    if (pr.rawData || pr.rawResultData || pr.resolvedMediaPath || pr.resolvedImagePath || pr.legacyMedia || pr.legacyImage) {
      /* canonical VLM */
    } else if (typeof pr.sourceData === 'string') {
      try {
        const inner = JSON.parse(pr.sourceData) as unknown;
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) pr = inner as Record<string, unknown>;
      } catch {
        return null;
      }
    } else if (pr.sourceData && typeof pr.sourceData === 'object' && !Array.isArray(pr.sourceData)) {
      pr = pr.sourceData as Record<string, unknown>;
    }

    return pr;
  } catch {
    return null;
  }
}

/**
 * VLM 항목 sourceData JSON 문자열에서 "입력 프롬프트"(첫 human/user 대화)만 추출.
 * 검수 패널과 동일한 계열의 필드를 본다.
 */
export function vlmInputPromptFromSourceDataStr(sourceDataStr: string): string {
  const pr = parseVlmSourcePayloadRoot(sourceDataStr);
  if (!pr) return '';

  const rd = pr.rawData;
  if (rd && typeof rd === 'object' && !Array.isArray(rd)) {
    const c = (rd as Record<string, unknown>).conversations;
    const hit = firstHumanPromptFromConversations(c);
    if (hit) return hit;
  }
  if (Array.isArray(pr.conversations)) {
    return firstHumanPromptFromConversations(pr.conversations);
  }
  return '';
}

/**
 * GPT 응답 수정란에 해당하는 저장 텍스트 (rawResultData.editedAnswer, ui.editedGptResponse).
 * 검수 패널이 읽는 필드와 동일 계열.
 */
export function vlmEditedGptResponseFromSourceDataStr(sourceDataStr: string): string {
  const pr = parseVlmSourcePayloadRoot(sourceDataStr);
  if (!pr) return '';

  const rrd = pr.rawResultData;
  const ui = pr.ui;
  const fromRrd =
    rrd && typeof rrd === 'object' && !Array.isArray(rrd)
      ? String((rrd as Record<string, unknown>).editedAnswer ?? '').trim()
      : '';
  const fromUi =
    ui && typeof ui === 'object' && !Array.isArray(ui)
      ? String((ui as Record<string, unknown>).editedGptResponse ?? '').trim()
      : '';
  if (fromRrd && fromUi && fromRrd !== fromUi) return `${fromRrd}\n${fromUi}`;
  return fromRrd || fromUi;
}

/** 검수 결과 저장 코드 (rawResultData / ui / result → LOCAL_VLM_REVIEW_OPTIONS id) */
export function vlmReviewResultFromSourceDataStr(sourceDataStr: string): string {
  const pr = parseVlmSourcePayloadRoot(sourceDataStr);
  if (!pr) return 'NORMAL';

  const rrd = pr.rawResultData;
  const ui = pr.ui;
  const fromRrd =
    rrd && typeof rrd === 'object' && !Array.isArray(rrd)
      ? (rrd as Record<string, unknown>).reviewResult
      : undefined;
  const fromUi =
    ui && typeof ui === 'object' && !Array.isArray(ui)
      ? (ui as Record<string, unknown>).reviewResult
      : undefined;
  const raw = String(fromUi ?? fromRrd ?? '').trim();
  if (raw) return resolveStoredReviewResult(raw);
  if (pr.result != null && String(pr.result).trim()) return resolveStoredReviewResult(pr.result);
  return 'NORMAL';
}

export function parseVlmJsonFile(text: string): {
  sourceDataStr: string;
  reviewerNotes: string;
  envelope: VlmFileEnvelope;
} {
  const trimmed = text.trim();
  try {
    const root = JSON.parse(trimmed) as unknown;

    if (Array.isArray(root) && root.length > 0) {
      let firstHit: ReturnType<typeof classifyArrayItem> = null;
      let firstHitIndex = 0;
      for (let i = 0; i < root.length; i++) {
        const hit = classifyArrayItem(root[i]);
        if (hit) {
          firstHit = hit;
          firstHitIndex = i;
          break;
        }
      }
      if (firstHit) {
        return {
          sourceDataStr: firstHit.sourceDataStr,
          reviewerNotes: firstHit.reviewerNotes,
          envelope: {
            kind: 'arrayRoot',
            items: [...root],
            index: firstHitIndex,
            itemKind: firstHit.itemKind,
          },
        };
      }
    }

    if (root && typeof root === 'object' && !Array.isArray(root)) {
      const obj = root as Record<string, unknown>;

      if (isIndexedConversationMap(obj)) {
        const activeKey = Object.keys(obj).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))[0];
        const item = obj[activeKey] as Record<string, unknown>;
        return {
          sourceDataStr: sharegptLikeItemToCanonicalJson(item),
          reviewerNotes: '',
          envelope: { kind: 'indexedConversationMap', root: { ...obj }, activeKey },
        };
      }

      const direct = extractFromTaskRecord(obj);
      if (direct) {
        const isWrapper = 'sourceData' in obj;
        if (isWrapper) {
          return {
            sourceDataStr: direct.sourceDataStr,
            reviewerNotes: direct.reviewerNotes,
            envelope: { kind: 'wrapper', record: { ...obj } },
          };
        }
        return {
          sourceDataStr: direct.sourceDataStr,
          reviewerNotes: direct.reviewerNotes,
          envelope: { kind: 'raw', originalText: trimmed },
        };
      }

      for (const key of NESTED_ARRAY_KEYS) {
        const arr = obj[key];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const hit = classifyArrayItem(arr[0]);
        if (hit) {
          return {
            sourceDataStr: hit.sourceDataStr,
            reviewerNotes: hit.reviewerNotes,
            envelope: {
              kind: 'nestedArray',
              root: { ...obj },
              arrayKey: key,
              items: [...arr],
              index: 0,
              itemKind: hit.itemKind,
            },
          };
        }
      }
    }

    return {
      sourceDataStr: typeof root === 'string' ? root : JSON.stringify(root),
      reviewerNotes: '',
      envelope: { kind: 'raw', originalText: trimmed },
    };
  } catch {
    return {
      sourceDataStr: trimmed,
      reviewerNotes: '',
      envelope: { kind: 'raw', originalText: trimmed },
    };
  }
}

export function buildVlmJsonFileContent(
  envelope: VlmFileEnvelope | null,
  mergedSourceDataStr: string,
  reviewerNotes: string
): string {
  if (envelope?.kind === 'wrapper') {
    return JSON.stringify({ ...envelope.record, sourceData: mergedSourceDataStr, reviewerNotes }, null, 2);
  }

  if (envelope?.kind === 'indexedConversationMap') {
    let merged: Record<string, unknown>;
    try {
      merged = JSON.parse(mergedSourceDataStr) as Record<string, unknown>;
    } catch {
      return mergedSourceDataStr;
    }
    const originalItem = envelope.root[envelope.activeKey] as Record<string, unknown>;
    const newItem = mergedCanonicalToSharegptItem(merged, originalItem);
    const outRoot = { ...envelope.root, [envelope.activeKey]: newItem };
    return JSON.stringify(outRoot, null, 2);
  }

  if (envelope?.kind === 'arrayRoot') {
    const next = [...envelope.items];
    const i = envelope.index;
    const cur = next[i];
    if (envelope.itemKind === 'sharegptFlat' && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      let merged: Record<string, unknown>;
      try {
        merged = JSON.parse(mergedSourceDataStr) as Record<string, unknown>;
      } catch {
        return mergedSourceDataStr;
      }
      next[i] = mergedCanonicalToSharegptItem(merged, cur as Record<string, unknown>);
      return JSON.stringify(next, null, 2);
    }
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      const o = { ...(cur as Record<string, unknown>) };
      if (envelope.itemKind === 'taskSourceString') {
        o.sourceData = mergedSourceDataStr;
        o.reviewerNotes = reviewerNotes;
      } else if (envelope.itemKind === 'taskSourceObject') {
        try {
          o.sourceData = JSON.parse(mergedSourceDataStr);
        } catch {
          o.sourceData = mergedSourceDataStr;
        }
        o.reviewerNotes = reviewerNotes;
      } else {
        try {
          next[i] = JSON.parse(mergedSourceDataStr);
        } catch {
          next[i] = mergedSourceDataStr;
        }
        return JSON.stringify(next, null, 2);
      }
      next[i] = o;
    }
    return JSON.stringify(next, null, 2);
  }

  if (envelope?.kind === 'nestedArray') {
    const nextItems = [...envelope.items];
    const i = envelope.index;
    const cur = nextItems[i];
    if (envelope.itemKind === 'sharegptFlat' && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      let merged: Record<string, unknown>;
      try {
        merged = JSON.parse(mergedSourceDataStr) as Record<string, unknown>;
      } catch {
        return mergedSourceDataStr;
      }
      nextItems[i] = mergedCanonicalToSharegptItem(merged, cur as Record<string, unknown>);
      const rootOut = { ...envelope.root, [envelope.arrayKey]: nextItems };
      return JSON.stringify(rootOut, null, 2);
    }
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      const o = { ...(cur as Record<string, unknown>) };
      if (envelope.itemKind === 'taskSourceString') {
        o.sourceData = mergedSourceDataStr;
        o.reviewerNotes = reviewerNotes;
      } else if (envelope.itemKind === 'taskSourceObject') {
        try {
          o.sourceData = JSON.parse(mergedSourceDataStr);
        } catch {
          o.sourceData = mergedSourceDataStr;
        }
        o.reviewerNotes = reviewerNotes;
      } else {
        try {
          nextItems[i] = JSON.parse(mergedSourceDataStr);
        } catch {
          nextItems[i] = mergedSourceDataStr;
        }
        const rootOut = { ...envelope.root, [envelope.arrayKey]: nextItems };
        return JSON.stringify(rootOut, null, 2);
      }
      nextItems[i] = o;
    }
    const rootOut = { ...envelope.root, [envelope.arrayKey]: nextItems };
    return JSON.stringify(rootOut, null, 2);
  }

  try {
    const inner = JSON.parse(mergedSourceDataStr);
    return JSON.stringify(inner, null, 2);
  } catch {
    return mergedSourceDataStr;
  }
}

export type VlmExportRowMeta = {
  slot: number;
  listIndex: string;
  reviewResultId: string;
  reviewLabel: string;
  promptPreview: string;
  mediaPath: string;
};

export function vlmExportRowMetaForSlot(envelope: VlmFileEnvelope, slot: number): VlmExportRowMeta | null {
  const src = vlmSourceDataForSlot(envelope, slot);
  if (!src) return null;
  const reviewResultId = vlmReviewResultFromSourceDataStr(src);
  const reviewLabel =
    findVlmReviewOption(LOCAL_VLM_REVIEW_OPTIONS, reviewResultId)?.label ??
    storedReviewToExportLabel(reviewResultId);
  const prompt = vlmInputPromptFromSourceDataStr(src);
  let mediaPath = '';
  try {
    const parsed = JSON.parse(src) as Record<string, unknown>;
    mediaPath = resolveVlmMediaFromSourceData(parsed).mediaPath;
  } catch {
    /* ignore */
  }
  return {
    slot,
    listIndex: vlmItemListIndex(envelope, slot),
    reviewResultId,
    reviewLabel,
    promptPreview: prompt.replace(/\s+/g, ' ').trim().slice(0, 140),
    mediaPath,
  };
}

export function vlmSharegptExportItemForSlot(
  envelope: VlmFileEnvelope,
  slot: number
): Record<string, unknown> | null {
  const env = vlmEnvelopeAtSlot(envelope, slot);
  const src = vlmSourceDataForSlot(envelope, slot);
  if (!src) return null;
  let merged: Record<string, unknown>;
  try {
    merged = JSON.parse(src) as Record<string, unknown>;
  } catch {
    return null;
  }

  let originalItem: Record<string, unknown> = {};
  if (env.kind === 'arrayRoot' || env.kind === 'nestedArray') {
    const cur = env.items[env.index];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      originalItem = cur as Record<string, unknown>;
    }
  } else if (env.kind === 'indexedConversationMap') {
    originalItem = (env.root[env.activeKey] as Record<string, unknown>) ?? {};
  }

  return mergedCanonicalToSharegptItem(merged, originalItem);
}

/** 선택 슬롯만 ShareGPT 보내기 JSON 배열로 직렬화 (재검수용) */
export function buildVlmReReviewExportJson(envelope: VlmFileEnvelope, slots: number[]): string | null {
  const items: Record<string, unknown>[] = [];
  for (const slot of slots) {
    const item = vlmSharegptExportItemForSlot(envelope, slot);
    if (item) items.push(item);
  }
  if (items.length === 0) return null;
  return JSON.stringify(items, null, 2);
}

export type VlmBriefReportBreakdown = {
  id: string;
  label: string;
  count: number;
  pct: number;
};

export type VlmBriefReport = {
  sourceFileName: string;
  generatedAt: string;
  totalItems: number;
  explicitReviewCount: number;
  implicitNormalCount: number;
  editedCount: number;
  withReviewerNotesCount: number;
  needsFixTotal: number;
  needsFixPct: number;
  breakdown: VlmBriefReportBreakdown[];
};

function vlmHasExplicitReviewResult(sourceDataStr: string): boolean {
  const pr = parseVlmSourcePayloadRoot(sourceDataStr);
  if (!pr) return false;
  const rrd = pr.rawResultData;
  const ui = pr.ui;
  const fromRrd =
    rrd && typeof rrd === 'object' && !Array.isArray(rrd)
      ? String((rrd as Record<string, unknown>).reviewResult ?? '').trim()
      : '';
  const fromUi =
    ui && typeof ui === 'object' && !Array.isArray(ui)
      ? String((ui as Record<string, unknown>).reviewResult ?? '').trim()
      : '';
  if (fromRrd || fromUi) return true;
  return pr.result != null && String(pr.result).trim() !== '';
}

/** 열린 JSON 전체 슬롯 기준 검수 결과 요약 */
export function buildVlmReviewBriefReport(
  envelope: VlmFileEnvelope,
  sourceFileName: string
): VlmBriefReport | null {
  const n = vlmNavigableListCount(envelope);
  if (n <= 0) return null;

  const counts = new Map<string, number>();
  for (const opt of LOCAL_VLM_REVIEW_OPTIONS) {
    counts.set(opt.id, 0);
  }

  let explicitReviewCount = 0;
  let editedCount = 0;
  let withReviewerNotesCount = 0;

  for (let slot = 0; slot < n; slot++) {
    const src = vlmSourceDataForSlot(envelope, slot);
    if (!src) continue;
    const reviewId = vlmReviewResultFromSourceDataStr(src);
    counts.set(reviewId, (counts.get(reviewId) ?? 0) + 1);
    if (vlmHasExplicitReviewResult(src)) explicitReviewCount += 1;
    if (vlmEditedGptResponseFromSourceDataStr(src).trim()) editedCount += 1;
    if (vlmReviewerNotesForSlot(envelope, slot).trim()) withReviewerNotesCount += 1;
  }

  const totalItems = n;
  const breakdown: VlmBriefReportBreakdown[] = LOCAL_VLM_REVIEW_OPTIONS.map((opt) => {
    const count = counts.get(opt.id) ?? 0;
    const pct = totalItems > 0 ? Math.round((count / totalItems) * 1000) / 10 : 0;
    return { id: opt.id, label: opt.label, count, pct };
  });

  const needsFixTotal = breakdown
    .filter((row) => row.id !== 'NORMAL')
    .reduce((acc, row) => acc + row.count, 0);
  const needsFixPct = totalItems > 0 ? Math.round((needsFixTotal / totalItems) * 1000) / 10 : 0;

  return {
    sourceFileName,
    generatedAt: new Date().toLocaleString('ko-KR', { hour12: false }),
    totalItems,
    explicitReviewCount,
    implicitNormalCount: Math.max(0, totalItems - explicitReviewCount),
    editedCount,
    withReviewerNotesCount,
    needsFixTotal,
    needsFixPct,
    breakdown,
  };
}

function padReportLabel(label: string, width: number): string {
  const len = [...label].length;
  if (len >= width) return label;
  return label + ' '.repeat(width - len);
}

/** 클립보드·텍스트 저장용 간략 리포트 */
export function formatVlmReviewBriefReportText(report: VlmBriefReport): string {
  const lines: string[] = [
    'VLM 검수 리포트',
    '='.repeat(40),
    `원본: ${report.sourceFileName}`,
    `생성: ${report.generatedAt}`,
    `총 항목: ${report.totalItems.toLocaleString()}`,
    '',
    '검수 결과',
    '-'.repeat(40),
  ];

  for (const row of report.breakdown) {
    if (row.count === 0 && report.totalItems > 20) continue;
    const label = padReportLabel(row.label, 16);
    lines.push(`${label} ${row.count.toLocaleString().padStart(6)}  (${row.pct}%)`);
  }

  lines.push(
    '',
    '요약',
    '-'.repeat(40),
    `명시 검수: ${report.explicitReviewCount.toLocaleString()} / ${report.totalItems.toLocaleString()} (${report.totalItems > 0 ? Math.round((report.explicitReviewCount / report.totalItems) * 1000) / 10 : 0}%)`,
    `미검수(기본 정상): ${report.implicitNormalCount.toLocaleString()}`,
    `수정필요 합계: ${report.needsFixTotal.toLocaleString()} (${report.needsFixPct}%)`,
    `GPT 응답 수정: ${report.editedCount.toLocaleString()}`,
    `검수 메모 있음: ${report.withReviewerNotesCount.toLocaleString()}`
  );

  return lines.join('\n');
}
