export type LabelAccessRole = 'worker' | 'reviewer' | 'viewer';

export interface LabelAccess {
  role: LabelAccessRole;
  roles: LabelAccessRole[];
  userName: string;
  loaded: boolean;
}

export function resolveLabelAccess(me: any): LabelAccess {
  const permissions = Array.isArray(me?.permissions) ? me.permissions : [];
  const canWork = Boolean(me?.is_admin || permissions.includes('LABEL_WORK'));
  const canReview = Boolean(me?.is_admin || permissions.includes('LABEL_REVIEW'));
  const roles: LabelAccessRole[] = [
    ...(canWork ? ['worker' as const] : []),
    ...(canReview ? ['reviewer' as const] : []),
  ];
  if (!roles.length) roles.push('viewer');
  return {
    role: canReview ? 'reviewer' : canWork ? 'worker' : 'viewer',
    roles,
    userName: String(me?.display_name || me?.name || me?.username || me?.email || '').trim(),
    loaded: true,
  };
}
