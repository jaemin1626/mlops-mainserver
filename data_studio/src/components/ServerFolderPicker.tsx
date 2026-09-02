import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const API = '/data-studio/api';

type PickerMode = 'dir' | 'label' | 'json' | 'save-name';

interface PickerRequest {
  mode: PickerMode;
  initialPath?: string;
  directory?: string;
  defaultName?: string;
  done: (path: string | null) => void;
}

interface ServerEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

interface PickerState {
  mode: PickerMode;
}

async function apiJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      message = body.error || message;
    } catch {
      // The response did not contain a JSON error body.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function resolveStartPath(preferred: string | undefined, roots: string[]): Promise<string> {
  const candidates = [preferred, ...roots].filter((path): path is string => Boolean(path));
  for (const candidate of candidates) {
    try {
      await apiJson(`${API}/fs/list?path=${encodeURIComponent(candidate)}`);
      return candidate;
    } catch {
      // Try the next allowed path.
    }
  }
  return roots[0] || '/data/datasets';
}

function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (separatorIndex < 0) return path;
  if (separatorIndex === 0) return trimmed.slice(0, 1);
  if (/^[A-Za-z]:$/.test(trimmed.slice(0, separatorIndex))) {
    return trimmed.slice(0, separatorIndex + 1);
  }
  return trimmed.slice(0, separatorIndex);
}

function rootForPath(path: string, roots: string[]): string {
  return (
    [...roots]
      .sort((left, right) => right.length - left.length)
      .find((root) => {
        const normalizedRoot = root.replace(/[\\/]+$/, '');
        return (
          path === root ||
          path.startsWith(`${normalizedRoot}/`) ||
          path.startsWith(`${normalizedRoot}\\`)
        );
      }) ||
    roots[0] ||
    ''
  );
}

function joinServerPath(directory: string, name: string): string {
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  return `${directory.replace(/[\\/]+$/, '')}${separator}${name}`;
}

function pickerCopy(mode: PickerMode): { title: string; description: string; empty: string; confirm: string } {
  switch (mode) {
    case 'dir':
      return {
        title: '서버 작업 폴더 선택',
        description: '폴더를 더블클릭하거나 선택 후 Enter로 이동하세요.',
        empty: '하위 폴더가 없습니다.',
        confirm: '이 폴더 열기',
      };
    case 'label':
      return {
        title: '서버 라벨 파일 선택',
        description: '폴더를 탐색한 뒤 .txt 파일을 선택하세요.',
        empty: '폴더 또는 .txt 파일이 없습니다.',
        confirm: '라벨 파일 열기',
      };
    case 'json':
      return {
        title: '서버 JSON 파일 선택',
        description: '폴더를 탐색한 뒤 .json 파일을 선택하세요.',
        empty: '폴더 또는 .json 파일이 없습니다.',
        confirm: 'JSON 파일 열기',
      };
    case 'save-name':
      return {
        title: '서버 JSON 파일 저장',
        description: '저장할 파일 이름을 입력하세요. .json 확장자는 자동으로 추가됩니다.',
        empty: '',
        confirm: '저장',
      };
    default: {
      const exhaustiveMode: never = mode;
      return exhaustiveMode;
    }
  }
}

