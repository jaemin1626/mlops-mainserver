import React, { useEffect, useLayoutEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { VlmOfflineTask } from '../vlmTypes';
import type { VlmDraftPayload } from '../vlmMerge';
import { inferVlmMediaType, resolveVlmMediaFromSourceData } from '../vlmMedia';

type VlmReviewPanelProps = {
  task: VlmOfflineTask;
  mediaAnchorDir?: string | null;
  mediaBasePath?: string | null;
  /** scanFolder imageUrl — JSON 경로 해석 실패 시 fallback */
  directMediaSrc?: string | null;
  readOnly?: boolean;
  positionLabel?: string;
  isSaving?: boolean;
  onRefreshTask?: () => void;
  onSave?: (payload: VlmDraftPayload) => Promise<void> | void;
  onDraftChange?: (payload: VlmDraftPayload) => void;
};

function resolvePanelMediaType(
  mediaView: ReturnType<typeof resolveVlmMediaFromSourceData>,
  directMediaSrc: string | null | undefined
): 'image' | 'video' {
  if (mediaView.mediaType === 'video') return 'video';
  if (mediaView.mediaType === 'image' && mediaView.mediaSrc) return 'image';
  const fallback = String(directMediaSrc || mediaView.mediaPath || '');
  return inferVlmMediaType(fallback) === 'video' ? 'video' : 'image';
}

const safeParse = (raw?: string) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const VlmReviewPanel: React.FC<VlmReviewPanelProps> = ({
  task,
  mediaAnchorDir = null,
  mediaBasePath = null,
  directMediaSrc = null,
  readOnly = false,
  positionLabel = '',
  isSaving = false,
  onRefreshTask,
  onSave,
  onDraftChange,
}) => {
  const parsedRoot = useMemo(() => safeParse(task.sourceData), [task.sourceData]);
  const parsed = useMemo((): Record<string, unknown> | null => {
    if (parsedRoot == null || typeof parsedRoot !== 'object' || Array.isArray(parsedRoot)) return null;
    const pr = parsedRoot as Record<string, unknown>;
    if (pr.rawData || pr.rawResultData || pr.resolvedMediaPath || pr.resolvedImagePath || pr.legacyMedia || pr.legacyImage) {
      return pr;
    }
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

  const rawResultData = useMemo((): Record<string, unknown> => {
    const r = parsed?.rawResultData;
    if (r && typeof r === 'object' && !Array.isArray(r)) return r as Record<string, unknown>;
    return {};
  }, [parsed]);

  const conversations = Array.isArray(rawData?.conversations)
    ? rawData.conversations
    : Array.isArray(parsed?.conversations)
      ? parsed.conversations
      : [];

  const mediaView = useMemo(
    () => resolveVlmMediaFromSourceData(parsed, { anchorDir: mediaAnchorDir, mediaBase: mediaBasePath }),
    [parsed, mediaAnchorDir, mediaBasePath]
  );
  const { mediaPath } = mediaView;
  const mediaType = resolvePanelMediaType(mediaView, directMediaSrc);
  const mediaSrc = mediaView.mediaSrc || directMediaSrc || '';
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
    const edited = String(rawResultData?.editedAnswer ?? '').trim();
    if (edited) return edited;
    return String(rawResultData?.originalAnswer ?? rawResultData?.answer ?? rawResultData?.response ?? '');
  }, [conversations, rawResultData]);

  const [inputPrompt, setInputPrompt] = useState<string>(firstPrompt);
  const [gptResponse, setGptResponse] = useState<string>(firstResponse);

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

  /** 항목 이동(task.id) 시에만 폼·미디어 상태 초기화 — 저장으로 sourceData만 바뀔 때 영상 재로드 방지 */
  useLayoutEffect(() => {
    setInputPrompt(firstPrompt);
    setGptResponse(firstResponse);
    setIsPanning(false);
    setLastPanPos(null);
    setMediaLoadError(false);
    setVideoLoading(isVideo);
    onDraftChange?.({
      inputPrompt: firstPrompt,
      gptResponse: firstResponse,
    });
  }, [task.id, isVideo, onDraftChange, firstPrompt, firstResponse]);

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
    inputPrompt,
    gptResponse,
  };

  useEffect(() => {
    onDraftChange?.(payload);
  }, [inputPrompt, gptResponse, onDraftChange]);

  const canLoadMedia = Boolean(mediaSrc);

  return (
    <div className="h-full overflow-auto bg-slate-950 p-5 space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-3">
          <h3 className="text-sm font-bold text-slate-200 mb-2">작업 정보</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-300">
            {positionLabel ? (
              <div className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2">{positionLabel}</div>
            ) : null}
            <div className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2">
              인덱스: {task.listItemIndex != null && task.listItemIndex !== '' ? task.listItemIndex : '-'}
            </div>
            <div
              className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2 md:col-span-2 break-all min-w-0"
              title={mediaPath || undefined}
            >
              미디어 ({isVideo ? '영상' : '이미지'}) 경로: {mediaPath || task.name || '-'}
            </div>
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
            onClick={() => onSave?.(payload)}
            disabled={readOnly || isSaving}
            className="w-full py-2 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white text-sm font-bold disabled:opacity-50"
          >
            저장 (Ctrl+S)
          </button>
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
            <label className="block text-xs text-slate-500 font-bold mb-2">질의</label>
            <textarea
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              readOnly={readOnly}
              className="w-full h-28 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-slate-200 outline-none focus:border-cyan-600"
            />
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <label className="block text-xs text-slate-500 font-bold mb-2">응답</label>
            <textarea
              value={gptResponse}
              onChange={(e) => setGptResponse(e.target.value)}
              readOnly={readOnly}
              className="w-full h-48 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-slate-200 outline-none focus:border-cyan-600"
            />
          </div>
        </div>
      </div>

      {readOnly && <div className="text-xs text-slate-500">읽기 전용 모드입니다.</div>}
    </div>
  );
};

export default VlmReviewPanel;
