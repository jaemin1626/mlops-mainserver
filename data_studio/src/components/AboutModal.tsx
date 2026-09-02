import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
  changelogMarkdown: string;
}

type ReleaseKind = 'feature' | 'improve' | 'launch';

interface ChangelogSection {
  title: string;
  items: string[];
}

interface ChangelogRelease {
  version: string;
  kind: ReleaseKind;
  summary: string;
  sections: ChangelogSection[];
}

const KIND_LABEL: Record<ReleaseKind, string> = {
  feature: '새 기능',
  improve: '개선',
  launch: '첫 버전',
};

const KIND_CHIP: Record<ReleaseKind, string> = {
  feature: 'bg-[var(--accent-lime)]/15 text-[var(--accent-lime)] border-[var(--accent-lime)]/35',
  improve: 'bg-cyan-500/15 text-cyan-200 border-cyan-400/35',
  launch: 'bg-[var(--accent-purple)]/20 text-[#E4D4F5] border-[var(--accent-purple)]/40',
};

function formatInline(text: string): React.ReactNode {
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  const parts = text.split(tokenRe);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="px-1 py-0.5 rounded-md bg-white/10 text-cyan-200/95 text-[12px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

function detectKind(heading: string): ReleaseKind {
  if (heading.includes('첫 버전') || heading.includes('첫 릴리스')) return 'launch';
  if (heading.includes('개선') || heading.includes('수정')) return 'improve';
  return 'feature';
}

function isDevSection(title: string): boolean {
  return title.includes('개발 참고') || title.includes('개발자');
}

function parseChangelog(md: string): ChangelogRelease[] {
  const cleaned = md.replace(/<!--[\s\S]*?-->/g, '');
  const lines = cleaned.split('\n');
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;
  let awaitingSummary = false;

  const flushSection = () => {
    if (!current || !section) return;
    if (!isDevSection(section.title) && (section.items.length > 0 || section.title)) {
      current.sections.push(section);
    }
    section = null;
  };

  const flushRelease = () => {
    flushSection();
    if (current) releases.push(current);
    current = null;
  };

  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t === '---') continue;
    if (t.startsWith('# ')) continue;

    if (t.startsWith('## ')) {
      flushRelease();
      const heading = t.slice(3).trim();
      const version = heading.match(/(\d+\.\d+\.\d+)/)?.[1] ?? heading;
      current = {
        version,
        kind: detectKind(heading),
        summary: '',
        sections: [],
      };
      awaitingSummary = true;
      continue;
    }

    if (!current) continue;

    if (t.startsWith('### ')) {
      flushSection();
      awaitingSummary = false;
      section = { title: t.slice(4).trim(), items: [] };
      continue;
    }

    if (t.startsWith('- ')) {
      awaitingSummary = false;
      if (!section) section = { title: '', items: [] };
      section.items.push(t.slice(2).trim());
      continue;
    }

    if (t === '**한 줄 요약**' || t === '**첫 릴리스**') {
      if (t.includes('첫 릴리스') && !current.summary) current.summary = '첫 릴리스';
      continue;
    }

    if (awaitingSummary && !current.summary) {
      current.summary = t.replace(/\*\*/g, '').trim();
      awaitingSummary = false;
    }
  }

  flushRelease();
  return releases;
}

