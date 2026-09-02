let mediaBaseRoot: string | null = null;
let workspaceRoot: string | null = null;

export function setWebMediaBaseRoot(path: string | null): void {
  mediaBaseRoot = path ? String(path) : null;
}

export function getWebMediaBaseRoot(): string | null {
  return mediaBaseRoot;
}

export function setWebWorkspaceRoot(path: string | null): void {
  workspaceRoot = path ? String(path) : null;
}

export function getWebWorkspaceRoot(): string | null {
  return workspaceRoot;
}

export function joinUnderBase(base: string, rel: string): string {
  const b = base.replace(/[\\/]+$/, '');
  const r = rel.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return `${b}/${r}`;
}

/** JSON 디렉터리 기준 ../videos/… 상대 경로를 절대 경로로 정규화 */
export function resolveRelativePath(baseDir: string, relativePath: string): string {
  const base = String(baseDir || '').replace(/\\/g, '/');
  const rel = String(relativePath || '').replace(/\\/g, '/');
  const isAbs = base.startsWith('/');
  const baseParts = base.split('/').filter((part, index) => part.length > 0 || (index === 0 && isAbs));
  const stack = (isAbs && baseParts[0] === '' ? baseParts.slice(1) : baseParts.filter(Boolean)).slice();
  for (const segment of rel.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return (isAbs ? '/' : '') + stack.join('/');
}

export function needsRelativePathResolution(input: string): boolean {
  const raw = String(input || '').trim();
  if (!raw) return false;
  if (raw.startsWith('.') || raw.startsWith('..')) return true;
  return raw.split('/').includes('..');
}

export function resolveMediaAbsolutePath(
  mediaPath: string,
  opts?: { anchorDir?: string | null; mediaBase?: string | null }
): string {
  const raw = String(mediaPath || '').trim();
  if (!raw) return '';
  const anchorDir = opts?.anchorDir ?? getWebWorkspaceRoot();
  const mediaBase = opts?.mediaBase ?? getWebMediaBaseRoot();
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    return resolveRelativePath('/', raw.replace(/^\/+/, ''));
  }
  if (needsRelativePathResolution(raw)) {
    const anchor = anchorDir || mediaBase;
    if (!anchor) return '';
    return resolveRelativePath(anchor, raw);
  }
  const base = mediaBase || anchorDir;
  if (!base) return '';
  return joinUnderBase(base, raw.replace(/^[/\\]+/, '').replace(/\\/g, '/'));
}

export function buildWebFsFileUrl(absolutePath: string): string {
  return `/data-studio/api/fs/file?path=${encodeURIComponent(absolutePath)}`;
}

export function buildWebFsVideoUrl(absolutePath: string): string {
  return `/data-studio/api/fs/video?path=${encodeURIComponent(absolutePath)}`;
}
