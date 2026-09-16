import { useCallback, useRef, useState } from 'react';
import type { YoloWorkflowRole, YoloWorkflowStatus } from './yoloMeta';
import { resolveNavPrompt, type WorkflowNavPrompt } from './workflowNavigate';

interface UseWorkflowNavGateOptions {
  workflowRole: YoloWorkflowRole;
  workflowStatus: YoloWorkflowStatus | null | undefined;
  currentIndex: number;
  onNavigate: (targetIndex: number) => Promise<void>;
  onSubmitForReview: () => Promise<boolean>;
  onApprove: () => Promise<boolean>;
}

export function useWorkflowNavGate({
  workflowRole,
  workflowStatus,
  currentIndex,
  onNavigate,
  onSubmitForReview,
  onApprove,
}: UseWorkflowNavGateOptions) {
  const [navPrompt, setNavPrompt] = useState<WorkflowNavPrompt | null>(null);
  const [navBusy, setNavBusy] = useState(false);
  const navPromptRef = useRef<WorkflowNavPrompt | null>(null);
  navPromptRef.current = navPrompt;

  const requestNavigate = useCallback(
    async (targetIndex: number) => {
      if (navPromptRef.current) return;
      const prompt = resolveNavPrompt(workflowRole, workflowStatus, targetIndex);
      if (prompt) {
        setNavPrompt(prompt);
        return;
      }
      await onNavigate(targetIndex);
    },
    [workflowRole, workflowStatus, onNavigate]
  );

  const handleNavCancel = useCallback(async () => {
    if (!navPrompt || navBusy) return;
    const target = navPrompt.targetIndex;
    setNavPrompt(null);
    await onNavigate(target);
  }, [navBusy, navPrompt, onNavigate]);

  const handleNavConfirm = useCallback(async () => {
    if (!navPrompt || navBusy) return;
    setNavBusy(true);
    try {
      const target = navPrompt.targetIndex;
      const ok =
        navPrompt.kind === 'worker_submit' ? await onSubmitForReview() : await onApprove();
      setNavPrompt(null);
      if (ok) await onNavigate(target);
    } finally {
      setNavBusy(false);
    }
  }, [navBusy, navPrompt, onApprove, onNavigate, onSubmitForReview]);

  return {
    navPrompt,
    navBusy,
    navPromptRef,
    requestNavigate,
    handleNavCancel,
    handleNavConfirm,
    isNavPromptOpen: navPrompt !== null,
  };
}
