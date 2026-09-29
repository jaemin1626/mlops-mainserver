import React from 'react';
import type { LabelAccessRole } from '../accessControl';

const SWITCHABLE_ROLES: LabelAccessRole[] = ['worker', 'reviewer'];

function roleLabel(role: LabelAccessRole): string {
  if (role === 'reviewer') return '검수자';
  if (role === 'worker') return '작업자';
  return '조회 전용';
}

interface WorkflowRoleSelectProps {
  role: LabelAccessRole;
  availableRoles: LabelAccessRole[];
  onRoleChange: (role: LabelAccessRole) => void;
  id?: string;
  size?: 'sm' | 'md';
}

const sizeClasses = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
} as const;

const WorkflowRoleSelect: React.FC<WorkflowRoleSelectProps> = ({
  role,
  availableRoles,
  onRoleChange,
  id = 'workflow-role-select',
  size = 'md',
}) => {
  const boxClass = `${sizeClasses[size]} rounded-lg bg-slate-800 border border-white/10 text-white`;
  const options = SWITCHABLE_ROLES.filter((r) => availableRoles.includes(r));

  if (options.length <= 1) {
    const displayRole = options.length === 1 ? options[0] : role;
    return <span className={boxClass}>{roleLabel(displayRole)}</span>;
  }

  const selectValue = options.includes(role) ? role : options[0];

  return (
    <>
      <label className="sr-only" htmlFor={id}>
        작업 역할 선택
      </label>
      <select
        id={id}
        value={selectValue}
        onChange={(event) => onRoleChange(event.target.value as LabelAccessRole)}
        className={boxClass}
        aria-label="작업 역할 선택"
      >
        {options.includes('worker') ? <option value="worker">작업자</option> : null}
        {options.includes('reviewer') ? <option value="reviewer">검수자</option> : null}
      </select>
    </>
  );
};

export default WorkflowRoleSelect;