const ServerFolderPicker: React.FC = () => {
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [activeRoot, setActiveRoot] = useState('');
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<ServerEntry[]>([]);
  const [selected, setSelected] = useState<ServerEntry | null>(null);
  const [fileName, setFileName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<PickerRequest | null>(null);
  const loadSequenceRef = useRef(0);

  const loadDirectory = useCallback(async (path: string) => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setError('');
    setSelected(null);
    try {
      const data = await apiJson<{ entries: ServerEntry[] }>(
        `${API}/fs/list?path=${encodeURIComponent(path)}`
      );
      if (sequence !== loadSequenceRef.current) return;
      setCurrentPath(path);
      setEntries(data.entries);
    } catch (loadError) {
      if (sequence !== loadSequenceRef.current) return;
      setError((loadError as Error).message || '폴더를 불러오지 못했습니다.');
      setEntries([]);
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, []);

  const closePicker = useCallback((path: string | null) => {
    const request = requestRef.current;
    requestRef.current = null;
    setPicker(null);
    setEntries([]);
    setSelected(null);
    setFileName('');
    setError('');
    request?.done(path);
  }, []);

  useEffect(() => {
    const open = (event: Event) => {
      const request = (event as CustomEvent<PickerRequest>).detail;
      if (
        !request ||
        !['dir', 'label', 'json', 'save-name'].includes(request.mode) ||
        typeof request.done !== 'function'
      ) {
        return;
      }

      loadSequenceRef.current += 1;

      requestRef.current?.done(null);
      requestRef.current = request;
      setPicker({ mode: request.mode });
      setFileName(request.defaultName || '');
      setRoots([]);
      setActiveRoot('');
      setCurrentPath('');
      setEntries([]);
      setSelected(null);
      setError('');
      setLoading(true);

      void apiJson<{ roots: string[] }>(`${API}/fs/roots`)
        .then(async ({ roots: allowedRoots }) => {
          if (requestRef.current !== request) return;
          setRoots(allowedRoots);
          const preferred =
            request.mode === 'save-name' ? request.directory || request.initialPath : request.initialPath;
          const startPath = await resolveStartPath(preferred, allowedRoots);
          if (requestRef.current !== request) return;
          setActiveRoot(rootForPath(startPath, allowedRoots));
          await loadDirectory(startPath);
        })
        .catch((rootError: Error) => {
          if (requestRef.current !== request) return;
          setError(rootError.message || '서버 루트를 불러오지 못했습니다.');
          setLoading(false);
        });
    };

    window.addEventListener('data-studio:pick-folder', open);
    window.addEventListener('data-studio:pick-label', open);
    return () => {
      window.removeEventListener('data-studio:pick-folder', open);
      window.removeEventListener('data-studio:pick-label', open);
      requestRef.current?.done(null);
      requestRef.current = null;
    };
  }, [loadDirectory]);

  const visibleEntries = useMemo(() => {
    if (!picker) return [];
    return entries.filter(
      (entry) =>
        entry.type === 'dir' ||
        (picker.mode === 'label' && entry.type === 'file' && entry.name.toLowerCase().endsWith('.txt')) ||
        (picker.mode === 'json' && entry.type === 'file' && entry.name.toLowerCase().endsWith('.json'))
    );
  }, [entries, picker]);

  const activateEntry = useCallback(
    (entry: ServerEntry) => {
      if (entry.type === 'dir') {
        void loadDirectory(entry.path);
      } else if (picker?.mode === 'label' && entry.name.toLowerCase().endsWith('.txt')) {
        closePicker(entry.path);
      } else if (picker?.mode === 'json' && entry.name.toLowerCase().endsWith('.json')) {
        closePicker(entry.path);
      }
    },
    [closePicker, loadDirectory, picker]
  );

  const confirmSaveName = useCallback(() => {
    if (picker?.mode !== 'save-name' || !currentPath) return;
    const trimmedName = fileName.trim();
    if (!trimmedName || /[\\/]/.test(trimmedName)) return;
    const jsonName = trimmedName.toLowerCase().endsWith('.json') ? trimmedName : `${trimmedName}.json`;
    const exists = entries.some(
      (entry) => entry.type === 'file' && entry.name.toLowerCase() === jsonName.toLowerCase()
    );
    if (exists && !window.confirm(`"${jsonName}" 파일이 이미 있습니다. 덮어쓰시겠습니까?`)) return;
    closePicker(joinServerPath(currentPath, jsonName));
  }, [closePicker, currentPath, entries, fileName, picker]);

  useEffect(() => {
    if (!picker) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePicker(null);
      } else if (event.key === 'Enter' && picker.mode === 'save-name') {
        event.preventDefault();
        event.stopPropagation();
        confirmSaveName();
      } else if (event.key === 'Enter' && selected) {
        event.preventDefault();
        event.stopPropagation();
        activateEntry(selected);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activateEntry, closePicker, confirmSaveName, picker, selected]);

  if (!picker) return null;

  const atRoot = currentPath === activeRoot;
  const copy = pickerCopy(picker.mode);
  const canConfirmLabel =
    picker.mode === 'label' &&
    selected?.type === 'file' &&
    selected.name.toLowerCase().endsWith('.txt');
  const canConfirmJson =
    picker.mode === 'json' &&
    selected?.type === 'file' &&
    selected.name.toLowerCase().endsWith('.json');
  const canConfirmSaveName =
    picker.mode === 'save-name' &&
    Boolean(currentPath) &&
    Boolean(fileName.trim()) &&
    !/[\\/]/.test(fileName.trim());

  return (
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePicker(null);
      }}
    >
      <div
        className="glass-card flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden border border-white/10 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-folder-picker-title"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 id="server-folder-picker-title" className="text-lg font-bold text-white">
              {copy.title}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">{copy.description}</p>
          </div>
          <button
            type="button"
            onClick={() => closePicker(null)}
            className="rounded-xl p-2 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="닫기"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3">
          {picker.mode !== 'save-name' && (
            <button
              type="button"
              disabled={!currentPath || atRoot || loading}
              onClick={() => void loadDirectory(parentPath(currentPath))}
              className="rounded-xl border border-white/10 px-3 py-2 text-sm font-medium text-[var(--accent-blue)] transition-all hover:border-[var(--accent-blue)] disabled:cursor-not-allowed disabled:opacity-35"
            >
              상위 폴더
            </button>
          )}
          {picker.mode !== 'save-name' && roots.length > 1 && (
            <select
              value={activeRoot}
              onChange={(event) => {
                const nextRoot = event.target.value;
                setActiveRoot(nextRoot);
                void loadDirectory(nextRoot);
              }}
              className="max-w-52 rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none focus:border-[var(--accent-blue)]"
              aria-label="허용된 서버 루트"
            >
              {roots.map((root) => (
                <option key={root} value={root}>
                  {root}
                </option>
              ))}
            </select>
          )}
          <div
            className="min-w-0 flex-1 truncate rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono text-sm text-slate-300"
            title={currentPath}
          >
            {currentPath || '경로 불러오는 중…'}
          </div>
        </div>

        {picker.mode === 'save-name' ? (
          <div className="min-h-64 flex flex-1 flex-col justify-center gap-3 px-5 py-8">
            <label htmlFor="server-save-file-name" className="text-sm font-medium text-slate-300">
              파일 이름
            </label>
            <input
              id="server-save-file-name"
              type="text"
              autoFocus
              value={fileName}
              onChange={(event) => setFileName(event.target.value)}
              placeholder="annotations.json"
              className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-[var(--accent-blue)]"
            />
            {/[\\/]/.test(fileName.trim()) && (
              <p className="text-xs text-red-300">파일 이름에는 경로 구분자를 사용할 수 없습니다.</p>
            )}
            {error && <p className="text-xs text-red-300">{error}</p>}
          </div>
        ) : (
          <div className="min-h-64 flex-1 overflow-auto p-3">
            {loading ? (
              <div className="flex h-64 flex-col items-center justify-center gap-3 text-slate-400">
                <div className="h-9 w-9 animate-spin rounded-full border-2 border-[var(--accent-blue)] border-t-transparent" />
                <span className="text-sm">목록 불러오는 중…</span>
              </div>
            ) : error ? (
              <div className="flex h-64 items-center justify-center px-6 text-center text-sm text-red-300">
                {error}
              </div>
            ) : visibleEntries.length === 0 ? (
              <div className="flex h-64 items-center justify-center text-sm text-slate-500">
                {copy.empty}
              </div>
            ) : (
              <ul className="space-y-1" aria-label="서버 파일 목록">
                {visibleEntries.map((entry) => {
                  const isSelected = selected?.path === entry.path;
                  return (
                    <li key={entry.path}>
                      <button
                        type="button"
                        onClick={() => setSelected(entry)}
                        onDoubleClick={() => activateEntry(entry)}
                        className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-all ${
                          isSelected
                            ? 'border-[var(--accent-purple)]/70 bg-[var(--accent-purple)]/20 text-white'
                            : 'border-transparent text-slate-300 hover:border-white/10 hover:bg-white/5'
                        }`}
                      >
                        <svg
                          className={`h-5 w-5 shrink-0 ${
                            entry.type === 'dir' ? 'text-[var(--accent-blue)]' : 'text-slate-400'
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden
                        >
                          {entry.type === 'dir' ? (
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.8}
                              d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2Z"
                            />
                          ) : (
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.8}
                              d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h6"
                            />
                          )}
                        </svg>
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        {entry.type === 'dir' && (
                          <span className="text-xs text-slate-600">Enter / 더블클릭</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-4">
          <span className="min-w-0 truncate text-xs text-slate-500">
            {picker.mode === 'save-name'
              ? canConfirmSaveName
                ? joinServerPath(
                    currentPath,
                    fileName.trim().toLowerCase().endsWith('.json') ? fileName.trim() : `${fileName.trim()}.json`
                  )
                : '파일 이름을 입력하세요.'
              : selected
                ? selected.path
                : '항목을 선택하세요.'}
          </span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => closePicker(null)}
              className="rounded-xl border border-white/10 px-4 py-2 text-sm font-medium text-slate-300 transition-all hover:bg-white/10"
            >
              취소
            </button>
            <button
              type="button"
              disabled={
                loading ||
                (picker.mode === 'dir'
                  ? !currentPath
                  : picker.mode === 'label'
                    ? !canConfirmLabel
                    : picker.mode === 'json'
                      ? !canConfirmJson
                      : !canConfirmSaveName)
              }
              onClick={() => {
                if (picker.mode === 'save-name') {
                  confirmSaveName();
                } else {
                  closePicker(picker.mode === 'dir' ? currentPath : selected?.path ?? null);
                }
              }}
              className="rounded-xl border border-[var(--accent-lime)]/50 bg-[var(--accent-lime)] px-4 py-2 text-sm font-semibold text-[#1A1A2E] shadow-[0_0_20px_rgba(168,230,27,0.2)] transition-all hover:shadow-[0_0_24px_rgba(168,230,27,0.3)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {copy.confirm}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ServerFolderPicker;
