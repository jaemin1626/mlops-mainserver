import React, { useCallback, useState } from 'react';
import ServerFolderPicker from './components/ServerFolderPicker';
import YoloShortcutsModal from './components/YoloShortcutsModal';
import type { YoloLaunchRequest } from './dashboardTypes';
import Dashboard from './modes/Dashboard';
import LandmarkWorkspace from './modes/LandmarkWorkspace';
import OcrLabelWorkspace from './modes/OcrLabelWorkspace';
import PolygonWorkspace from './modes/PolygonWorkspace';
import VlmWorkspace from './modes/VlmWorkspace';
import YoloWorkspace from './modes/YoloWorkspace';

export type AppMode = 'home' | 'yolo' | 'vlm' | 'polygon' | 'landmark' | 'ocr';

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('home');
  const [yoloLaunch, setYoloLaunch] = useState<YoloLaunchRequest | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const isWeb = window.__DATA_STUDIO_WEB__ === true;

  const handleOpenYoloFromDashboard = useCallback((request: YoloLaunchRequest) => {
    setYoloLaunch(request);
    setMode('yolo');
  }, []);

  const handleYoloLaunchConsumed = useCallback(() => {
    setYoloLaunch(null);
  }, []);

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <header className="glass flex-shrink-0 border-b border-white/10 px-4 py-2.5 flex items-center gap-4 rounded-none z-10">
        <div className="flex items-center gap-2.5 shrink-0">
          <img src={`${import.meta.env.BASE_URL}logo.ico`} alt="" className="w-8 h-8 rounded-xl object-contain ring-1 ring-white/10" />
          <span className="font-bold text-sm sm:text-base tracking-tight text-white whitespace-nowrap">Intellivix Data Studio</span>
        </div>
        <div className="flex rounded-xl p-0.5 glass border border-white/10 shrink-0" role="tablist" aria-label="작업 모드">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'home'}
            onClick={() => setMode('home')}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${mode === 'home' ? 'bg-white/15 text-white shadow-[0_0_16px_rgba(255,255,255,0.12)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
          >
            홈
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'yolo'}
            onClick={() => setMode('yolo')}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${mode === 'yolo' ? 'bg-[var(--accent-lime)] text-[#1A1A2E] shadow-[0_0_16px_rgba(168,230,27,0.35)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
          >
            YOLO 라벨
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'vlm'}
            onClick={() => setMode('vlm')}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${mode === 'vlm' ? 'bg-[var(--accent-purple)]/90 text-white shadow-[0_0_16px_rgba(176,142,212,0.35)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
          >
            VLM 작업
          </button>
          {!isWeb && (
            <>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'polygon'}
                onClick={() => setMode('polygon')}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${mode === 'polygon' ? 'bg-cyan-500/85 text-[#0f172a] shadow-[0_0_16px_rgba(34,211,238,0.35)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
              >
                Polygon
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'landmark'}
                onClick={() => setMode('landmark')}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${mode === 'landmark' ? 'bg-rose-500/90 text-white shadow-[0_0_16px_rgba(244,63,94,0.35)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
              >
                랜드마크
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'ocr'}
                onClick={() => setMode('ocr')}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${mode === 'ocr' ? 'bg-amber-500/90 text-[#1A1A2E] shadow-[0_0_16px_rgba(245,158,11,0.35)]' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
              >
                OCR 라벨
              </button>
            </>
          )}
        </div>
        <div className="flex-1 min-w-0" />
        {mode === 'yolo' && (
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-[var(--accent-lime)]/35 bg-[var(--accent-lime)]/10 text-xs font-semibold text-[var(--accent-lime)] hover:bg-[var(--accent-lime)]/20 hover:border-[var(--accent-lime)]/55 transition-all"
            title="단축키 안내"
          >
            <span className="font-mono text-sm leading-none">?</span>
            <span className="text-slate-200 font-medium">단축키</span>
          </button>
        )}
      </header>

      <YoloShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {isWeb && <ServerFolderPicker />}

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {mode === 'home' ? (
          <Dashboard onOpenYolo={handleOpenYoloFromDashboard} />
        ) : mode === 'yolo' ? (
          <YoloWorkspace launchRequest={yoloLaunch} onLaunchConsumed={handleYoloLaunchConsumed} />
        ) : mode === 'vlm' ? (
          <VlmWorkspace />
        ) : mode === 'polygon' ? (
          <PolygonWorkspace />
        ) : mode === 'landmark' ? (
          <LandmarkWorkspace />
        ) : (
          <OcrLabelWorkspace />
        )}
      </div>
    </div>
  );
};

export default App;
