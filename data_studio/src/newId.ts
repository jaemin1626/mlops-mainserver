/**
 * crypto.randomUUID는 보안 컨텍스트(HTTPS·localhost)에서만 제공된다.
 * 평문 HTTP로 서비스되는 웹 모드에서도 동작하도록 대체 경로를 둔다.
 */
export function newId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
