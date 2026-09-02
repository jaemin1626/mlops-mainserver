export type VlmReviewOptionDef = {
  id: string;
  label: string;
  allowsGptEdit?: boolean;
};

/** local VLM 검수 — web 프로젝트 검수 결과 저장 코드와 동일 */
export const LOCAL_VLM_REVIEW_OPTIONS: VlmReviewOptionDef[] = [
  { id: 'NORMAL', label: '정상', allowsGptEdit: false },
  { id: 'NEEDS_FIX_VP', label: '수정필요(예/아니오)', allowsGptEdit: true },
  { id: 'NEEDS_FIX_DETAIL', label: '수정필요(설명)', allowsGptEdit: true },
  { id: 'NEEDS_FIX_COLOR', label: '수정필요(색상)', allowsGptEdit: true },
];

export const VLM_REVIEW_OPTION_STYLE_PRESETS = [
  {
    className: 'border-emerald-600/60 bg-emerald-950/50 text-emerald-200 hover:bg-emerald-900/40',
    activeClass: 'border-emerald-500 bg-emerald-900/50 text-emerald-100',
    ring: 'ring-emerald-500',
  },
  {
    className: 'border-amber-600/60 bg-amber-950/50 text-amber-200 hover:bg-amber-900/40',
    activeClass: 'border-amber-500 bg-amber-900/50 text-amber-100',
    ring: 'ring-amber-500',
  },
  {
    className: 'border-rose-600/60 bg-rose-950/50 text-rose-200 hover:bg-rose-900/40',
    activeClass: 'border-rose-500 bg-rose-900/50 text-rose-100',
    ring: 'ring-rose-500',
  },
  {
    className: 'border-violet-600/60 bg-violet-950/50 text-violet-200 hover:bg-violet-900/40',
    activeClass: 'border-violet-500 bg-violet-900/50 text-violet-100',
    ring: 'ring-violet-500',
  },
] as const;

const LEGACY_REVIEW_RESULT_TO_ID: Record<string, string> = {
  NEEDS_FIX: 'NEEDS_FIX_VP',
  NEEDS_FIX_YESNO: 'NEEDS_FIX_VP',
  NEEDS_FIX_DESC: 'NEEDS_FIX_DETAIL',
  '수정필요(vp)': 'NEEDS_FIX_VP',
  '수정필요(detail)': 'NEEDS_FIX_DETAIL',
  '수정필요(네/아니오)': 'NEEDS_FIX_VP',
  '수정필요(예/아니오)': 'NEEDS_FIX_VP',
  '수정필요': 'NEEDS_FIX_VP',
};

export function findVlmReviewOption(
  options: VlmReviewOptionDef[],
  reviewResultLike: unknown
): VlmReviewOptionDef | undefined {
  const raw = String(reviewResultLike ?? '').trim();
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  return options.find((o) => o.id === raw || o.id.toUpperCase() === upper || o.label === raw);
}

export function vlmReviewOptionAllowsGptEdit(options: VlmReviewOptionDef[], reviewResultLike: unknown): boolean {
  const hit = findVlmReviewOption(options, reviewResultLike);
  if (hit) return Boolean(hit.allowsGptEdit);
  const upper = String(reviewResultLike ?? '').toUpperCase();
  return upper !== '' && upper !== 'NORMAL';
}

/** JSON·클립보드·레거시 값 → local 고정 옵션 id */
export function resolveStoredReviewResult(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return 'NORMAL';

  const direct = findVlmReviewOption(LOCAL_VLM_REVIEW_OPTIONS, raw);
  if (direct) return direct.id;

  const upper = raw.toUpperCase();
  if (LEGACY_REVIEW_RESULT_TO_ID[upper]) return LEGACY_REVIEW_RESULT_TO_ID[upper];
  if (LEGACY_REVIEW_RESULT_TO_ID[raw]) return LEGACY_REVIEW_RESULT_TO_ID[raw];

  if (raw.includes('예/아니오') || raw.includes('예아니오') || raw.includes('네/아니오') || raw.includes('네아니오')) {
    return 'NEEDS_FIX_VP';
  }
  if (raw.includes('설명')) return 'NEEDS_FIX_DETAIL';
  if (raw.includes('색상')) return 'NEEDS_FIX_COLOR';
  if (upper.startsWith('NEEDS_FIX') || raw.includes('수정')) return 'NEEDS_FIX_VP';

  return 'NORMAL';
}

export function storedReviewToExportLabel(stored: unknown): string {
  const id = resolveStoredReviewResult(stored);
  const hit = findVlmReviewOption(LOCAL_VLM_REVIEW_OPTIONS, id);
  return hit?.label ?? '정상';
}
