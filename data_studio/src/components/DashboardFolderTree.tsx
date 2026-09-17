import React, { useCallback, useEffect, useState } from 'react';
import { fetchFolderEntries, type FolderListEntry } from '../dashboardApi';

interface DashboardFolderTreeProps {
  rootPath: string;
  selectedPath: string;
  onSelect: (path: string) => void;
  accent: 'lime' | 'purple';
}

interface FolderTreeNodeProps {
  path: string;
  name: string;
  depth: number;
  selectedPath: string;
  onSelect: (path: string) => void;
  accent: 'lime' | 'purple';
  defaultExpanded?: boolean;
}

const selectedClass = (accent: 'lime' | 'purple') =>
  accent === 'lime'
    ? 'bg-[var(--accent-lime)]/15 text-[var(--accent-lime)] border-[var(--accent-lime)]/40'
    : 'bg-[var(--accent-purple)]/15 text-[var(--accent-purple)] border-[var(--accent-purple)]/40';

const FolderTreeNode: React.FC<FolderTreeNodeProps> = ({
  path,
  name,
  depth,
  selectedPath,
  onSelect,
  accent,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [children, setChildren] = useState<FolderListEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSelected = selectedPath === path;
  const isAncestor =
    selectedPath !== path &&
    (selectedPath.startsWith(`${path}/`) || selectedPath.startsWith(`${path}\\`));

  const loadChildren = useCallback(async () => {
    if (children !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const entries = await fetchFolderEntries(path);
      setChildren(entries.filter((entry) => entry.type === 'dir'));
    } catch (err) {
      setError((err as Error).message || '폴더를 불러오지 못했습니다.');
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, [children, loading, path]);

  useEffect(() => {
    if ((defaultExpanded || isSelected || isAncestor) && children === null && !loading) {
      void loadChildren();
      setExpanded(true);
    }
  }, [children, defaultExpanded, isAncestor, isSelected, loadChildren, loading]);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadChildren();
  };

  const hasLoadedChildren = children !== null && children.length > 0;
  const showToggle = loading || hasLoadedChildren || children === null;

  return (
    <div>
      <div
        className="flex items-center gap-1 min-w-0"
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        <button
          type="button"
          onClick={toggleExpanded}
          disabled={!showToggle}
          className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-slate-500 hover:text-slate-200 disabled:opacity-30"
          aria-label={expanded ? '접기' : '펼치기'}
        >
          {loading ? '…' : showToggle ? (expanded ? '▾' : '▸') : '·'}
        </button>
        <button
          type="button"
          onClick={() => onSelect(path)}
          className={`flex-1 min-w-0 text-left px-2 py-1.5 rounded-lg border text-sm truncate transition-colors ${
            isSelected
              ? selectedClass(accent)
              : 'border-transparent text-slate-300 hover:bg-white/5 hover:border-white/10'
          }`}
          title={path}
        >
          {name}
        </button>
      </div>
      {error ? (
        <p className="text-[11px] text-red-300 px-2 py-1" style={{ paddingLeft: `${depth * 12 + 24}px` }}>
          {error}
        </p>
      ) : null}
      {expanded && children?.map((child) => (
        <FolderTreeNode
          key={child.path}
          path={child.path}
          name={child.name}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          accent={accent}
          defaultExpanded={isAncestor && selectedPath.startsWith(`${child.path}/`)}
        />
      ))}
    </div>
  );
};

const DashboardFolderTree: React.FC<DashboardFolderTreeProps> = ({
  rootPath,
  selectedPath,
  onSelect,
  accent,
}) => {
  const rootName = rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath;

  return (
    <aside className="glass w-64 shrink-0 border-r border-white/10 flex flex-col min-h-0">
      <div className="px-3 py-3 border-b border-white/10">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">폴더</h2>
        <p className="text-[11px] text-slate-500 mt-1 truncate" title={rootPath}>
          {rootPath}
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2">
        <FolderTreeNode
          path={rootPath}
          name={rootName}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          accent={accent}
          defaultExpanded
        />
      </div>
    </aside>
  );
};

export default DashboardFolderTree;
