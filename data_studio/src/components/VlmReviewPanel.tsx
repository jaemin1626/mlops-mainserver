import React, { useEffect, useLayoutEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { VlmOfflineTask } from '../vlmTypes';
import { VLM_ISSUE_PENDING } from '../vlmTypes';
import type { VlmDraftPayload, VlmReviewResult } from '../vlmMerge';
import {
  LOCAL_VLM_REVIEW_OPTIONS,
  VLM_REVIEW_OPTION_STYLE_PRESETS,
  resolveStoredReviewResult,
  vlmReviewOptionAllowsGptEdit,
} from '../vlmReviewOptions';
import { resolveVlmMediaFromSourceData } from '../vlmMedia';

/** 클립보드 JSON: 다른 항목/도구와 주고받기용 */
const VLM_REVIEW_CLIPBOARD_VERSION = 1 as const;

type VlmReviewClipboardPayload = {
  vlmReviewClipboard?: typeof VLM_REVIEW_CLIPBOARD_VERSION;
  reviewResult: VlmReviewResult;
  gptResponse: string;
};

function parseVlmReviewClipboard(text: string): { reviewResult: VlmReviewResult; gptResponse: string } | null {
  const t = String(text || '').trim();
  if (!t) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const reviewResult = resolveStoredReviewResult(o.reviewResult);
  if (!LOCAL_VLM_REVIEW_OPTIONS.some((opt) => opt.id === reviewResult)) return null;
  const gptResponse = o.gptResponse != null ? String(o.gptResponse) : '';
  return { reviewResult, gptResponse };
}

type VlmReviewPanelProps = {
  task: VlmOfflineTask;
  mediaAnchorDir?: string | null;
  mediaBasePath?: string | null;
  readOnly?: boolean;
  remainingCount?: number;
  isSaving?: boolean;
  showSubmitAndNext?: boolean;
  onRefreshTask?: () => void;
  onSaveDraft?: (payload: VlmDraftPayload) => Promise<void> | void;
  onSubmitCurrent?: (payload: VlmDraftPayload) => Promise<void> | void;
  onSubmitAndNext?: (payload: VlmDraftPayload) => Promise<void> | void;
  onDraftChange?: (payload: VlmDraftPayload) => void;
};

const safeParse = (raw?: string) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
};

const toIsoDate = (input: unknown): string => {
  if (!input) return '';
  const parsed = Date.parse(String(input));
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
};

const getTodayYmd = (): string => new Date().toISOString().slice(0, 10);

const isBlocked = (task: VlmOfflineTask) => task.status === VLM_ISSUE_PENDING;