const ReleaseCard: React.FC<{
  release: ChangelogRelease;
  isCurrent: boolean;
  expanded: boolean;
  onToggle: () => void;
}> = ({ release, isCurrent, expanded, onToggle }) => {
  const headingId = `release-${release.version.replace(/\./g, '-')}`;
  return (
    <article
      className={`rounded-2xl border overflow-hidden transition-colors ${
        isCurrent
          ? 'border-[var(--accent-lime)]/35 bg-[var(--accent-lime)]/[0.06] shadow-[0_0_24px_rgba(168,230,27,0.08)]'
          : 'border-white/10 bg-white/[0.03]'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-4 py-3.5 flex items-start gap-3 hover:bg-white/[0.04] transition-colors"
        aria-expanded={expanded}
        aria-controls={`${headingId}-body`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-lg font-bold tabular-nums leading-none ${isCurrent ? 'text-[var(--accent-lime)]' : 'text-white'}`}>
              {release.version}
            </span>
            {isCurrent && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-[var(--accent-lime)] text-[#1A1A2E]">
                현재
              </span>
            )}
            <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-md border ${KIND_CHIP[release.kind]}`}>
              {KIND_LABEL[release.kind]}
            </span>
          </div>
          {release.summary && (
            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-300">{formatInline(release.summary)}</p>
          )}
        </div>
        <svg
          className={`w-5 h-5 shrink-0 mt-0.5 text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && release.sections.length > 0 && (
        <div id={`${headingId}-body`} className="px-4 pb-4 pt-0 space-y-4 border-t border-white/5">
          {release.sections.map((sec, si) => (
            <section key={`${release.version}-${si}`} className="pt-3">
              {sec.title ? (
                <h4 className="text-[12px] font-bold text-slate-200 mb-2 tracking-wide">{formatInline(sec.title)}</h4>
              ) : null}
              <ul className="space-y-1.5">
                {sec.items.map((item, ii) => (
                  <li key={ii} className="flex gap-2.5 text-[13px] leading-relaxed text-slate-300">
                    <span
                      className="mt-[7px] w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--accent-lime)]/80"
                      aria-hidden
                    />
                    <span className="min-w-0">{formatInline(item)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </article>
  );
};

const AboutModal: React.FC<AboutModalProps> = ({ open, onClose, changelogMarkdown }) => {
  const releases = useMemo(() => parseChangelog(changelogMarkdown), [changelogMarkdown]);
  const currentVersion = __APP_VERSION__;
  const [openVersions, setOpenVersions] = useState<Set<string>>(() => new Set([currentVersion]));

  useEffect(() => {
    if (!open) return;
    setOpenVersions(new Set([currentVersion]));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, currentVersion]);

  if (!open) return null;

  const mode = import.meta.env.MODE;
  const buildLabel = mode === 'development' ? '개발 모드' : '설치본';
  const currentRelease = releases.find((r) => r.version === currentVersion) ?? releases[0];
  const older = releases.filter((r) => r !== currentRelease);

  const toggle = (version: string) => {
    setOpenVersions((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/65 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="glass-card max-w-2xl w-full max-h-[min(90vh,840px)] overflow-hidden flex flex-col border border-white/10 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
      >
        <div className="flex items-start justify-between gap-3 px-6 py-5 border-b border-white/10 shrink-0 bg-gradient-to-r from-slate-900/90 to-slate-900/30">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 mb-1">Intellivix Data Studio</p>
            <h2 id="about-title" className="text-xl font-bold text-white tracking-tight">
              업데이트 내용
            </h2>
            <p className="text-sm text-slate-400 mt-1.5">
              지금 사용 중{' '}
              <span className="font-semibold text-[var(--accent-lime)] tabular-nums">v{currentVersion}</span>
              <span className="text-slate-600"> · </span>
              {buildLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
            aria-label="닫기"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 overflow-auto flex-1 min-h-0 space-y-3 bg-slate-950/40">
          {currentRelease ? (
            <ReleaseCard
              release={currentRelease}
              isCurrent
              expanded={openVersions.has(currentRelease.version)}
              onToggle={() => toggle(currentRelease.version)}
            />
          ) : (
            <p className="text-sm text-slate-500 px-1">표시할 업데이트 내용이 없습니다.</p>
          )}

          {older.length > 0 && (
            <div className="pt-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 px-1 mb-2">이전 버전</p>
              <div className="space-y-2">
                {older.map((release) => (
                  <ReleaseCard
                    key={release.version}
                    release={release}
                    isCurrent={false}
                    expanded={openVersions.has(release.version)}
                    onToggle={() => toggle(release.version)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex justify-end shrink-0 bg-slate-900/60">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-semibold transition-all border border-white/10 hover:border-[var(--accent-blue)] hover:shadow-[0_0_16px_rgba(82,182,255,0.15)]"
            style={{ color: 'var(--accent-blue)' }}
          >
            닫기
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AboutModal;
