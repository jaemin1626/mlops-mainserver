import React, { useCallback, useEffect, useRef, useState } from 'react';
import VlmReviewPanel from '../components/VlmReviewPanel';
import VlmReexportModal from '../components/VlmReexportModal';
import VlmBriefReportModal from '../components/VlmBriefReportModal';
import type { VlmDraftPayload } from '../vlmMerge';
import { mergeVlmPayloadIntoSourceData } from '../vlmMerge';
import type { VlmOfflineTask } from '../vlmTypes';
import {
  buildVlmJsonFileContent,
  buildVlmReReviewExportJson,
  buildVlmReviewBriefReport,
  parseVlmJsonFile,
  vlmExportRowMetaForSlot,
  vlmCurrentSlot,
  vlmEnvelopeAtSlot,
  vlmEditedGptResponseFromSourceDataStr,
  vlmInputPromptFromSourceDataStr,
  vlmReviewResultFromSourceDataStr,
  vlmNavigableListCount,
  vlmSourceDataForSlot,
  vlmReviewerNotesForSlot,
  vlmItemListIndex,
  type VlmFileEnvelope,
  type VlmExportRowMeta,
  type VlmBriefReport,
} from '../vlmFileIO';
import { LOCAL_VLM_REVIEW_OPTIONS, VLM_REVIEW_OPTION_STYLE_PRESETS } from '../vlmReviewOptions';