const VlmReviewPanel: React.FC<VlmReviewPanelProps> = ({
  task,
  mediaAnchorDir = null,
  mediaBasePath = null,
  readOnly = false,
  remainingCount = 0,
  isSaving = false,
  showSubmitAndNext = false,
  onRefreshTask,
  onSaveDraft,
  onSubmitCurrent,
  onSubmitAndNext,
  onDraftChange,
}) => {
  /** 웹 export는 sourceData가 문자열이지만, JSON 파일은 { sourceData: { ... } } 로 한 겹 더 있을 수 있음 */
  const parsedRoot = useMemo(() => safeParse(task.sourceData), [task.sourceData]);
  const parsed = useMemo((): Record<string, unknown> | null => {
    if (parsedRoot == null || typeof parsedRoot !== 'object' || Array.isArray(parsedRoot)) return null;
    const pr = parsedRoot as Record<string, unknown>;
    if (pr.rawData || pr.rawResultData || pr.resolvedMediaPath || pr.resolvedImagePath || pr.legacyMedia || pr.legacyImage) return pr;
    const sd = pr.sourceData;
    if (typeof sd === 'string') {
      try {
        const inner = JSON.parse(sd) as unknown;
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      return pr;
    }
    if (sd && typeof sd === 'object' && !Array.isArray(sd)) return sd as Record<string, unknown>;
    return pr;
  }, [parsedRoot]);

  const rawData = useMemo((): Record<string, unknown> => {
    const r = parsed?.rawData;
    if (r && typeof r === 'object' && !Array.isArray(r)) return r as Record<string, unknown>;
    return {};
  }, [parsed]);
  /** 빈 객체를 매 렌더 새로 만들면 useLayoutEffect가 매번 돌아 검수 결과 선택이 초기화됨 */
  const rawResultData = useMemo((): Record<string, unknown> => {
    const r = parsed?.rawResultData;
    if (r && typeof r === 'object' && !Array.isArray(r)) return r as Record<string, unknown>;
    return {};
  }, [parsed]);
  const rd = rawData;
  /** result + original_response 보내기 JSON: 읽기 전용은 긴 original_response, 수정란은 conversations gpt value */
  const dualGptLayout = rawResultData.dualGptLayout === true;
  const uiFlat = useMemo((): Record<string, unknown> => {
    const u = parsed?.ui;
    if (u && typeof u === 'object' && !Array.isArray(u)) return u as Record<string, unknown>;
    return {};
  }, [parsed]);
  const conversations = Array.isArray(rd?.conversations) ? rd.conversations : [];
  const mediaView = useMemo(
    () => resolveVlmMediaFromSourceData(parsed, { anchorDir: mediaAnchorDir, mediaBase: mediaBasePath }),
    [parsed, mediaAnchorDir, mediaBasePath]
  );
  const { mediaPath, mediaType, mediaSrc } = mediaView;
  const isVideo = mediaType === 'video';

  const firstPrompt = useMemo(() => {
    const candidate = conversations.find((item: { from?: string; value?: string }) => {
      const from = String(item?.from || '').toLowerCase();
      return from === 'human' || from === 'user';
    });
    return String(candidate?.value || '');
  }, [conversations]);

  const firstResponse = useMemo(() => {
    const candidate = conversations.find((item: { from?: string; value?: string }) => {
      const from = String(item?.from || '').toLowerCase();
      return from === 'gpt' || from === 'assistant' || from === 'model';
    });
    if (candidate?.value) return String(candidate.value);
    return String(rawResultData?.answer || rawResultData?.response || '');
  }, [conversations, rawResultData]);
  /** 읽기 전용: 원본만. rawResultData.answer(레거시)는 편집본과 혼동될 수 있어 사용하지 않음 */
  const originalResponse = useMemo(() => {
    return String(rawResultData?.originalAnswer || firstResponse || '');
  }, [rawResultData, firstResponse]);

  const initialResult = useMemo<VlmReviewResult>(() => {
    const p = parsed;
    const ui = p?.ui && typeof p.ui === 'object' ? (p.ui as Record<string, unknown>) : null;
    const rrd = rawResultData;
    const raw = String(ui?.reviewResult ?? rrd?.reviewResult ?? '').trim();
    return resolveStoredReviewResult(raw);
  }, [parsed, rawResultData]);

  const initialDueDate = useMemo(() => {
    return toIsoDate(uiFlat.dueDate || rawResultData.dueDate || rawResultData.deadline) || getTodayYmd();
  }, [uiFlat, rawResultData]);

  const [reviewResult, setReviewResult] = useState<VlmReviewResult>(initialResult);
  const [inputPrompt, setInputPrompt] = useState<string>(firstPrompt);
  const [gptResponse, setGptResponse] = useState<string>(() =>
    vlmReviewOptionAllowsGptEdit(LOCAL_VLM_REVIEW_OPTIONS, initialResult)
      ? String(rawResultData.editedAnswer || uiFlat.editedGptResponse || '')
      : ''
  );
  const [dueDate, setDueDate] = useState<string>(initialDueDate);
  const [note, setNote] = useState<string>(String(task.reviewerNotes || ''));

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState<{ x: number; y: number } | null>(null);
  const [mediaLoadError, setMediaLoadError] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (isVideo) return;
    const el = imageContainerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const ZOOM_SPEED = 0.001;
      const delta = -e.deltaY * ZOOM_SPEED;
      setScale((prev) => Math.min(Math.max(0.1, prev + delta), 10));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [isVideo]);

  useLayoutEffect(() => {
    const gpt = vlmReviewOptionAllowsGptEdit(LOCAL_VLM_REVIEW_OPTIONS, initialResult)
      ? String(rawResultData.editedAnswer || uiFlat.editedGptResponse || '')
      : '';
    const due = initialDueDate || getTodayYmd();
    const n = String(task.reviewerNotes || '');
    setReviewResult(initialResult);
    setInputPrompt(firstPrompt);
    setGptResponse(gpt);
    setDueDate(initialDueDate);
    setNote(n);
    setIsPanning(false);
    setLastPanPos(null);
    setMediaLoadError(false);
    setVideoLoading(isVideo);
    onDraftChange?.({
      reviewResult: initialResult,
      inputPrompt: firstPrompt,
      gptResponse: gpt,
      dueDate: due,
      note: n,
    });
  }, [task.id, task.sourceData, task.reviewerNotes, initialResult, firstPrompt, firstResponse, initialDueDate, dualGptLayout, onDraftChange]);

  useEffect(() => {
    if (!isVideo) return;
    const video = videoRef.current;
    if (!video) return;
    setVideoLoading(true);
    video.pause();
    video.currentTime = 0;
    video.load();
  }, [task.id, mediaSrc, isVideo]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0 || e.button === 1 || e.button === 2) {
      setIsPanning(true);
      setLastPanPos({ x: e.clientX, y: e.clientY });
      e.preventDefault();
    }
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isPanning && lastPanPos) {
        const dx = e.clientX - lastPanPos.x;
        const dy = e.clientY - lastPanPos.y;
        setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
        setLastPanPos({ x: e.clientX, y: e.clientY });
      }
    },
    [isPanning, lastPanPos]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    setLastPanPos(null);
  }, []);

  useEffect(() => {
    if (isPanning) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    } else {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPanning, handleMouseMove, handleMouseUp]);

  const payload: VlmDraftPayload = {
    reviewResult,
    inputPrompt,
    gptResponse,
    dueDate: dueDate || getTodayYmd(),
    note,
  };

  useEffect(() => {
    onDraftChange?.(payload);
  }, [reviewResult, inputPrompt, gptResponse, dueDate, note, onDraftChange]);

  const canLoadMedia = Boolean(mediaSrc);
  const canEditResponse = !readOnly && vlmReviewOptionAllowsGptEdit(LOCAL_VLM_REVIEW_OPTIONS, reviewResult);
  const blocked = isBlocked(task);

  return (
    <div className="h-full overflow-auto bg-slate-950 p-5 space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-3">
          <h3 className="text-sm font-bold text-slate-200 mb-2">작업 정보</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-300">
            <div className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2">
              인덱스: {task.listItemIndex != null && task.listItemIndex !== '' ? task.listItemIndex : '-'}
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2">작업 ID: {task.sourceRefId || task.id}</div>
            <div
              className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2 md:col-span-2 break-all min-w-0"
              title={mediaPath || undefined}
            >
              미디어 ({isVideo ? '영상' : '이미지'}) 경로: {mediaPath || '-'}
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2">남은 작업: {Math.max(0, remainingCount)}건</div>
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-2">
          <button
            type="button"
            onClick={onRefreshTask}
            disabled={isSaving}
            className="w-full py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-sm font-semibold disabled:opacity-50"
          >
            새로고침
          </button>
          <button
            type="button"
            onClick={() => onSaveDraft?.(payload)}
            disabled={readOnly || isSaving || blocked}
            className="w-full py-2 rounded-lg bg-cyan-900/40 hover:bg-cyan-900/60 border border-cyan-800 text-cyan-200 text-sm font-semibold disabled:opacity-50"
          >
            임시 저장
          </button>
          <button
            type="button"
            onClick={() => onSubmitCurrent?.(payload)}
            disabled={readOnly || isSaving || blocked}
            className="w-full py-2 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white text-sm font-bold disabled:opacity-50"
          >
            작업 제출
          </button>
          {showSubmitAndNext && onSubmitAndNext && (
            <button
              type="button"
              onClick={() => onSubmitAndNext(payload)}
              disabled={readOnly || isSaving || blocked}
              className="w-full py-2 rounded-lg bg-lime-600 hover:bg-lime-500 text-white text-sm font-bold disabled:opacity-50"
            >
              다음 작업
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div
          ref={imageContainerRef}
          className="bg-slate-900 border border-slate-800 rounded-xl p-3 h-[55vh] min-h-[320px] flex items-center justify-center relative overflow-hidden"
          onMouseDown={isVideo ? undefined : handleMouseDown}
          onContextMenu={isVideo ? undefined : (e) => e.preventDefault()}
          style={{ cursor: isVideo ? 'default' : isPanning ? 'grabbing' : 'grab' }}
        >
          {canLoadMedia && !mediaLoadError ? (
            isVideo ? (
              <>
                {videoLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-slate-300 text-xs px-4 text-center z-10">
                    영상 준비 중… (첫 재생 시 H.264 변환으로 10~30초 걸릴 수 있습니다)
                  </div>
                )}
                <video
                  ref={videoRef}
                  key={mediaSrc}
                  src={mediaSrc}
                  controls
                  playsInline
                  preload="auto"
                  className="h-full max-w-full rounded-lg border border-slate-700 object-contain bg-black"
                  onLoadStart={() => setVideoLoading(true)}
                  onLoadedData={() => setVideoLoading(false)}
                  onCanPlay={() => setVideoLoading(false)}
                  onError={() => {
                    setVideoLoading(false);
                    setMediaLoadError(true);
                  }}
                />
              </>
            ) : (
              <div
                className="relative origin-center h-full flex items-center justify-center"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                  transition: isPanning ? 'none' : 'transform 0.075s ease-out',
                }}
              >
                <img
                  src={mediaSrc}
                  alt={task.name}
                  className="h-full max-w-full rounded-lg border border-slate-700 object-contain pointer-events-none select-none"
                  draggable={false}
                  onError={() => setMediaLoadError(true)}
                />
              </div>
            )
          ) : (
            <div className="text-xs text-slate-500 break-all p-3 bg-slate-950 border border-slate-800 rounded-md w-full">
              {mediaLoadError ? (
                <>
                  {isVideo ? '영상' : '이미지'}을 불러올 수 없습니다.
                  <br />
                  미디어 경로: {mediaPath || '-'}
                  {mediaSrc ? (
                    <>
                      <br />
                      요청 URL: {mediaSrc}
                      <br />
                      원본이 mp4v 코덱이면 서버에서 H.264로 변환합니다. 변환 실패 시 ffmpeg 로그를 확인하세요.
                    </>
                  ) : null}
                </>
              ) : (
                <>미디어 경로: {mediaPath || '-'}</>
              )}
            </div>
          )}
          {!isVideo && (
          <div className="absolute top-2 left-2 right-2 flex items-center justify-between gap-2 pointer-events-none">
            <div className="flex gap-1 pointer-events-auto">
              {[
                { value: 1, label: '100%' },
                { value: 0.75, label: '75%' },
                { value: 0.5, label: '50%' },
                { value: 0.25, label: '25%' },
                { value: 0.15, label: '최소' },
              ].map(({ value, label }) => {
                const isActive = Math.abs(scale - value) < 0.02;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => {
                      setScale(value);
                      setPan({ x: 0, y: 0 });
                    }}
                    className={`px-2 py-1 rounded text-[12px] font-medium border transition-colors ${isActive ? 'bg-sky-600 border-sky-500 text-white' : 'bg-slate-900/90 border-slate-600 text-slate-300 hover:bg-slate-800 hover:border-slate-500'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <span className="bg-slate-900/80 text-slate-400 text-[11px] px-2 py-1 rounded border border-slate-700 select-none">
              마우스 휠: 확대/축소, 드래그: 이동
            </span>
          </div>
          )}
        </div>
        <div className="space-y-3">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <label className="block text-xs text-slate-500 font-bold mb-2">입력 프롬프트</label>
            <textarea
              value={inputPrompt}
              readOnly
              className="w-full h-28 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-slate-200 outline-none focus:border-cyan-600 cursor-default"
            />
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <label className="block text-xs text-slate-500 font-bold mb-2">GPT 응답</label>
            <textarea
              value={originalResponse}
              readOnly
              className="w-full h-32 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-slate-200 outline-none focus:border-cyan-600"
            />
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <h3 className="text-xs font-bold text-slate-200 mb-2">검수 결과</h3>
            <div className="flex flex-wrap gap-2">
              {LOCAL_VLM_REVIEW_OPTIONS.map((option, idx) => {
                const style = VLM_REVIEW_OPTION_STYLE_PRESETS[idx % VLM_REVIEW_OPTION_STYLE_PRESETS.length];
                const isChecked = reviewResult === option.id;
                return (
                  <label
                    key={option.id}
                    className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all cursor-pointer ${isChecked ? style.activeClass : `${style.className} opacity-45 hover:opacity-70`} ${isChecked ? `ring-2 ring-offset-2 ring-offset-slate-900 ${style.ring}` : ''}`}
                  >
                    <input
                      type="radio"
                      name="vlm-review-result"
                      checked={isChecked}
                      onChange={() => setReviewResult(option.id)}
                      disabled={readOnly || isSaving || blocked}
                      className="sr-only"
                    />
                    {option.label}
                  </label>
                );
              })}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2 mb-2">
              <label className="text-xs text-slate-500 font-bold shrink-0">GPT 응답 수정</label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setGptResponse(dualGptLayout ? firstResponse : originalResponse)}
                  disabled={isSaving || blocked}
                  className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[12px] font-semibold text-slate-200 disabled:opacity-50"
                >
                  응답 복사
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const payloadJson: VlmReviewClipboardPayload = {
                      vlmReviewClipboard: VLM_REVIEW_CLIPBOARD_VERSION,
                      reviewResult,
                      gptResponse,
                    };
                    try {
                      await navigator.clipboard.writeText(JSON.stringify(payloadJson));
                    } catch {
                      window.alert('클립보드 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.');
                    }
                  }}
                  disabled={isSaving || blocked}
                  title="검수 결과와 수정란 텍스트를 JSON으로 복사"
                  className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[12px] font-semibold text-slate-200 disabled:opacity-50"
                >
                  검수+수정 복사
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (readOnly || blocked) return;
                    try {
                      const text = await navigator.clipboard.readText();
                      const parsed = parseVlmReviewClipboard(text);
                      if (!parsed) {
                        window.alert(
                          '클립보드 내용을 읽을 수 없습니다. 「검수+수정 복사」로 만든 JSON인지 확인해 주세요.'
                        );
                        return;
                      }
                      setReviewResult(parsed.reviewResult);
                      setGptResponse(parsed.gptResponse);
                    } catch (_e) {
                      window.alert('클립보드 읽기에 실패했습니다. 권한을 확인해 주세요.');
                    }
                  }}
                  disabled={readOnly || isSaving || blocked}
                  title="JSON에서 검수 결과와 수정란을 한꺼번에 적용"
                  className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[12px] font-semibold text-slate-200 disabled:opacity-50"
                >
                  검수+수정 붙여넣기
                </button>
              </div>
            </div>
            <textarea
              value={gptResponse}
              onChange={(e) => setGptResponse(e.target.value)}
              readOnly={!canEditResponse}
              className="w-full h-28 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-slate-200 outline-none focus:border-cyan-600"
            />
            {!readOnly && !canEditResponse && (
              <p className="text-[12px] text-slate-500 mt-1">GPT 수정이 허용된 검수 결과를 선택하면 입력할 수 있습니다.</p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-3">
          <label className="block text-xs text-slate-500 font-bold mb-2">검수 메모</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            readOnly={readOnly || blocked}
            className="w-full h-24 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-slate-200 outline-none focus:border-cyan-600"
          />
          <div>
            <label className="block text-[12px] text-slate-500 font-bold mb-1">작업 날짜</label>
            <input
              type="date"
              value={dueDate}
              readOnly
              disabled
              className="w-full max-w-[260px] bg-slate-950 border border-slate-800 rounded-md px-2.5 py-1.5 text-xs text-slate-300 outline-none"
            />
          </div>
        </div>
      </div>

      {readOnly && <div className="text-xs text-slate-500">읽기 전용 모드입니다.</div>}
    </div>
  );
};

export default VlmReviewPanel;
