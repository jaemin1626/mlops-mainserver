import {
  buildWebFsFileUrl,
  buildWebFsVideoUrl,
  resolveMediaAbsolutePath,
  resolveRelativePath,
} from './webMediaBase';

export type VlmMediaKind = 'image' | 'video';

const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv)$/i;

export function inferVlmMediaType(pathOrUrl: string, explicit?: unknown): VlmMediaKind {
  const normalized = String(explicit || '')
    .trim()
    .toLowerCase();
  if (normalized === 'video') return 'video';
  if (normalized === 'image') return 'image';
  if (VIDEO_EXT_RE.test(String(pathOrUrl || '').trim().toLowerCase())) return 'video';
  return 'image';
}

export function extractVlmMediaPathFromRecord(record: Record<string, unknown> | null | undefined): string {
  if (!record) return '';
  const media = String(record.media ?? '').trim();
  if (media) return media;
  const video = String(record.video ?? record.video_path ?? record.videoPath ?? '').trim();
  if (video) return video;
  return String(record.image ?? record.image_path ?? record.imagePath ?? '').trim();
}

/** HTTP·/datasets/…·images_vlm/… 접두를 로컬 워크스페이스 상대 경로로 정규화 */
export function stripVlmMediaPathToRelative(input: string): string {
  let raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.startsWith('file://')) {
    try {
      raw = decodeURIComponent(raw.replace(/^file:\/\//i, ''));
    } catch {
      raw = raw.replace(/^file:\/\//i, '');
    }
  }
  raw = raw.replace(/^https?:\/\/[^/]+/i, '');
  return raw
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:\/+/, '')
    .replace(/^\/+/, '')
    .replace(/^datasets\/images_vlm\//i, '')
    .replace(/^datasets\//i, '')
    .replace(/^images_vlm\//i, '');
}

/** yolo://workspace 상대 경로 → 프로토콜 URL */
export function normalizeVlmMediaLocalSrc(
  input: string,
  opts?: { anchorDir?: string | null; mediaBase?: string | null; mediaType?: VlmMediaKind }
): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const isWeb = typeof window !== 'undefined' && window.__DATA_STUDIO_WEB__ === true;
  if (isWeb) {
    if (raw.startsWith('/') && !raw.startsWith('//')) {
      const absolute = resolveRelativePath('/', raw.replace(/^\/+/, ''));
      return opts?.mediaType === 'video' ? buildWebFsVideoUrl(absolute) : buildWebFsFileUrl(absolute);
    }
    const absolute = resolveMediaAbsolutePath(raw, opts);
    if (!absolute) return '';
    return opts?.mediaType === 'video' ? buildWebFsVideoUrl(absolute) : buildWebFsFileUrl(absolute);
  }
  if (raw.startsWith('yolo://')) return raw;
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    const rel = stripVlmMediaPathToRelative(raw);
    if (!rel) return '';
    const segments = rel.split('/').filter(Boolean);
    if (segments.length === 0) return '';
    return 'yolo://workspace/' + segments.map(encodeURIComponent).join('/');
  }
  const cleaned = stripVlmMediaPathToRelative(raw);
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  return 'yolo://workspace/' + segments.map(encodeURIComponent).join('/');
}

export type VlmResolvedMediaView = {
  mediaPath: string;
  mediaType: VlmMediaKind;
  mediaSrc: string;
};

export function resolveVlmMediaFromSourceData(
  parsed: Record<string, unknown> | null | undefined,
  opts?: { anchorDir?: string | null; mediaBase?: string | null }
): VlmResolvedMediaView {
  if (!parsed) {
    return { mediaPath: '', mediaType: 'image', mediaSrc: '' };
  }
  const rawData =
    parsed.rawData && typeof parsed.rawData === 'object' && !Array.isArray(parsed.rawData)
      ? (parsed.rawData as Record<string, unknown>)
      : null;
  const explicitType = parsed.mediaType ?? rawData?.mediaType;
  const mediaPath = String(
    parsed.resolvedMediaPath ??
      parsed.resolvedImagePath ??
      parsed.mediaPath ??
      parsed.imagePath ??
      parsed.image_path ??
      extractVlmMediaPathFromRecord(rawData) ??
      extractVlmMediaPathFromRecord(parsed) ??
      parsed.legacyMedia ??
      parsed.legacyImage ??
      parsed.mediaWebUrl ??
      parsed.imageUrl ??
      ''
  ).trim();
  const mediaType = inferVlmMediaType(mediaPath, explicitType);
  return {
    mediaPath,
    mediaType,
    mediaSrc: normalizeVlmMediaLocalSrc(mediaPath, { ...opts, mediaType }),
  };
}
