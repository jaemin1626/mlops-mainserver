import type { VlmOfflineTask } from './vlmTypes';

export type VlmDraftPayload = {
  inputPrompt: string;
  gptResponse: string;
};

/** @deprecated labeling mode — review result no longer used */
export type VlmReviewResult = string;

function findConversationIndex(conversations: unknown[], roles: string[]): number {
  if (!Array.isArray(conversations)) return -1;
  return conversations.findIndex((c) => {
    if (!c || typeof c !== 'object') return false;
    const from = String((c as Record<string, unknown>).from ?? '').toLowerCase();
    return roles.includes(from);
  });
}

/** conversations에 프롬프트·GPT 응답 반영 (ShareGPT 단일 항목) */
export function mergeVlmPayloadIntoSourceData(task: Pick<VlmOfflineTask, 'sourceData'>, payload: VlmDraftPayload): string {
  let parsed: Record<string, unknown> = {};
  try {
    if (typeof task.sourceData === 'string' && task.sourceData) {
      parsed = JSON.parse(task.sourceData) as Record<string, unknown>;
    } else if (task.sourceData && typeof task.sourceData === 'object') {
      parsed = task.sourceData as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  const rawData = parsed.rawData;
  if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
    parsed = {
      ...parsed,
      conversations: (rawData as Record<string, unknown>).conversations ?? parsed.conversations,
      image: parsed.image ?? extractVlmMediaPathFromRecord(parsed),
    };
  }

  delete parsed.ui;
  delete parsed.rawResultData;
  delete parsed.rawData;
  delete parsed.resolvedImagePath;
  delete parsed.resolvedMediaPath;
  delete parsed.original_response;
  delete parsed.result;
  delete parsed.dueDate;

  let conversations: unknown[] = Array.isArray(parsed.conversations) ? [...parsed.conversations] : [];
  const humanIdx = findConversationIndex(conversations, ['human', 'user']);
  if (humanIdx >= 0) {
    const prev = conversations[humanIdx] as Record<string, unknown>;
    conversations[humanIdx] = { ...prev, from: prev.from ?? 'human', value: payload.inputPrompt };
  } else {
    conversations.unshift({ from: 'human', value: payload.inputPrompt });
  }

  const gptIdx = findConversationIndex(conversations, ['gpt', 'assistant', 'model']);
  if (gptIdx >= 0) {
    const prev = conversations[gptIdx] as Record<string, unknown>;
    conversations[gptIdx] = { ...prev, from: prev.from ?? 'gpt', value: payload.gptResponse };
  } else {
    conversations.push({ from: 'gpt', value: payload.gptResponse });
  }

  parsed.conversations = conversations;
  return JSON.stringify(parsed);
}

function extractVlmMediaPathFromRecord(record: Record<string, unknown>): string {
  const media = String(record.media ?? '').trim();
  if (media) return media;
  const video = String(record.video ?? record.video_path ?? record.videoPath ?? '').trim();
  if (video) return video;
  return String(record.image ?? record.image_path ?? record.imagePath ?? '').trim();
}
