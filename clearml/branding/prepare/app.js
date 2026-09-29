(function () {
  const SEOUL = '/seoul-studio';
  const STUDIO = '/data-studio/api';
  const DRAFT_KEY = 'ivx-prepare-draft-v1';
  const CLASS_FACE = 2;
  const CLASS_PLATE = 5;

  const $ = (sel) => document.querySelector(sel);
  const state = {
    target: 'detector',
    browsePath: '',
    selected: new Set(),
    destRoot: '',
    serverUrl: '',
    canMutate: false,
    blurReady: false,
  };

  function seoulUrl(path) {
    const p = path.startsWith('/api/') ? path : `/api/${path.replace(/^\//, '')}`;
    return `${SEOUL}${p}`;
  }

  async function seoulApi(path, options) {
    const response = await fetch(seoulUrl(path), { credentials: 'same-origin', ...options });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { detail: text };
    }
    if (!response.ok) {
      const msg = body?.detail || body?.error || (typeof body?.detail === 'object' ? JSON.stringify(body.detail) : '') || response.statusText;
      throw new Error(typeof msg === 'string' ? msg : '요청 실패');
    }
    return body;
  }

  async function studioApi(path) {
    const response = await fetch(`${STUDIO}${path}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Data Studio 요약을 불러오지 못했습니다.');
    return response.json();
  }

  function setStatus(el, message, tone) {
    if (!el) return;
    el.textContent = message || '';
    el.classList.remove('is-success', 'is-error', 'is-info');
    if (!message) return;
    if (tone === 'error') el.classList.add('is-error');
    else if (tone === 'success') el.classList.add('is-success');
    else if (tone === 'info') el.classList.add('is-info');
  }

  /** Data Studio scan: labelRate는 이미 0–100 정수(%) */
  function formatLabelRate(rate) {
    const n = Number(rate);
    if (!Number.isFinite(n)) return '—';
    if (n > 0 && n <= 1) return `${Math.round(n * 100)}%`;
    return `${Math.round(n)}%`;
  }

  function renderStatCards(container, cards) {
    container.replaceChildren();
    if (!cards.length) {
      const empty = document.createElement('p');
      empty.className = 'prepare-info-block';
      empty.textContent = '표시할 통계가 없습니다.';
      container.appendChild(empty);
      return;
    }
    cards.forEach((card) => {
      const div = document.createElement('div');
      div.className = `prepare-stat-card${card.variant ? ` ${card.variant}` : ''}`;
      div.innerHTML = `<div class="k">${card.label}</div><div class="v">${card.value}</div>${card.sub ? `<div class="sub">${card.sub}</div>` : ''}`;
      container.appendChild(div);
    });
  }

  function renderResultSummary(detail) {
    const box = $('#result-summary');
    if (!detail || !detail.dest_root) {
      box.innerHTML = '<h3>요약</h3><p>아직 Data Studio로 전달한 작업이 없습니다.</p>';
      $('#result-detail').textContent = '—';
      return;
    }
    const lines = [
      ['대상', detail.target === 'vlm' ? 'VLM' : 'Detector'],
      ['형식', detail.media_kind === 'video' ? '영상' : '프레임(이미지)'],
      ['저장 경로', detail.dest_root],
    ];
    if (detail.frame_count != null) lines.push(['추출 프레임', String(detail.frame_count)]);
    if (detail.video_count != null) lines.push(['영상 수', String(detail.video_count)]);
    box.innerHTML = `<h3>요약</h3><dl>${lines.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    $('#result-detail').textContent = JSON.stringify(detail, null, 2);
  }

  function updateLabelFolderBanner(folder) {
    const wrap = $('#label-folder-path');
    const code = $('#label-folder-code');
    if (!folder) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    code.textContent = folder;
  }

  function loadDraft() {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.target === 'vlm' || d.target === 'detector') state.target = d.target;
      if (d.browsePath != null) state.browsePath = d.browsePath;
      if (d.destRoot) state.destRoot = d.destRoot;
      if (d.projectSlug) $('#project-slug').value = d.projectSlug;
      if (d.handoffFolder) $('#handoff-folder-name').value = d.handoffFolder;
    } catch {
      /* ignore */
    }
  }

  function saveDraft() {
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          target: state.target,
          browsePath: state.browsePath,
          destRoot: state.destRoot,
          projectSlug: $('#project-slug').value.trim(),
          handoffFolder: $('#handoff-folder-name').value.trim(),
        })
      );
    } catch {
      /* ignore */
    }
  }

  function syncTargetUi() {
    const isVlm = state.target === 'vlm';
    $('#target-detector').setAttribute('aria-pressed', isVlm ? 'false' : 'true');
    $('#target-vlm').setAttribute('aria-pressed', isVlm ? 'true' : 'false');
    $('#field-vlm-media').hidden = !isVlm;
    const mediaKind = isVlm ? $('#vlm-media-kind').value : 'image';
    $('#field-frame-interval').hidden = isVlm && mediaKind === 'video';
    updateStudioLink();
    saveDraft();
  }

  function selectedClassIds() {
    return [...document.querySelectorAll('#anonymize-classes button.is-selected')]
      .map((btn) => Number(btn.dataset.classId))
      .filter((n) => Number.isInteger(n));
  }

  function bindClassButtons() {
    document.querySelectorAll('#anonymize-classes button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const selected = selectedClassIds();
        const id = Number(btn.dataset.classId);
        const on = btn.classList.contains('is-selected');
        if (on && selected.length <= 1) return;
        btn.classList.toggle('is-selected', !on);
        btn.setAttribute('aria-pressed', !on ? 'true' : 'false');
      });
    });
  }

  function syncHandoffFolderFromProject() {
    const slug = $('#project-slug').value.trim();
    const handoff = $('#handoff-folder-name');
    if (!handoff.value.trim() && slug) handoff.value = slug;
  }

  async function loadBootstrap() {
    const data = await seoulApi('/api/bootstrap');
    state.serverUrl = data.config?.server_url || '';
    state.blurReady = Boolean(data.blur?.weights_ready);
    if (!state.browsePath) {
      state.browsePath = data.config?.output_subdir || '';
    }
    const conn = $('#connection');
    conn.textContent = state.canMutate
      ? 'Seoul Studio API 연결됨 · 데이터 생성 권한 있음'
      : 'Seoul Studio API 연결됨 · 전달은 DATA_GENERATE 권한 필요';
  }

  async function loadAuth() {
    try {
      const r = await fetch('/access-api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error();
      const me = await r.json();
      const perms = me.permissions || [];
      state.canMutate = Boolean(me.is_admin || perms.includes('DATA_GENERATE'));
      const canOpen =
        me.is_admin || perms.includes('DATA_GENERATE') || perms.includes('LABEL_WORK') || perms.includes('LABEL_REVIEW');
      if (!canOpen && window.parent !== window) {
        window.parent.postMessage({ type: 'ivx-close-prepare' }, location.origin);
      }
    } catch {
      state.canMutate = false;
    }
    $('#run-handoff').disabled = !state.canMutate;
  }

  function renderSubfolders(subfolders) {
    const box = $('#browse-subfolders');
    box.replaceChildren();
    if (!subfolders?.length) {
      box.innerHTML = '<p class="hint">하위 폴더 없음</p>';
      return;
    }
    subfolders.forEach((folder) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'folder-modal-item';
      btn.textContent = `📁 ${folder.name}${folder.video_count ? ` (${folder.video_count})` : ''}`;
      btn.addEventListener('click', () => {
        state.browsePath = folder.path;
        state.selected.clear();
        saveDraft();
        void loadBrowse();
      });
      box.appendChild(btn);
    });
  }

  function renderVideos(items) {
    const box = $('#browse-videos');
    box.replaceChildren();
    const videos = (items || []).filter((item) => {
      const name = (item.name || '').toLowerCase();
      return name.endsWith('.mp4') || name.endsWith('.webm') || name.endsWith('.mov') || item.media_kind === 'video';
    });
    if (!videos.length) {
      box.innerHTML = '<p class="hint">이 폴더에 영상이 없습니다.</p>';
      return;
    }
    videos.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'video-row';
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selected.has(item.name);
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (state.selected.size >= 50) {
            cb.checked = false;
            setStatus($('#browse-status'), '한 번에 50개까지 선택할 수 있습니다.', 'error');
            return;
          }
          state.selected.add(item.name);
        } else {
          state.selected.delete(item.name);
        }
        setStatus($('#browse-status'), `${state.selected.size}개 선택`, 'success');
      });
      const text = document.createElement('span');
      text.textContent = item.name.split('/').pop() || item.name;
      label.appendChild(cb);
      label.appendChild(text);
      row.appendChild(label);
      box.appendChild(row);
    });
    setStatus($('#browse-status'), `${state.selected.size}개 선택 · 영상 ${videos.length}개`, '');
  }

  async function loadBrowse() {
    setStatus($('#browse-status'), '불러오는 중…', '');
    const q = new URLSearchParams();
    if (state.browsePath) q.set('path', state.browsePath);
    q.set('media_filter', 'all');
    const data = await seoulApi(`/api/outputs/browse?${q.toString()}`);
    state.browsePath = data.path || '';
    const pathLabel = data.root_label || 'generate_datasets';
    $('#browse-path').textContent = state.browsePath ? `${pathLabel} / ${state.browsePath}` : pathLabel;
    $('#browse-up').disabled = !state.browsePath;
    renderSubfolders(data.subfolders);
    renderVideos(data.items);
    saveDraft();
  }

  function browseUp() {
    if (!state.browsePath) return;
    const parts = state.browsePath.split('/').filter(Boolean);
    parts.pop();
    state.browsePath = parts.join('/');
    state.selected.clear();
    void loadBrowse();
  }

  async function applyProjectFolder() {
    const name = $('#project-slug').value.trim();
    if (!name) {
      setStatus($('#project-status'), '프로젝트 폴더명을 입력하세요.', 'error');
      return;
    }
    if (!state.canMutate) {
      setStatus($('#project-status'), 'DATA_GENERATE 권한이 필요합니다.', 'error');
      return;
    }
    setStatus($('#project-status'), '폴더 준비 중…', '');
    try {
      // 항상 generate_datasets 루트(상대 경로 "") 아래에만 만든다. 브라우저 현재 경로와 무관.
      const parent = '';
      const childPath = name;
      try {
        await seoulApi('/api/outputs/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent, name }),
        });
      } catch (err) {
        if (!String(err.message).includes('같은 이름')) throw err;
      }
      await seoulApi('/api/outputs/active-folder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: childPath }),
      });
      if (state.serverUrl) {
        await seoulApi('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server_url: state.serverUrl, output_subdir: childPath }),
        });
      }
      state.browsePath = childPath;
      state.selected.clear();
      syncHandoffFolderFromProject();
      await loadBrowse();
      setStatus($('#project-status'), `저장 위치: generate_datasets / ${childPath}`, 'success');
      setStatus($('#browse-status'), `${state.selected.size}개 선택`, '');
      saveDraft();
    } catch (err) {
      setStatus($('#project-status'), err.message, 'error');
    }
  }

  async function waitExportJob(jobId) {
    for (;;) {
      const job = await seoulApi(`/api/outputs/export/jobs/${jobId}`);
      if (job.state === 'running') {
        setStatus($('#handoff-status'), '전달 작업 진행 중…', '');
        await new Promise((r) => setTimeout(r, 700));
        continue;
      }
      return job;
    }
  }

  async function runHandoff() {
    const paths = [...state.selected];
    if (!paths.length) {
      setStatus($('#handoff-status'), '브라우저에서 영상을 하나 이상 선택하세요.', 'error');
      return;
    }
    const folderName = $('#handoff-folder-name').value.trim() || $('#project-slug').value.trim();
    if (!folderName) {
      setStatus($('#handoff-status'), '작업 폴더명을 입력하세요.', 'error');
      return;
    }
    const anonymize = $('#handoff-anonymize').checked;
    const classes = anonymize ? selectedClassIds() : [];
    if (anonymize && !classes.length) {
      setStatus($('#handoff-status'), '비식별화 대상을 하나 이상 선택하세요.', 'error');
      return;
    }
    if (anonymize && !state.blurReady) {
      setStatus($('#handoff-status'), '비식별화 가중치가 준비되지 않았습니다.', 'error');
      return;
    }

    const target = state.target;
    const mediaKind = target === 'detector' ? 'image' : $('#vlm-media-kind').value;
    const frameInterval = Math.trunc(Number($('#frame-interval').value)) || 30;

    $('#run-handoff').disabled = true;
    setStatus($('#handoff-status'), '작업 시작…', '');
    try {
      const started = await seoulApi('/api/outputs/export/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paths,
          browse_path: state.browsePath,
          media_filter: 'all',
          action: 'send',
          target,
          media_kind: mediaKind,
          frame_interval: frameInterval,
          folder_name: folderName,
          anonymize,
          classes,
        }),
      });
      const job = await waitExportJob(started.id || started.job_id);
      if (job.state === 'failed') {
        throw new Error(job.error || '전달 실패');
      }
      const last = (job.results || []).find((e) => e.dest_root) || job.results?.[job.results.length - 1];
      state.destRoot = last?.dest_root || job.dest_root || '';
      const detail = {
        target,
        media_kind: mediaKind,
        dest_root: state.destRoot,
        frame_count: last?.frame_count,
        video_count: last?.video_count,
      };
      renderResultSummary(detail);
      updateLabelFolderBanner(state.destRoot);
      setStatus($('#handoff-status'), state.destRoot ? `전달 완료: ${state.destRoot}` : '전달 완료', 'success');
      state.selected.clear();
      await loadBrowse();
      enableStudioActions(true);
      saveDraft();
      await refreshLabelStats();
    } catch (err) {
      setStatus($('#handoff-status'), err.message, 'error');
    } finally {
      $('#run-handoff').disabled = !state.canMutate;
    }
  }

  function studioMode() {
    return state.target === 'vlm' ? 'vlm' : 'yolo';
  }

  function studioFolderPath() {
    if (state.destRoot) return state.destRoot;
    return '';
  }

  function updateStudioLink() {
    const path = studioFolderPath();
    const open = $('#prepare-open-studio');
    const refresh = $('#refresh-label-stats');
    const enabled = Boolean(path);
    open.disabled = !enabled;
    refresh.disabled = !enabled;
  }

  function enableStudioActions(on) {
    updateStudioLink();
    if (!on) return;
  }

  function openDataStudio() {
    const folder = studioFolderPath();
    if (!folder) return;
    const mode = studioMode();
    const url = `/data-studio/?mode=${encodeURIComponent(mode)}&folder=${encodeURIComponent(folder)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function refreshLabelStats() {
    const folder = studioFolderPath();
    if (!folder) return;
    updateLabelFolderBanner(folder);
    setStatus($('#label-status'), 'Data Studio에서 이 폴더 기준으로 집계 중…', 'info');
    try {
      const summary =
        state.target === 'vlm'
          ? await studioApi(`/dashboard/vlm-summary?root=${encodeURIComponent(folder)}`)
          : await studioApi(`/dashboard/yolo-summary?root=${encodeURIComponent(folder)}`);
      const totals = summary.totals || {};
      const byStatus = totals.byStatus || {};
      const stats =
        summary.folders?.length === 1
          ? summary.folders[0]
          : summary.folders?.find((f) => f.folderPath === folder) || null;

      const totalItems = stats?.totalImages ?? totals.totalImages ?? 0;
      const labeled = stats?.labeledImages ?? totals.labeledImages ?? 0;
      const labelRate = stats?.labelRate ?? totals.labelRate ?? 0;
      const pending = stats?.byStatus?.submitted ?? byStatus.submitted ?? 0;
      const approved = stats?.byStatus?.approved ?? byStatus.approved ?? 0;
      const rejected = stats?.byStatus?.rejected ?? byStatus.rejected ?? 0;
      const draft = stats?.byStatus?.draft ?? byStatus.draft ?? 0;

      const cards = [
        { label: '항목 수', value: String(totalItems), sub: state.target === 'vlm' ? '이미지·영상 합계' : '이미지' },
        { label: '라벨 있음', value: String(labeled), sub: `라벨률 ${formatLabelRate(labelRate)}`, variant: 'accent' },
        { label: '검수 대기', value: String(pending), sub: 'submitted' },
        { label: '승인', value: String(approved), sub: 'approved', variant: 'accent' },
        { label: '반려', value: String(rejected), sub: 'rejected', variant: rejected > 0 ? 'warn' : '' },
        { label: '작업 중', value: String(draft), sub: 'draft' },
      ];

      if (state.target === 'vlm' && stats) {
        cards.splice(1, 0, {
          label: '영상 / 이미지',
          value: `${stats.videoCount ?? 0} / ${stats.imageCount ?? 0}`,
          sub: '미디어 구분',
        });
      }

      renderStatCards($('#label-stats'), cards);
      setStatus($('#label-status'), `갱신: ${new Date().toLocaleTimeString()} · 경로 기준 집계`, 'success');
    } catch (err) {
      renderStatCards($('#label-stats'), []);
      setStatus($('#label-status'), err.message, 'error');
    }
  }

  function bindTabs() {
    $('#tab-browse').addEventListener('click', () => {
      $('#tab-browse').setAttribute('aria-selected', 'true');
      $('#tab-generate').setAttribute('aria-selected', 'false');
      $('#panel-browse').hidden = false;
      $('#panel-generate').hidden = true;
    });
    $('#tab-generate').addEventListener('click', () => {
      $('#tab-generate').setAttribute('aria-selected', 'true');
      $('#tab-browse').setAttribute('aria-selected', 'false');
      $('#panel-generate').hidden = false;
      $('#panel-browse').hidden = true;
    });
  }

  function bindTarget() {
    document.querySelectorAll('[data-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.target = btn.dataset.target === 'vlm' ? 'vlm' : 'detector';
        syncTargetUi();
      });
    });
    $('#vlm-media-kind').addEventListener('change', syncTargetUi);
  }

  async function init() {
    loadDraft();
    bindTabs();
    bindTarget();
    bindClassButtons();
    syncTargetUi();
    syncHandoffFolderFromProject();

    $('#project-slug').addEventListener('input', syncHandoffFolderFromProject);
    $('#apply-project-folder').addEventListener('click', () => void applyProjectFolder());
    $('#browse-refresh').addEventListener('click', () => void loadBrowse());
    $('#browse-up').addEventListener('click', browseUp);
    $('#run-handoff').addEventListener('click', () => void runHandoff());
    $('#prepare-open-studio').addEventListener('click', openDataStudio);
    $('#refresh-label-stats').addEventListener('click', () => void refreshLabelStats());

    await loadAuth();
    try {
      await loadBootstrap();
    } catch (err) {
      $('#connection').textContent = `Seoul Studio 연결 실패: ${err.message}`;
      return;
    }
    try {
      await loadBrowse();
    } catch (err) {
      setStatus($('#browse-status'), err.message, 'error');
    }
    if (state.destRoot) {
      renderResultSummary({
        target: state.target,
        media_kind: 'image',
        dest_root: state.destRoot,
      });
      updateLabelFolderBanner(state.destRoot);
      enableStudioActions(true);
      renderStatCards($('#label-stats'), [
        { label: '안내', value: '↻', sub: '진행률 새로고침을 눌러 주세요' },
      ]);
      void refreshLabelStats();
    } else {
      renderResultSummary(null);
      renderStatCards($('#label-stats'), [
        { label: '대기', value: '—', sub: '03단계 전달 후 표시됩니다' },
      ]);
    }

    bindCloseToParent();
  }

  function bindCloseToParent() {
    const inModal = window.parent !== window;
    const closeBtn = document.querySelector('.close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        if (!inModal) return;
        e.preventDefault();
        window.parent.postMessage({ type: 'ivx-close-prepare' }, location.origin);
      });
    }
    if (inModal) {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          window.parent.postMessage({ type: 'ivx-close-prepare' }, location.origin);
        }
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else void init();
})();