/** JSON 파일이 있는 폴더 (미디어 기준 미지정 시 fallback) */
function dirnameOfFile(filePath: string): string {
  const trimmed = filePath.trim().replace(/[/\\]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (i <= 0) {
    if (trimmed.length >= 2 && trimmed[1] === ':') return trimmed.slice(0, 2);
    return trimmed;
  }
  return trimmed.slice(0, i);
}

const VLM_SIBLING_MEDIA_DIRS = ['images', 'videos', 'media'] as const;

function siblingMediaDirCandidates(jsonPath: string): string[] {
  const jsonDir = dirnameOfFile(jsonPath);
  const parent = dirnameOfFile(jsonDir);
  const folderName = jsonDir.replace(/^.*[/\\]/, '').toLowerCase();
  if (folderName.includes('video')) return ['videos', 'media', 'images'];
  if (folderName.includes('image')) return ['images', 'media', 'videos'];
  return [...VLM_SIBLING_MEDIA_DIRS];
}

async function siblingMediaDir(jsonPath: string): Promise<string | null> {
  const jsonDir = dirnameOfFile(jsonPath);
  const parent = dirnameOfFile(jsonDir);
  for (const name of siblingMediaDirCandidates(jsonPath)) {
    const dir = `${parent}/${name}`;
    try {
      const response = await fetch(`/data-studio/api/fs/list?path=${encodeURIComponent(dir)}`);
      if (response.ok) return dir;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

const VLM_MEDIA_BASE_STORAGE_KEY = 'vlm-media-base-path';

const VlmWorkspace: React.FC = () => {
  const [jsonPath, setJsonPath] = useState<string | null>(null);
  const [mediaBasePath, setMediaBasePath] = useState<string | null>(null);
  const [envelope, setEnvelope] = useState<VlmFileEnvelope | null>(null);
  const [task, setTask] = useState<VlmOfflineTask | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [gotoInput, setGotoInput] = useState('');
  const [promptFilterQuery, setPromptFilterQuery] = useState('');
  const [editedFilterQuery, setEditedFilterQuery] = useState('');
  const [reviewResultFilter, setReviewResultFilter] = useState<string[]>([]);
  const [filteredSlotIndices, setFilteredSlotIndices] = useState<number[] | null>(null);
  const [promptFilterScanning, setPromptFilterScanning] = useState(false);
  const [promptFilterProgress, setPromptFilterProgress] = useState<{ done: number; total: number } | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportRows, setExportRows] = useState<VlmExportRowMeta[]>([]);
  const [exportSelectedSlots, setExportSelectedSlots] = useState<Set<number>>(() => new Set());
  const [exportReviewFilter, setExportReviewFilter] = useState<string[]>([]);
  const [exportBusy, setExportBusy] = useState(false);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportData, setReportData] = useState<VlmBriefReport | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const draftRef = useRef<VlmDraftPayload | null>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);
  const lastOpenedJsonPathRef = useRef<string | null>(null);
  const envelopeBaseRef = useRef<VlmFileEnvelope | null>(null);
  const promptFilterCancelRef = useRef(0);
  const mediaBasePathRef = useRef<string | null>(null);
  mediaBasePathRef.current = mediaBasePath;

  const isElectron = typeof window !== 'undefined' && !!window.electron;

  const syncMediaRoots = useCallback(async (jsonDir: string) => {
    if (!window.electron) return;
    const base = mediaBasePathRef.current;
    if (base) {
      await window.electron.setMediaBaseRoot(base);
      await window.electron.setWorkspaceRoot(jsonDir);
    } else {
      await window.electron.setMediaBaseRoot(null);
      await window.electron.setWorkspaceRoot(jsonDir);
    }
  }, []);

  useEffect(() => {
    if (!window.electron) return;
    const saved = localStorage.getItem(VLM_MEDIA_BASE_STORAGE_KEY);
    if (!saved) return;
    void window.electron.setMediaBaseRoot(saved).then(() => setMediaBasePath(saved));
  }, []);

  const loadJsonFromPath = useCallback(async (filePath: string, preserveSlot?: number) => {
    if (!window.electron) return;
    const res = await window.electron.readJsonFile(filePath);
    if (!res.ok) {
      setStatusMessage('JSON 읽기 실패: ' + (res.error || ''));
      return;
    }
    if (lastOpenedJsonPathRef.current !== filePath) {
      setFilteredSlotIndices(null);
      setPromptFilterQuery('');
      setEditedFilterQuery('');
      setReviewResultFilter([]);
      setPromptFilterProgress(null);
      promptFilterCancelRef.current += 1;
    }
    lastOpenedJsonPathRef.current = filePath;

    const { sourceDataStr, reviewerNotes, envelope: env } = parseVlmJsonFile(res.text || '');
    const n = vlmNavigableListCount(env);
    const base = filePath.replace(/^.*[/\\]/, '') || 'task.json';
    const jsonDir = dirnameOfFile(filePath);
    const auto = await siblingMediaDir(filePath);
    if (auto) {
      await window.electron.setMediaBaseRoot(auto);
      mediaBasePathRef.current = auto;
      setMediaBasePath(auto);
      localStorage.setItem(VLM_MEDIA_BASE_STORAGE_KEY, auto);
      await window.electron.setWorkspaceRoot(jsonDir);
    } else {
      await syncMediaRoots(jsonDir);
    }
    setJsonPath(filePath);
    envelopeBaseRef.current = n > 0 ? env : null;

    if (n > 0) {
      let slot = preserveSlot ?? vlmCurrentSlot(env);
      slot = Math.max(0, Math.min(slot, n - 1));
      const env2 = vlmEnvelopeAtSlot(env, slot);
      const slotMeta = vlmSourceDataForSlot(env, slot);
      const src = slotMeta ?? sourceDataStr;
      const notes = vlmReviewerNotesForSlot(env, slot) || reviewerNotes;
      setEnvelope(env2);
      setTask({
        id: `${filePath}#${slot}`,
        name: base,
        sourceData: src,
        reviewerNotes: notes,
        listItemIndex: vlmItemListIndex(env, slot),
        sourceRefId: `${slot + 1} / ${n}`,
        sourceFile: filePath,
      });
      setStatusMessage(`항목 ${slot + 1}/${n} (A/D · ←/→)`);
    } else {
      setEnvelope(env);
      setTask({
        id: filePath,
        name: base,
        sourceData: sourceDataStr,
        reviewerNotes,
        listItemIndex: '',
        sourceRefId: base,
        sourceFile: filePath,
      });
      setStatusMessage('JSON 열림');
    }
  }, [syncMediaRoots]);

  const handleOpenJson = useCallback(async () => {
    if (!window.electron) return;
    try {
      const path = await window.electron.openJsonFileDialog();
      if (!path) return;
      await loadJsonFromPath(path);
    } catch (e) {
      setStatusMessage('JSON 파일 열기 실패: ' + (e as Error).message);
    }
  }, [loadJsonFromPath]);

  const persistMerged = useCallback(
    async (payload: VlmDraftPayload) => {
      if (!window.electron || !jsonPath || !task) return false;
      const slotKeep = envelope ? vlmCurrentSlot(envelope) : 0;
      const mergedSource = mergeVlmPayloadIntoSourceData(task, payload);
      const body = buildVlmJsonFileContent(envelope, mergedSource, payload.note);
      const ok = await window.electron.writeJsonFile(jsonPath, body);
      if (!ok) {
        setStatusMessage('저장 실패 (디스크 쓰기)');
        return false;
      }
      await loadJsonFromPath(jsonPath, slotKeep);
      setStatusMessage(`저장됨: ${jsonPath}`);
      return true;
    },
    [jsonPath, task, envelope, loadJsonFromPath]
  );

  const handleSaveDraft = useCallback(
    async (payload: VlmDraftPayload) => {
      setIsSaving(true);
      try {
        await persistMerged(payload);
      } finally {
        setIsSaving(false);
      }
    },
    [persistMerged]
  );

  const handleSubmitCurrent = useCallback(
    async (payload: VlmDraftPayload) => {
      await handleSaveDraft(payload);
    },
    [handleSaveDraft]
  );

  const handleRefresh = useCallback(async () => {
    if (!jsonPath || !window.electron) return;
    const slot = envelope ? vlmCurrentSlot(envelope) : 0;
    await loadJsonFromPath(jsonPath, slot);
  }, [jsonPath, envelope, loadJsonFromPath]);

  const handleDraftChange = useCallback((p: VlmDraftPayload) => {
    draftRef.current = p;
  }, []);

  const persistMergedRef = useRef(persistMerged);
  persistMergedRef.current = persistMerged;
  const loadJsonFromPathRef = useRef(loadJsonFromPath);
  loadJsonFromPathRef.current = loadJsonFromPath;

  const filteredSlotIndicesRef = useRef<number[] | null>(null);
  filteredSlotIndicesRef.current = filteredSlotIndices;

  const applyPromptFilter = useCallback(async () => {
    const base = envelopeBaseRef.current;
    const path = jsonPath;
    if (!base || !path || !window.electron) return;
    const promptNeedle = promptFilterQuery.trim().toLowerCase();
    const editedNeedle = editedFilterQuery.trim().toLowerCase();
    const reviewFilter = reviewResultFilter;
    if (!promptNeedle && !editedNeedle && reviewFilter.length === 0) {
      setFilteredSlotIndices(null);
      setStatusMessage('필터를 끄고 전체 목록 기준으로 이동합니다.');
      return;
    }
    const n = vlmNavigableListCount(base);
    if (n <= 1) {
      setStatusMessage('여러 항목이 있는 JSON에서만 목록 필터를 쓸 수 있습니다.');
      return;
    }
    const scanId = ++promptFilterCancelRef.current;
    setPromptFilterScanning(true);
    setPromptFilterProgress({ done: 0, total: n });
    const hits: number[] = [];
    for (let i = 0; i < n; i++) {
      if (promptFilterCancelRef.current !== scanId) {
        setPromptFilterScanning(false);
        setPromptFilterProgress(null);
        return;
      }
      const src = vlmSourceDataForSlot(base, i);
      const promptText = src ? vlmInputPromptFromSourceDataStr(src) : '';
      const editedText = src ? vlmEditedGptResponseFromSourceDataStr(src) : '';
      const reviewId = src ? vlmReviewResultFromSourceDataStr(src) : 'NORMAL';
      const promptOk = !promptNeedle || promptText.toLowerCase().includes(promptNeedle);
      const editedOk = !editedNeedle || editedText.toLowerCase().includes(editedNeedle);
      const reviewOk = reviewFilter.length === 0 || reviewFilter.includes(reviewId);
      if (promptOk && editedOk && reviewOk) hits.push(i);
      if (i % 48 === 0 || i === n - 1) {
        setPromptFilterProgress({ done: i + 1, total: n });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (promptFilterCancelRef.current !== scanId) return;
    setPromptFilterScanning(false);
    setPromptFilterProgress(null);
    if (hits.length === 0) {
      setFilteredSlotIndices(null);
      setStatusMessage('조건에 맞는 항목이 없습니다. (프롬프트·수정란·검수결과 AND)');
      return;
    }
    setFilteredSlotIndices(hits);
    const cur = envelope ? vlmCurrentSlot(envelope) : 0;
    if (!hits.includes(cur)) {
      await loadJsonFromPathRef.current(path, hits[0]);
    }
    const parts: string[] = [];
    if (promptNeedle) parts.push('프롬프트');
    if (editedNeedle) parts.push('수정란');
    if (reviewFilter.length > 0) parts.push('검수결과');
    setStatusMessage(
      `필터(${parts.join(' + ')}): ${hits.length}개 일치 (전체 ${n}개 중, 텍스트는 대소문자 무시)`
    );
  }, [promptFilterQuery, editedFilterQuery, reviewResultFilter, jsonPath, envelope]);

  const clearPromptFilter = useCallback(() => {
    promptFilterCancelRef.current += 1;
    setFilteredSlotIndices(null);
    setPromptFilterScanning(false);
    setPromptFilterProgress(null);
    setStatusMessage('목록 필터를 해제했습니다. 전체 목록 기준으로 이동합니다.');
  }, []);

  const refreshEnvelopeFromDisk = useCallback(async (): Promise<VlmFileEnvelope | null> => {
    if (!jsonPath || !window.electron) return null;
    const res = await window.electron.readJsonFile(jsonPath);
    if (!res.ok) {
      setStatusMessage('JSON 읽기 실패: ' + (res.error || ''));
      return null;
    }
    const { envelope: env } = parseVlmJsonFile(res.text || '');
    if (vlmNavigableListCount(env) > 0) {
      envelopeBaseRef.current = env;
    }
    return env;
  }, [jsonPath]);

  const handleOpenExportModal = useCallback(async () => {
    if (!jsonPath || !window.electron) return;
    const n = envelopeBaseRef.current ? vlmNavigableListCount(envelopeBaseRef.current) : 0;
    if (n <= 0) {
      setStatusMessage('여러 항목 JSON에서만 JSON Export를 사용할 수 있습니다.');
      return;
    }
    const draft = draftRef.current;
    if (draft) {
      setIsSaving(true);
      try {
        const ok = await persistMergedRef.current(draft);
        if (!ok) return;
      } finally {
        setIsSaving(false);
      }
    }
    const env = await refreshEnvelopeFromDisk();
    if (!env) return;
    const count = vlmNavigableListCount(env);
    const rows: VlmExportRowMeta[] = [];
    for (let i = 0; i < count; i++) {
      const row = vlmExportRowMetaForSlot(env, i);
      if (row) rows.push(row);
    }
    if (rows.length === 0) {
      setStatusMessage('Export할 항목을 읽을 수 없습니다.');
      return;
    }
    setExportRows(rows);
    setExportSelectedSlots(new Set(rows.map((row) => row.slot)));
    setExportReviewFilter([]);
    setExportModalOpen(true);
  }, [jsonPath, refreshEnvelopeFromDisk]);

  const handleExportReReviewJson = useCallback(async () => {
    if (!jsonPath || !window.electron) return;
    const env = envelopeBaseRef.current;
    if (!env) return;
    const slots = [...exportSelectedSlots].sort((a, b) => a - b);
    if (slots.length === 0) return;
    const body = buildVlmReReviewExportJson(env, slots);
    if (!body) {
      setStatusMessage('Export 본문을 만들 수 없습니다.');
      return;
    }
    const baseName = jsonPath.replace(/^.*[/\\]/, '').replace(/\.json$/i, '') || 'vlm';
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const defaultPath = `${dirnameOfFile(jsonPath)}\\${baseName}_reverify_${stamp}.json`;
    setExportBusy(true);
    try {
      const outPath = await window.electron.saveJsonFileDialog(defaultPath);
      if (!outPath) return;
      const ok = await window.electron.writeJsonFile(outPath, body);
      if (!ok) {
        setStatusMessage('Export 저장 실패');
        return;
      }
      setExportModalOpen(false);
      setStatusMessage(`JSON Export 저장: ${outPath} (${slots.length}건)`);
      await window.electron.showItemInFolder(outPath);
    } finally {
      setExportBusy(false);
    }
  }, [jsonPath, exportSelectedSlots]);

  const handleOpenReportModal = useCallback(async () => {
    if (!jsonPath || !window.electron) return;
    const draft = draftRef.current;
    if (draft) {
      setIsSaving(true);
      try {
        const ok = await persistMergedRef.current(draft);
        if (!ok) return;
      } finally {
        setIsSaving(false);
      }
    }
    const env = await refreshEnvelopeFromDisk();
    if (!env) return;
    const baseName = jsonPath.replace(/^.*[/\\]/, '') || 'task.json';
    const report = buildVlmReviewBriefReport(env, baseName);
    if (!report) {
      setStatusMessage('리포트를 만들 수 없습니다.');
      return;
    }
    setReportData(report);
    setReportModalOpen(true);
  }, [jsonPath, refreshEnvelopeFromDisk]);

  const handleCopyReport = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatusMessage('검수 리포트를 클립보드에 복사했습니다.');
    } catch {
      setStatusMessage('클립보드 복사에 실패했습니다.');
    }
  }, []);

  const handleSaveReportText = useCallback(
    async (text: string) => {
      if (!jsonPath || !window.electron) return;
      const baseName = jsonPath.replace(/^.*[/\\]/, '').replace(/\.json$/i, '') || 'vlm';
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const defaultPath = `${dirnameOfFile(jsonPath)}\\${baseName}_report_${stamp}.txt`;
      setReportBusy(true);
      try {
        const outPath = await window.electron.saveJsonFileDialog(defaultPath);
        if (!outPath) return;
        const ok = await window.electron.writeJsonFile(outPath, text);
        if (!ok) {
          setStatusMessage('리포트 저장 실패');
          return;
        }
        setReportModalOpen(false);
        setStatusMessage(`검수 리포트 저장: ${outPath}`);
        await window.electron.showItemInFolder(outPath);
      } finally {
        setReportBusy(false);
      }
    },
    [jsonPath]
  );

  const goNext = useCallback(async () => {
    if (!jsonPath || !envelope || !task) return;
    const n = vlmNavigableListCount(envelope);
    if (n <= 1) return;
    const cur = vlmCurrentSlot(envelope);
    const nav = filteredSlotIndicesRef.current;
    let nextSlot: number;
    if (nav && nav.length > 0) {
      const ix = nav.indexOf(cur);
      if (ix < 0) {
        setStatusMessage('현재 항목이 필터에 없습니다. 필터를 다시 적용하세요.');
        return;
      }
      if (ix >= nav.length - 1) {
        setStatusMessage('필터 목록의 마지막 항목입니다.');
        return;
      }
      nextSlot = nav[ix + 1];
    } else {
      if (cur >= n - 1) {
        setStatusMessage('마지막 항목입니다.');
        return;
      }
      nextSlot = cur + 1;
    }
    const draft = draftRef.current;
    if (draft) {
      setIsSaving(true);
      try {
        const ok = await persistMergedRef.current(draft);
        if (!ok) return;
      } finally {
        setIsSaving(false);
      }
    }
    await loadJsonFromPathRef.current(jsonPath, nextSlot);
  }, [jsonPath, envelope, task]);

  const goPrev = useCallback(async () => {
    if (!jsonPath || !envelope || !task) return;
    const n = vlmNavigableListCount(envelope);
    if (n <= 1) return;
    const cur = vlmCurrentSlot(envelope);
    const nav = filteredSlotIndicesRef.current;
    let prevSlot: number;
    if (nav && nav.length > 0) {
      const ix = nav.indexOf(cur);
      if (ix < 0) {
        setStatusMessage('현재 항목이 필터에 없습니다. 필터를 다시 적용하세요.');
        return;
      }
      if (ix <= 0) {
        setStatusMessage('필터 목록의 첫 항목입니다.');
        return;
      }
      prevSlot = nav[ix - 1];
    } else {
      if (cur <= 0) {
        setStatusMessage('첫 번째 항목입니다.');
        return;
      }
      prevSlot = cur - 1;
    }
    const draft = draftRef.current;
    if (draft) {
      setIsSaving(true);
      try {
        const ok = await persistMergedRef.current(draft);
        if (!ok) return;
      } finally {
        setIsSaving(false);
      }
    }
    await loadJsonFromPathRef.current(jsonPath, prevSlot);
  }, [jsonPath, envelope, task]);

  /** 1-based: 필터 중이면 필터 순번, 아니면 전체 순번 */
  const goToSlot = useCallback(
    async (targetOneBased: number) => {
      if (!jsonPath || !envelope || !task) return;
      const n = vlmNavigableListCount(envelope);
      if (n <= 1) return;
      const nav = filteredSlotIndicesRef.current;
      const max = nav && nav.length > 0 ? nav.length : n;
      if (!Number.isFinite(targetOneBased) || targetOneBased < 1 || targetOneBased > max) {
        setStatusMessage(`이동: 1~${max} 사이 번호를 입력하세요.${nav?.length ? ' (필터 적용 중)' : ''}`);
        return;
      }
      const targetSlot = nav && nav.length > 0 ? nav[targetOneBased - 1] : targetOneBased - 1;
      const cur = vlmCurrentSlot(envelope);
      if (targetSlot === cur) {
        setStatusMessage(`이미 ${targetOneBased}번입니다.`);
        return;
      }
      const draft = draftRef.current;
      if (draft) {
        setIsSaving(true);
        try {
          const ok = await persistMergedRef.current(draft);
          if (!ok) return;
        } finally {
          setIsSaving(false);
        }
      }
      await loadJsonFromPathRef.current(jsonPath, targetSlot);
    },
    [jsonPath, envelope, task]
  );

  const handleGotoSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const raw = gotoInput.trim();
      if (!raw) return;
      if (!/^\d+$/.test(raw)) {
        setStatusMessage('순번은 숫자만 입력하세요 (1~N).');
        return;
      }
      const num = parseInt(raw, 10);
      await goToSlot(num);
      setGotoInput('');
    },
    [gotoInput, goToSlot]
  );

  const goNextRef = useRef(goNext);
  const goPrevRef = useRef(goPrev);
  goNextRef.current = goNext;
  goPrevRef.current = goPrev;

  const openJsonRef = useRef(handleOpenJson);
  openJsonRef.current = handleOpenJson;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        openJsonRef.current();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        gotoInputRef.current?.focus();
        gotoInputRef.current?.select();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      const key = e.key.toLowerCase();
      if (key === 'a' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        void goPrevRef.current();
        return;
      }
      if (key === 'd' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        void goNextRef.current();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const listCount = vlmNavigableListCount(envelope);
  const listSlot = envelope ? vlmCurrentSlot(envelope) : 0;
  const navList = filteredSlotIndices && filteredSlotIndices.length > 0 ? filteredSlotIndices : null;
  const navCount = navList ? navList.length : listCount;
  const navIndexInFilter = navList ? navList.indexOf(listSlot) : -1;
  const stuckOutOfFilter = !!(navList && navIndexInFilter < 0);
  const footerPosOneBased = navList && navIndexInFilter >= 0 ? navIndexInFilter + 1 : listSlot + 1;
  const footerMax = navList && navIndexInFilter >= 0 ? navCount : listCount;
  const atNavStart =
    stuckOutOfFilter || (navList ? navIndexInFilter <= 0 : listSlot <= 0);
  const atNavEnd =
    stuckOutOfFilter || (navList ? navIndexInFilter >= navList.length - 1 : listSlot >= listCount - 1);

  if (!isElectron) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 bg-slate-950 text-slate-400 p-8">
        <p className="text-sm font-medium text-slate-300">Electron으로 실행해 주세요</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <header className="glass flex-shrink-0 border-b border-white/10 px-5 py-3 flex flex-wrap items-center gap-3 rounded-none">
        <button
          type="button"
          onClick={handleOpenJson}
          className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-purple)]"
          style={{ color: 'var(--accent-purple)' }}
        >
          JSON 열기 (Ctrl+L)
        </button>
        {jsonPath && (
          <button
            type="button"
            onClick={() => void handleOpenReportModal()}
            disabled={isSaving || reportBusy}
            className="px-3.5 py-2 rounded-xl glass border border-sky-500/40 bg-sky-500/15 text-sm font-semibold text-sky-100 hover:bg-sky-500/25 transition-all disabled:opacity-40"
            title="열린 JSON의 검수 결과 요약"
          >
            검수 리포트
          </button>
        )}
        {jsonPath && vlmNavigableListCount(envelope) > 1 && (
          <button
            type="button"
            onClick={() => void handleOpenExportModal()}
            disabled={isSaving || exportBusy}
            className="px-3.5 py-2 rounded-xl glass border border-purple-500/40 bg-purple-500/15 text-sm font-semibold text-purple-100 hover:bg-purple-500/25 transition-all disabled:opacity-40"
            title="검수 결과별로 항목을 골라 JSON으로 저장"
          >
            JSON Export
          </button>
        )}
        {jsonPath && vlmNavigableListCount(envelope) > 1 && (
          <button
            type="button"
            onClick={() => setFilterPanelOpen((open) => !open)}
            className={`px-3.5 py-2 rounded-xl glass border text-sm font-medium transition-all ${
              filterPanelOpen || filteredSlotIndices?.length
                ? 'border-[var(--accent-purple)]/50 bg-[var(--accent-purple)]/15 text-purple-100'
                : 'border-white/10 text-slate-300 hover:bg-white/5'
            }`}
            title={filterPanelOpen ? '필터 패널 접기' : '필터 패널 펼치기'}
          >
            필터{filteredSlotIndices?.length ? ` · ${filteredSlotIndices.length}건` : ''}
            <span className="ml-1.5 text-xs opacity-70">{filterPanelOpen ? '▴' : '▾'}</span>
          </button>
        )}
        {jsonPath && (
          <span className="text-xs text-slate-400 truncate max-w-[160px] sm:max-w-md font-mono" title={jsonPath}>
            JSON: {jsonPath.replace(/^.*[/\\]/, '')}
          </span>
        )}
        <div className="flex-1 min-w-[120px] text-sm text-slate-400 truncate">{statusMessage}</div>
      </header>

      {task && envelope && vlmNavigableListCount(envelope) > 1 && filterPanelOpen && (
        <div className="glass flex-shrink-0 border-b border-white/10 px-4 py-2.5 flex flex-wrap items-center gap-2 gap-y-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 shrink-0">프롬프트</span>
          <input
            type="text"
            value={promptFilterQuery}
            onChange={(e) => setPromptFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void applyPromptFilter();
              }
            }}
            disabled={promptFilterScanning || isSaving}
            placeholder="검색 (예: &lt;image&gt;사람)"
            className="flex-1 min-w-[140px] max-w-md px-3 py-2 rounded-xl bg-slate-900/80 border border-white/15 text-sm text-slate-200 placeholder:text-slate-600 outline-none focus:border-[var(--accent-purple)] disabled:opacity-50"
            title="첫 human/user 대화 텍스트에 포함 여부 (대소문자 무시). 비우면 이 조건은 적용하지 않습니다."
          />
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 shrink-0">GPT수정</span>
          <input
            type="text"
            value={editedFilterQuery}
            onChange={(e) => setEditedFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void applyPromptFilter();
              }
            }}
            disabled={promptFilterScanning || isSaving}
            placeholder="수정란 검색 (예: F)"
            className="flex-1 min-w-[120px] max-w-md px-3 py-2 rounded-xl bg-slate-900/80 border border-white/15 text-sm text-slate-200 placeholder:text-slate-600 outline-none focus:border-[var(--accent-blue)] disabled:opacity-50"
            title="저장된 editedAnswer / editedGptResponse 에 포함 여부 (대소문자 무시). 비우면 이 조건은 적용하지 않습니다."
          />
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 shrink-0 w-full sm:w-auto mt-1 sm:mt-0">
            검수결과
          </span>
          <div className="flex flex-wrap gap-1.5 w-full sm:w-auto sm:flex-1 min-w-0">
            {LOCAL_VLM_REVIEW_OPTIONS.map((opt, idx) => {
              const selected = reviewResultFilter.includes(opt.id);
              const style = VLM_REVIEW_OPTION_STYLE_PRESETS[idx % VLM_REVIEW_OPTION_STYLE_PRESETS.length];
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() =>
                    setReviewResultFilter((prev) =>
                      prev.includes(opt.id) ? prev.filter((id) => id !== opt.id) : [...prev, opt.id]
                    )
                  }
                  disabled={promptFilterScanning || isSaving}
                  title={`${opt.label} — 클릭으로 선택/해제 (여러 개 선택 시 OR)`}
                  className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold transition-all disabled:opacity-40 ${
                    selected
                      ? `${style.activeClass} ring-1 ${style.ring}`
                      : `${style.className} opacity-50 hover:opacity-80`
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => void applyPromptFilter()}
            disabled={promptFilterScanning || isSaving}
            className="px-3.5 py-2 rounded-xl text-sm font-semibold border border-[var(--accent-purple)]/50 bg-[var(--accent-purple)]/20 text-purple-100 hover:bg-[var(--accent-purple)]/30 transition-all disabled:opacity-40 shrink-0"
          >
            🔍 적용
          </button>
          <button
            type="button"
            onClick={clearPromptFilter}
            disabled={!filteredSlotIndices?.length && !promptFilterScanning}
            className="px-3.5 py-2 rounded-xl text-sm font-medium border border-white/15 text-slate-300 hover:bg-white/5 transition-all disabled:opacity-40 shrink-0"
          >
            필터 해제
          </button>
          {filteredSlotIndices && filteredSlotIndices.length > 0 && (
            <span className="text-xs text-purple-200/90 font-mono tabular-nums shrink-0">
              일치 {filteredSlotIndices.length}건
            </span>
          )}
        </div>
      )}
      {promptFilterScanning && promptFilterProgress && promptFilterProgress.total > 0 && (
        <div className="flex-shrink-0 px-4 py-1.5 border-b border-white/10 bg-slate-900/40">
          <div className="flex justify-between text-[11px] text-slate-400 mb-1 font-mono tabular-nums">
            <span>목록 검색 중…</span>
            <span>
              {promptFilterProgress.done} / {promptFilterProgress.total}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--accent-purple)] transition-[width] duration-150"
              style={{
                width: `${Math.min(100, (promptFilterProgress.done / promptFilterProgress.total) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {!task ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-slate-300 text-sm font-medium">VLM 검수: JSON 파일을 열어 주세요 (Ctrl+L)</p>
            <p className="text-slate-500 text-xs max-w-md">
              <code className="text-slate-400">vlm/&lt;task&gt;/json/*.json</code>을 열면 형제{' '}
              <code className="text-slate-400">images/</code> 또는 <code className="text-slate-400">videos/</code> 폴더를 자동으로 찾아 이미지·영상을 표시합니다.
            </p>
            <p className="text-slate-500 text-xs max-w-md">
              여러 항목이 있으면 <strong>A / D</strong> 또는 <strong>← / →</strong>로 이동하고, <strong>GOTO</strong>로 순번(1~N) 직접 이동할 수 있습니다 (이동 전 현재 항목 저장). <strong>Ctrl+G</strong>로 GOTO 입력에 포커스.
            </p>
            <p className="text-slate-500 text-xs max-w-md">
              여러 항목 JSON에서는 상단 <strong>필터</strong>로 목록을 좁힐 수 있고, <strong>JSON Export</strong>로 선택 항목만 새 JSON으로 뽑을 수 있습니다.
            </p>
          </div>
        ) : (
          <div className="h-full flex flex-col min-h-0">
            <div className="flex-1 min-h-0 overflow-hidden">
              <VlmReviewPanel
                key={`${task.id}-${mediaBasePath ?? 'auto'}`}
                task={task}
                mediaAnchorDir={jsonPath ? dirnameOfFile(jsonPath) : null}
                mediaBasePath={mediaBasePath}
                isSaving={isSaving}
                remainingCount={0}
                showSubmitAndNext={false}
                onRefreshTask={handleRefresh}
                onSaveDraft={handleSaveDraft}
                onSubmitCurrent={handleSubmitCurrent}
                onDraftChange={handleDraftChange}
              />
            </div>
            {listCount > 1 && (
              <footer className="glass flex-shrink-0 border-t border-white/10 px-4 py-2.5 flex flex-wrap items-center justify-center gap-3 sm:gap-4">
                <button
                  type="button"
                  onClick={() => void goPrev()}
                  disabled={atNavStart || isSaving || promptFilterScanning}
                  className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 text-sm font-medium transition-all hover:border-[var(--accent-blue)]"
                  style={{ color: 'var(--accent-blue)' }}
                >
                  이전 (A)
                </button>
                <div className="flex flex-col items-center min-w-[5.5rem]">
                  <span className="text-lg font-bold tabular-nums whitespace-nowrap" style={{ color: 'var(--accent-blue)' }}>
                    {footerPosOneBased} / {footerMax}
                  </span>
                  {navList && navIndexInFilter >= 0 && (
                    <span className="text-[10px] text-slate-500 font-mono tabular-nums">
                      전체 {listSlot + 1}/{listCount}
                    </span>
                  )}
                </div>
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => void handleGotoSubmit(e)}
                >
                  <label htmlFor="vlm-goto-input" className="text-xs text-slate-500 whitespace-nowrap">
                    GOTO
                  </label>
                  <input
                    id="vlm-goto-input"
                    ref={gotoInputRef}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="순번"
                    value={gotoInput}
                    onChange={(e) => setGotoInput(e.target.value)}
                    disabled={isSaving || promptFilterScanning}
                    className="w-20 sm:w-24 px-2 py-1.5 rounded-lg bg-slate-900/80 border border-white/15 text-sm text-slate-200 text-center tabular-nums outline-none focus:border-[var(--accent-purple)] disabled:opacity-50"
                    title={
                      navList
                        ? `필터 목록 1~${navCount} (Ctrl+G)`
                        : `전체 1~${listCount} (Ctrl+G)`
                    }
                  />
                  <button
                    type="submit"
                    disabled={isSaving || promptFilterScanning || !gotoInput.trim()}
                    className="px-3 py-1.5 rounded-lg glass border border-white/10 disabled:opacity-40 text-xs font-semibold transition-all hover:border-[var(--accent-purple)]"
                    style={{ color: 'var(--accent-purple)' }}
                  >
                    이동
                  </button>
                </form>
                <button
                  type="button"
                  onClick={() => void goNext()}
                  disabled={atNavEnd || isSaving || promptFilterScanning}
                  className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 text-sm font-medium transition-all hover:border-[var(--accent-blue)]"
                  style={{ color: 'var(--accent-blue)' }}
                >
                  다음 (D)
                </button>
              </footer>
            )}
          </div>
        )}
      </main>

      <VlmReexportModal
        open={exportModalOpen}
        rows={exportRows}
        selectedSlots={exportSelectedSlots}
        reviewFilter={exportReviewFilter}
        exporting={exportBusy}
        sourceFileName={jsonPath ? jsonPath.replace(/^.*[/\\]/, '') : ''}
        onClose={() => {
          if (!exportBusy) setExportModalOpen(false);
        }}
        onToggleReviewFilter={(id) =>
          setExportReviewFilter((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
        }
        onToggleSlot={(slot) =>
          setExportSelectedSlots((prev) => {
            const next = new Set(prev);
            if (next.has(slot)) next.delete(slot);
            else next.add(slot);
            return next;
          })
        }
        onSelectAll={() => setExportSelectedSlots(new Set(exportRows.map((row) => row.slot)))}
        onSelectNone={() => setExportSelectedSlots(new Set())}
        onSelectVisible={() => {
          const visible =
            exportReviewFilter.length === 0
              ? exportRows
              : exportRows.filter((row) => exportReviewFilter.includes(row.reviewResultId));
          setExportSelectedSlots(new Set(visible.map((row) => row.slot)));
        }}
        onExport={() => void handleExportReReviewJson()}
      />

      <VlmBriefReportModal
        open={reportModalOpen}
        report={reportData}
        busy={reportBusy}
        onClose={() => {
          if (!reportBusy) setReportModalOpen(false);
        }}
        onCopy={(text) => void handleCopyReport(text)}
        onSaveText={(text) => void handleSaveReportText(text)}
      />
    </div>
  );
};

export default VlmWorkspace;
