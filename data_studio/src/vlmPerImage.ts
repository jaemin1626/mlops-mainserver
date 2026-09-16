import { parseVlmJsonFile, vlmNavigableListCount, vlmSourceDataForSlot } from './vlmFileIO';
import { extractVlmMediaPathFromRecord, inferVlmMediaType } from './vlmMedia';
import type { VlmDraftPayload } from './vlmMerge';

function padIndex(n: number): string {
  return String(Math.max(0, n)).padStart(7, '0');
}

function isSharegptItem(o: Record<string, unknown>): boolean {
  return Boolean(extractVlmMediaPathFromRecord(o)) && Array.isArray(o.conversations);
}

function normalizeAbsMediaPath(path: string): string {
  return String(path || '').trim().replace(/\\/g, '/');
}

/** JSON 파일 없을 때 기본 항목 */
export function createDefaultSourceData(mediaAbsPath: string, listIndex: number): string {
  const abs = normalizeAbsMediaPath(mediaAbsPath);
  const mediaType = inferVlmMediaType(abs);
  const base = {
    index: padIndex(listIndex),
    mediaType,
    conversations: [
      { from: 'human', value: '' },
      { from: 'gpt', value: '' },
    ],
  };
  if (mediaType === 'video') {
    return JSON.stringify({ ...base, video: abs });
  }
  return JSON.stringify({ ...base, image: abs });
}

/** 이미지당 JSON 파일 → VlmReviewPanel sourceData 문자열 */
export function parsePerImageJsonFile(text: string, mediaAbsPath: string, listIndex: number): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) return createDefaultSourceData(mediaAbsPath, listIndex);

  try {
    const direct = JSON.parse(trimmed) as unknown;
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      const rec = direct as Record<string, unknown>;
      if (isSharegptItem(rec)) return JSON.stringify(rec);
    }
    if (Array.isArray(direct) && direct.length > 0) {
      const first = direct[0];
      if (first && typeof first === 'object' && !Array.isArray(first) && isSharegptItem(first as Record<string, unknown>)) {
        return JSON.stringify(first);
      }
    }
  } catch {
    /* fall through to envelope parser */
  }

  const { sourceDataStr, envelope } = parseVlmJsonFile(trimmed);
  const n = vlmNavigableListCount(envelope);
  if (n > 0) {
    const slot = vlmSourceDataForSlot(envelope, 0);
    if (slot) return slot;
  }
  if (sourceDataStr) return sourceDataStr;
  return createDefaultSourceData(mediaAbsPath, listIndex);
}

function findConversationIndex(conversations: unknown[], roles: string[]): number {
  if (!Array.isArray(conversations)) return -1;
  return conversations.findIndex((c) => {
    if (!c || typeof c !== 'object') return false;
    const from = String((c as Record<string, unknown>).from ?? '').toLowerCase();
    return roles.includes(from);
  });
}

function toSharegptItem(
  sourceDataStr: string,
  payload: VlmDraftPayload,
  mediaAbsPath: string,
  listIndex: number
): Record<string, unknown> {
  let item: Record<string, unknown> = {};
  try {
    if (sourceDataStr) {
      const parsed = JSON.parse(sourceDataStr) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        item = { ...(parsed as Record<string, unknown>) };
      }
    }
  } catch {
    /* fresh item */
  }

  const rawData = item.rawData;
  if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
    const rd = rawData as Record<string, unknown>;
    item = {
      ...item,
      index: item.index ?? rd.index,
      conversations: rd.conversations ?? item.conversations,
      image: extractVlmMediaPathFromRecord(rd) || extractVlmMediaPathFromRecord(item) || mediaAbsPath,
    };
  }

  delete item.ui;
  delete item.rawResultData;
  delete item.rawData;
  delete item.resolvedImagePath;
  delete item.resolvedMediaPath;
  delete item.legacyImage;
  delete item.legacyMedia;
  delete item.original_response;
  delete item.result;
  delete item.dueDate;

  const mediaPath = normalizeAbsMediaPath(mediaAbsPath);
  const mediaType = inferVlmMediaType(mediaPath, item.mediaType);
  item.index = item.index ?? padIndex(listIndex);

  delete item.media;
  delete item.image;
  delete item.video;
  if (mediaType === 'video') item.video = mediaPath;
  else item.image = mediaPath;
  item.mediaType = mediaType;

  let conversations: unknown[] = Array.isArray(item.conversations) ? [...item.conversations] : [];
  const humanIdx = findConversationIndex(conversations, ['human', 'user']);
  if (humanIdx >= 0) {
    const prev = conversations[humanIdx] as Record<string, unknown>;
    conversations[humanIdx] = { ...prev, from: prev.from ?? 'human', value: payload.inputPrompt };
  } else {
    conversations = [{ from: 'human', value: payload.inputPrompt }, ...conversations];
  }

  const gptIdx = findConversationIndex(conversations, ['gpt', 'assistant', 'model']);
  if (gptIdx >= 0) {
    const prev = conversations[gptIdx] as Record<string, unknown>;
    conversations[gptIdx] = { ...prev, from: prev.from ?? 'gpt', value: payload.gptResponse };
  } else {
    conversations.push({ from: 'gpt', value: payload.gptResponse });
  }

  item.conversations = conversations;
  return item;
}

/** 이미지당 JSON 파일 본문 (pretty-print) */
export function buildPerImageJsonFileContent(
  sourceDataStr: string,
  payload: VlmDraftPayload,
  mediaAbsPath: string,
  listIndex: number
): string {
  const item = toSharegptItem(sourceDataStr, payload, mediaAbsPath, listIndex);
  return `${JSON.stringify(item, null, 2)}\n`;
}
