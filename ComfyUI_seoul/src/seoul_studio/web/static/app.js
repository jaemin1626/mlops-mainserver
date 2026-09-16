const MODE = "i2v";
let activeView = "create";
let libraryLoaded = false;
let libraryRootLabel = "generate_datasets";
let bootstrapData = null;
let outputSubdir = "";
let settingsBrowsePath = "";
let libraryBrowsePath = "";
let libraryCurrentItems = [];
let librarySelectedPaths = new Set();
let sendToTaskPaths = [];

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatModifiedAt(iso) {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function outputVideoUrl(name) {
  const segments = String(name).split("/").map(encodeURIComponent).join("/");
  return apiUrl(`/api/outputs/${segments}`);
}

function switchView(view) {
  activeView = view;
  const createView = document.getElementById("view-create");
  const libraryView = document.getElementById("view-library");
  const tabs = document.querySelectorAll(".mode-tab[data-view]");

  createView.hidden = view !== "create";
  libraryView.hidden = view !== "library";

  tabs.forEach((tab) => {
    const isActive = tab.dataset.view === view;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  if (view === "library") {
    loadLibrary().catch((err) => setStatus(err.message, "error"));
  }
}

function renderLibraryItem(item) {
  const li = document.createElement("li");
  li.className = "library-item";
  if (librarySelectedPaths.has(item.name)) {
    li.classList.add("is-selected");
  }

  const top = document.createElement("div");
  top.className = "library-item-top";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "library-item-check";
  checkbox.checked = librarySelectedPaths.has(item.name);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      librarySelectedPaths.add(item.name);
      li.classList.add("is-selected");
    } else {
      librarySelectedPaths.delete(item.name);
      li.classList.remove("is-selected");
    }
    updateLibraryBulkBar();
  });

  top.appendChild(checkbox);

  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.src = `${outputVideoUrl(item.name)}?t=${encodeURIComponent(item.modified_at || "")}`;
  top.appendChild(video);
  li.appendChild(top);

  const meta = document.createElement("div");
  meta.className = "library-item-meta";

  const title = document.createElement("p");
  title.className = "library-item-name";
  title.textContent = item.name.split("/").pop() || item.name;
  title.title = item.name;

  const detail = document.createElement("p");
  detail.className = "library-item-detail";
  detail.textContent = `${formatFileSize(item.size)} · ${formatModifiedAt(item.modified_at)}`;

  const actions = document.createElement("div");
  actions.className = "library-item-actions";

  const send = document.createElement("button");
  send.type = "button";
  send.className = "btn btn-ghost btn-sm";
  send.textContent = "작업으로 보내기";
  send.addEventListener("click", () => {
    openSendToTaskModal([item.name]);
  });

  const download = document.createElement("a");
  download.className = "btn btn-ghost btn-sm";
  download.href = outputVideoUrl(item.name);
  download.download = item.name.split("/").pop() || item.name;
  download.textContent = "다운로드";

  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn btn-ghost btn-sm btn-danger-text";
  del.textContent = "삭제";
  del.addEventListener("click", () => {
    deleteLibraryItem(item).catch((err) => setStatus(err.message, "error"));
  });

  meta.appendChild(title);
  meta.appendChild(detail);
  actions.appendChild(send);
  actions.appendChild(download);
  actions.appendChild(del);
  li.appendChild(meta);
  li.appendChild(actions);
  return li;
}

function updateLibraryBulkBar() {
  const bar = document.getElementById("library-bulk-bar");
  const countEl = document.getElementById("library-selected-count");
  const selectAll = document.getElementById("library-select-all");
  const sendBtn = document.getElementById("library-bulk-send");
  const downloadBtn = document.getElementById("library-bulk-download");
  const deleteBtn = document.getElementById("library-bulk-delete");
  const count = librarySelectedPaths.size;
  const total = libraryCurrentItems.length;

  bar.hidden = total === 0;
  countEl.textContent = `${count}개 선택`;
  sendBtn.disabled = count === 0;
  downloadBtn.disabled = count === 0;
  deleteBtn.disabled = count === 0;

  if (!total) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }

  selectAll.checked = count > 0 && count === total;
  selectAll.indeterminate = count > 0 && count < total;
}

function setLibrarySelection(paths, selected) {
  paths.forEach((path) => {
    if (selected) {
      librarySelectedPaths.add(path);
    } else {
      librarySelectedPaths.delete(path);
    }
  });
}

function renderLibraryList(items, path) {
  const list = document.getElementById("library-list");
  list.innerHTML = "";
  libraryCurrentItems = items || [];

  const visiblePaths = new Set(libraryCurrentItems.map((item) => item.name));
  librarySelectedPaths.forEach((selectedPath) => {
    if (!visiblePaths.has(selectedPath)) {
      librarySelectedPaths.delete(selectedPath);
    }
  });

  if (!libraryCurrentItems.length) {
    const empty = document.createElement("li");
    empty.id = "library-empty";
    empty.className = "library-empty";
    empty.textContent = path
      ? "이 폴더에 영상이 없습니다. 하위 폴더를 만들거나 영상을 생성하세요."
      : "루트 폴더에 영상이 없습니다. 하위 폴더를 만들거나 영상을 생성하세요.";
    list.appendChild(empty);
    updateLibraryBulkBar();
    return;
  }

  libraryCurrentItems.forEach((item) => {
    list.appendChild(renderLibraryItem(item));
  });
  updateLibraryBulkBar();
}

function formatLibraryPath(path) {
  if (!path) {
    return libraryRootLabel;
  }
  return `${libraryRootLabel}/${path}`;
}

function updateSaveLocationHint(path) {
  const hint = document.getElementById("save-location-hint");
  const selected = document.getElementById("settings-selected-folder");
  const displayPath = formatLibraryPath(path);
  if (hint) {
    hint.textContent = `저장 위치: ${displayPath}`;
  }
  if (selected) {
    selected.textContent = displayPath;
  }
}

async function browseFolder(path) {
  return api(`/api/outputs/browse?path=${encodeURIComponent(path || "")}`);
}

function renderFolderBreadcrumb(containerId, path, onNavigate) {
  const nav = document.getElementById(containerId);
  if (!nav) {
    return;
  }
  nav.innerHTML = "";

  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.className = "folder-crumb";
  rootButton.textContent = libraryRootLabel;
  rootButton.addEventListener("click", () => onNavigate(""));
  nav.appendChild(rootButton);

  if (!path) {
    rootButton.classList.add("is-current");
    return;
  }

  const parts = path.split("/");
  let prefix = "";
  parts.forEach((part, index) => {
    const sep = document.createElement("span");
    sep.className = "folder-crumb-sep";
    sep.textContent = "/";
    nav.appendChild(sep);

    prefix = prefix ? `${prefix}/${part}` : part;
    const targetPath = prefix;
    const isLast = index === parts.length - 1;
    if (isLast) {
      const current = document.createElement("span");
      current.className = "folder-crumb is-current";
      current.textContent = part;
      nav.appendChild(current);
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-crumb";
    button.textContent = part;
    button.addEventListener("click", () => onNavigate(targetPath));
    nav.appendChild(button);
  });
}

function formatFolderCount(count) {
  return Number.isFinite(count) && count > 0 ? ` · ${count}개` : "";
}

async function setActiveFolder(path) {
  const data = await api("/api/outputs/active-folder", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  outputSubdir = data.config.output_subdir || "";
  if (bootstrapData) {
    bootstrapData.config = data.config;
  }
  updateSaveLocationHint(outputSubdir);
  return data;
}

function renderSettingsFolderPicker(data) {
  libraryRootLabel = data.root_label || "generate_datasets";
  settingsBrowsePath = data.path || "";
  document.getElementById("output-dir").value = data.host_output_dir || data.output_dir || "—";
  updateSaveLocationHint(outputSubdir);
  renderFolderBreadcrumb("settings-folder-breadcrumb", settingsBrowsePath, async (path) => {
    const browse = await browseFolder(path);
    renderSettingsFolderPicker(browse);
  });

  const list = document.getElementById("settings-folder-list");
  list.innerHTML = "";

  if (!data.subfolders || !data.subfolders.length) {
    const empty = document.createElement("li");
    empty.className = "settings-folder-empty";
    empty.textContent = "하위 폴더가 없습니다. 아래에서 새 폴더를 만드세요.";
    list.appendChild(empty);
    return;
  }

  data.subfolders.forEach((folder) => {
    const li = document.createElement("li");
    li.className = "settings-folder-item";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "settings-folder-open";
    openButton.innerHTML = `<span class="settings-folder-icon" aria-hidden="true">📁</span><span>${folder.name}${formatFolderCount(folder.video_count)}</span>`;
    openButton.addEventListener("click", async () => {
      const browse = await browseFolder(folder.path);
      renderSettingsFolderPicker(browse);
    });

    li.appendChild(openButton);
    list.appendChild(li);
  });
}

async function loadSettingsFolderPicker() {
  settingsBrowsePath = outputSubdir;
  const data = await browseFolder(settingsBrowsePath);
  renderSettingsFolderPicker(data);
}

async function selectSettingsFolder() {
  await setActiveFolder(settingsBrowsePath);
  setStatus(`저장 위치: ${formatLibraryPath(outputSubdir)}`, "success");
}

async function createSettingsFolder() {
  const input = document.getElementById("settings-new-folder-name");
  const name = input.value.trim();
  if (!name) {
    setStatus("폴더 이름을 입력하세요.", "error");
    input.focus();
    return;
  }

  const data = await api("/api/outputs/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent: settingsBrowsePath, name }),
  });
  input.value = "";
  renderSettingsFolderPicker(data.browse);
  await setActiveFolder(data.folder.path);
  setStatus(`폴더 "${data.folder.name}" 을(를) 만들고 저장 위치로 설정했습니다.`, "success");
}

function renderLibrarySubfolders(subfolders) {
  const list = document.getElementById("library-subfolders");
  list.innerHTML = "";

  subfolders.forEach((folder) => {
    const li = document.createElement("li");
    li.className = "library-subfolder-item";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "library-subfolder-btn";
    button.innerHTML = `<span class="library-subfolder-icon" aria-hidden="true">📁</span><span class="library-subfolder-name">${folder.name}${formatFolderCount(folder.video_count)}</span>`;
    button.addEventListener("click", () => {
      navigateLibrary(folder.path).catch((err) => setStatus(err.message, "error"));
    });

    li.appendChild(button);
    list.appendChild(li);
  });
}

async function navigateLibrary(path) {
  libraryBrowsePath = path || "";
  librarySelectedPaths.clear();
  const data = await browseFolder(libraryBrowsePath);
  renderLibraryView(data);
}

function renderLibraryView(data) {
  libraryRootLabel = data.root_label || "generate_datasets";
  libraryBrowsePath = data.path || "";
  document.getElementById("library-current-path").textContent = formatLibraryPath(libraryBrowsePath);
  document.getElementById("library-host-output-dir").textContent = data.host_path || "—";
  renderFolderBreadcrumb("library-breadcrumb", libraryBrowsePath, async (path) => {
    await navigateLibrary(path);
  });
  renderLibrarySubfolders(data.subfolders || []);
  renderLibraryList(data.items || [], libraryBrowsePath);
}

async function deleteLibraryItem(item) {
  const label = item.name.split("/").pop() || item.name;
  if (!window.confirm(`"${label}" 영상을 삭제할까요?\n되돌릴 수 없습니다.`)) {
    return;
  }
  const segments = String(item.name).split("/").map(encodeURIComponent).join("/");
  await api(`/api/outputs/${segments}`, { method: "DELETE" });
  await loadLibrary();
  setStatus(`"${label}" 을(를) 삭제했습니다.`, "success");
}

async function clearCurrentLibraryFolder() {
  const folderLabel = formatLibraryPath(libraryBrowsePath);
  if (!window.confirm(`"${folderLabel}" 폴더의 영상을 모두 삭제할까요?\n하위 폴더는 삭제되지 않습니다.`)) {
    return;
  }
  const data = await api(`/api/outputs/delete-folder?path=${encodeURIComponent(libraryBrowsePath || "")}`, {
    method: "POST",
  });
  librarySelectedPaths.clear();
  renderLibraryView(data.browse);
  setStatus(`${data.count}개 영상을 삭제했습니다.`, "success");
}

function getSelectedLibraryPaths() {
  return [...librarySelectedPaths];
}

async function bulkDeleteLibraryItems() {
  const paths = getSelectedLibraryPaths();
  if (!paths.length) {
    return;
  }
  if (!window.confirm(`선택한 ${paths.length}개 영상을 삭제할까요?\n되돌릴 수 없습니다.`)) {
    return;
  }
  const data = await api("/api/outputs/delete-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, browse_path: libraryBrowsePath }),
  });
  librarySelectedPaths.clear();
  renderLibraryView(data.browse);
  const failed = data.failed?.length || 0;
  if (failed) {
    setStatus(`${data.count}개 삭제, ${failed}개 실패`, "error");
    return;
  }
  setStatus(`${data.count}개 영상을 삭제했습니다.`, "success");
}

async function apiBlob(path, options) {
  const response = await fetch(apiUrl(path), options);
  if (!response.ok) {
    const text = await response.text();
    let detail = "요청에 실패했습니다.";
    try {
      const body = text ? JSON.parse(text) : null;
      detail = body?.detail || detail;
    } catch (err) {
      detail = text || detail;
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return response.blob();
}

function getSendToTaskTarget() {
  const selected = document.querySelector('input[name="send-target"]:checked');
  return selected ? selected.value : "yolo";
}

function getSendToTaskMediaKind() {
  const selected = document.querySelector('input[name="send-media-kind"]:checked');
  return selected ? selected.value : "image";
}

function updateSendToTaskModal() {
  const target = getSendToTaskTarget();
  const mediaKindFieldset = document.getElementById("send-media-kind-fieldset");
  const frameSection = document.getElementById("send-frame-section");
  const destHint = document.getElementById("send-dest-hint");
  const summary = document.getElementById("send-to-task-summary");
  const mediaKind = getSendToTaskMediaKind();

  mediaKindFieldset.hidden = target !== "vlm";
  frameSection.hidden = target === "vlm" && mediaKind === "video";
  destHint.textContent =
    target === "yolo" ? "저장 위치: detector/generated" : "저장 위치: vlm/generated";
  summary.textContent =
    sendToTaskPaths.length === 1
      ? `「${sendToTaskPaths[0].split("/").pop()}」을(를) 작업 폴더로 보냅니다.`
      : `선택한 ${sendToTaskPaths.length}개 영상을 작업 폴더로 보냅니다.`;
}

function openSendToTaskModal(paths) {
  sendToTaskPaths = [...paths];
  document.getElementById("send-frame-interval").value = "30";
  document.querySelector('input[name="send-target"][value="yolo"]').checked = true;
  document.querySelector('input[name="send-media-kind"][value="image"]').checked = true;
  updateSendToTaskModal();
  document.getElementById("send-to-task-backdrop").hidden = false;
  document.getElementById("send-to-task-modal").hidden = false;
}

function closeSendToTaskModal() {
  sendToTaskPaths = [];
  document.getElementById("send-to-task-backdrop").hidden = true;
  document.getElementById("send-to-task-modal").hidden = true;
}

async function submitSendToTask() {
  if (!sendToTaskPaths.length) {
    return;
  }
  const target = getSendToTaskTarget();
  const mediaKind = target === "yolo" ? "image" : getSendToTaskMediaKind();
  const intervalRaw = Number(document.getElementById("send-frame-interval").value);
  const frameInterval = Number.isFinite(intervalRaw) ? Math.trunc(intervalRaw) : 0;
  if (mediaKind === "image" && (frameInterval < 1 || frameInterval > 10000)) {
    setStatus("추출 간격은 1~10000 사이여야 합니다.", "error");
    return;
  }

  const confirmBtn = document.getElementById("send-to-task-confirm");
  confirmBtn.disabled = true;
  setStatus("작업 폴더로 보내는 중…", "busy");
  try {
    const data = await api("/api/outputs/send-to-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: sendToTaskPaths,
        browse_path: libraryBrowsePath,
        target,
        media_kind: mediaKind,
        frame_interval: frameInterval,
      }),
    });
    closeSendToTaskModal();
    if (data.media_kind === "video") {
      setStatus(`${data.video_count}개 영상을 ${data.dest_root}(으)로 보냈습니다.`, "success");
    } else {
      setStatus(`${data.frame_count}장 이미지를 ${data.dest_root}(으)로 보냈습니다.`, "success");
    }
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    confirmBtn.disabled = false;
  }
}

async function bulkDownloadLibraryItems() {
  const paths = getSelectedLibraryPaths();
  if (!paths.length) {
    return;
  }
  setStatus(`${paths.length}개 영상 ZIP 준비 중…`, "busy");
  const blob = await apiBlob("/api/outputs/download-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, browse_path: libraryBrowsePath }),
  });
  const folderLabel = formatLibraryPath(libraryBrowsePath).replace(/\//g, "-");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${folderLabel}.zip`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus(`${paths.length}개 영상 ZIP 다운로드를 시작했습니다.`, "success");
}

async function loadLibrary() {
  const data = await browseFolder(libraryBrowsePath);
  renderLibraryView(data);
  libraryLoaded = true;
}

function maybeRefreshLibrary() {
  if (activeView === "library" || libraryLoaded) {
    loadLibrary().catch(() => {});
  }
}

function maybeClearValidationBanner() {
  if (!document.querySelector(".field.has-error")) {
    const banner = document.getElementById("validation-banner");
    if (banner) banner.hidden = true;
  }
}

function setFieldError(fieldId, errorId, message) {
  const field = document.getElementById(fieldId);
  const error = document.getElementById(errorId);
  if (message) {
    field.classList.add("has-error");
    error.textContent = message;
    error.hidden = false;
  } else {
    field.classList.remove("has-error");
    error.textContent = "";
    error.hidden = true;
    maybeClearValidationBanner();
  }
}

function clearValidation() {
  setFieldError("field-image", "error-image", "");
  setFieldError("field-prompt", "error-prompt", "");
  const banner = document.getElementById("validation-banner");
  if (banner) {
    banner.hidden = true;
    banner.innerHTML = "";
  }
}

function showValidationBanner(messages) {
  let banner = document.getElementById("validation-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "validation-banner";
    banner.className = "validation-banner";
    const panel = document.querySelector(".app-main .panel");
    panel.insertBefore(banner, panel.querySelector(".field"));
  }
  banner.hidden = false;
  banner.innerHTML =
    "<strong>입력을 확인해 주세요.</strong>" +
    "<ul>" +
    messages.map((msg) => `<li>${msg}</li>`).join("") +
    "</ul>";
}

function validateInput() {
  clearValidation();
  const errors = [];
  const imageInput = document.getElementById("i2v-image");
  const promptInput = document.getElementById("i2v-prompt");
  const hasImage = Boolean(imageInput.files && imageInput.files[0]);
  const prompt = promptInput.value.trim();

  if (!hasImage) {
    const message = "시작 이미지를 선택해 주세요.";
    setFieldError("field-image", "error-image", message);
    errors.push(message);
  }

  if (!prompt) {
    const message = "입력 프롬프트를 작성해 주세요.";
    setFieldError("field-prompt", "error-prompt", message);
    errors.push(message);
  }

  if (errors.length) {
    showValidationBanner(errors);
    setStatus(errors.length === 1 ? errors[0] : "필수 입력 항목을 확인해 주세요.", "error");
    const firstBad = document.querySelector(".field.has-error");
    if (firstBad) firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
    return false;
  }

  return true;
}

function apiUrl(path) {
  return path.startsWith("/") ? path.slice(1) : path;
}

function setStatus(message, tone = "idle") {
  const el = document.getElementById("status");
  el.textContent = message;
  el.classList.remove("is-busy", "is-error", "is-success");
  if (tone === "busy") el.classList.add("is-busy");
  if (tone === "error") el.classList.add("is-error");
  if (tone === "success") el.classList.add("is-success");
}

function clearJobProgress() {
  const wrap = document.getElementById("job-progress-wrap");
  const status = document.getElementById("job-progress-status");
  const step = document.getElementById("job-progress-step");
  const bar = document.getElementById("job-progress-bar");
  const detail = document.getElementById("job-progress-detail");
  wrap.hidden = true;
  wrap.classList.remove("is-error");
  status.textContent = "준비 중…";
  step.textContent = "";
  bar.style.width = "0%";
  bar.classList.add("is-indeterminate");
  detail.textContent = "";
}

function friendlyJobMessage(job) {
  if (!job) {
    return "준비 중…";
  }
  if (job.state === "done") {
    return "완료";
  }
  if (job.state === "error") {
    return "생성 실패";
  }

  const raw = String(job.message || "").trim();
  if (raw.includes("이미지 업로드")) {
    return "이미지 업로드 중…";
  }
  if (raw.includes("생성 요청")) {
    return "생성 요청 중…";
  }
  if (raw.includes("결과 저장")) {
    return "결과 저장 중…";
  }
  if (raw.includes("마무리")) {
    return "마무리 중…";
  }
  if (raw.includes("대기")) {
    return "대기 중…";
  }
  if (job.progress || job.indeterminate || raw.includes("생성") || raw.includes("진행")) {
    return "영상 생성 중…";
  }
  return raw || "준비 중…";
}

function jobProgressPercent(job) {
  if (job?.state === "done") {
    return 100;
  }
  const progress = job?.progress;
  if (!progress) {
    return null;
  }
  if (typeof progress.overall_percent === "number") {
    return progress.overall_percent;
  }
  if (typeof progress.percent === "number") {
    return progress.percent;
  }
  return null;
}

function updateJobProgress(job) {
  const wrap = document.getElementById("job-progress-wrap");
  const status = document.getElementById("job-progress-status");
  const step = document.getElementById("job-progress-step");
  const bar = document.getElementById("job-progress-bar");
  const detail = document.getElementById("job-progress-detail");
  if (!job) {
    return;
  }

  wrap.hidden = false;
  wrap.classList.remove("is-error");
  status.textContent = friendlyJobMessage(job);
  step.textContent = "";

  if (job.state === "error") {
    wrap.classList.add("is-error");
    bar.classList.remove("is-indeterminate");
    bar.style.width = "0%";
    detail.textContent = job.error || "";
    return;
  }

  if (job.state === "done") {
    bar.classList.remove("is-indeterminate");
    bar.style.width = "100%";
    detail.textContent = "";
    return;
  }

  const percent = jobProgressPercent(job);
  if (percent != null) {
    bar.classList.remove("is-indeterminate");
    bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    detail.textContent = `${percent}%`;
    return;
  }

  if (job.indeterminate) {
    bar.classList.add("is-indeterminate");
    bar.style.width = "35%";
    detail.textContent = "";
    return;
  }

  bar.classList.add("is-indeterminate");
  bar.style.width = "35%";
  detail.textContent = "";
}

function positionPopover(popover, trigger, options = {}) {
  const rect = trigger.getBoundingClientRect();
  const align = options.align || "start";
  const minWidth = options.minWidth || 280;
  const maxWidth = options.maxWidth || 420;

  popover.hidden = false;
  popover.style.overflow = "visible";
  popover.style.maxHeight = "none";

  let width = options.matchWidth ? rect.width : Math.min(maxWidth, window.innerWidth - 32);
  width = Math.max(minWidth, width);
  popover.style.width = `${width}px`;

  if (align === "end") {
    popover.style.left = "auto";
    popover.style.right = `${Math.max(16, window.innerWidth - rect.right)}px`;
  } else {
    popover.style.right = "auto";
    const left = Math.min(rect.left, window.innerWidth - width - 16);
    popover.style.left = `${Math.max(16, left)}px`;
  }

  let top = rect.bottom + 8;
  popover.style.top = `${top}px`;

  const popoverRect = popover.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - 16;
  const spaceAbove = rect.top - 16;

  if (popoverRect.height > spaceBelow && spaceAbove > popoverRect.height) {
    top = rect.top - popoverRect.height - 8;
    popover.style.top = `${Math.max(16, top)}px`;
  } else if (popoverRect.height > spaceBelow) {
    popover.style.maxHeight = `${Math.max(220, spaceBelow - 8)}px`;
    popover.style.overflow = "auto";
    popover.style.top = `${rect.bottom + 8}px`;
  }
}

function openDrawer(drawerId, triggerId, options) {
  closeDrawers();
  const drawer = document.getElementById(drawerId);
  const trigger = document.getElementById(triggerId);
  positionPopover(drawer, trigger, options);
  document.getElementById("drawer-backdrop").hidden = false;
}

function closeDrawers() {
  document.querySelectorAll(".popover").forEach((el) => {
    el.hidden = true;
  });
  document.getElementById("drawer-backdrop").hidden = true;
}

function openSettings() {
  openDrawer("settings-drawer", "toggle-settings", { align: "end", minWidth: 360 });
  loadSettingsFolderPicker().catch((err) => setStatus(err.message, "error"));
}

function openAdvanced() {
  openDrawer("advanced-drawer", "toggle-advanced", { align: "start", matchWidth: true });
}

function closeSettings() {
  closeDrawers();
}

async function api(path, options) {
  const response = await fetch(apiUrl(path), options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    body = { detail: text };
  }
  if (!response.ok) {
    const detail = body && body.detail ? body.detail : "요청에 실패했습니다.";
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

function fillSelect(select, items, labelFn) {
  select.innerHTML = "";
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = labelFn(item);
    option.selected = Boolean(item.default);
    select.appendChild(option);
  });
}

function syncSeedInput() {
  document.getElementById("seed").disabled = document.getElementById("random-seed").checked;
}

function resolutionLabel(item) {
  if (item.label) {
    return item.label;
  }
  if (item.width && item.height) {
    return `${item.width}×${item.height}`;
  }
  return String(item.id);
}

function syncFileDropLabel() {
  const input = document.getElementById("i2v-image");
  const title = document.querySelector(".file-drop-title");
  const sub = document.querySelector(".file-drop-sub");
  const file = input.files[0];
  if (file) {
    title.textContent = file.name;
    sub.textContent = "다른 파일을 선택하려면 클릭하세요";
  } else {
    title.textContent = "PNG, JPEG, WebP";
    sub.textContent = "클릭하거나 파일을 선택하세요";
  }
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  bootstrapData = data;
  fillSelect(
    document.getElementById("resolution"),
    data.resolutions,
    resolutionLabel
  );
  const aspectField = document.getElementById("aspect-ratio-field");
  const aspectSelect = document.getElementById("aspect-ratio");
  if (data.aspect_ratios && data.aspect_ratios.length) {
    fillSelect(aspectSelect, data.aspect_ratios, (item) => item.label || item.id);
    aspectField.hidden = false;
  } else {
    aspectField.hidden = true;
    aspectSelect.innerHTML = "";
  }
  fillSelect(document.getElementById("duration"), data.durations, (item) => item.label);
  document.getElementById("server-url").value = data.config.server_url;
  libraryRootLabel = data.root_label || "generate_datasets";
  document.getElementById("output-dir").value = data.host_output_dir || data.config.output_dir;
  outputSubdir = data.config.output_subdir || "";
  libraryBrowsePath = outputSubdir;
  updateSaveLocationHint(outputSubdir);
  syncSeedInput();
}

async function saveSettings() {
  await api("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      server_url: document.getElementById("server-url").value,
      output_subdir: outputSubdir,
    }),
  });
  setStatus("설정을 저장했습니다.", "success");
}

function previewSelectedImage() {
  const input = document.getElementById("i2v-image");
  const preview = document.getElementById("image-preview");
  const file = input.files[0];
  if (preview.dataset.url) {
    URL.revokeObjectURL(preview.dataset.url);
    delete preview.dataset.url;
  }
  syncFileDropLabel();
  if (input.files[0]) {
    setFieldError("field-image", "error-image", "");
  }
  if (!file) {
    preview.hidden = true;
    preview.removeAttribute("src");
    return;
  }
  const url = URL.createObjectURL(file);
  preview.dataset.url = url;
  preview.src = url;
  preview.hidden = false;
}

function clearResultsEmpty() {
  const empty = document.getElementById("results-empty");
  if (empty) empty.remove();
}

function appendResult(job, index, total) {
  clearResultsEmpty();
  const list = document.getElementById("results");
  const item = document.createElement("li");
  item.className = "result-item";
  const title = document.createElement("p");
  title.className = "result-meta";
  title.textContent = `${index}/${total} · 시드 ${job.seed}` + (job.output_path ? ` · ${job.output_path}` : "");
  item.appendChild(title);
  if (job.state === "done") {
    const video = document.createElement("video");
    video.controls = true;
    video.src = apiUrl(`/api/jobs/${job.id}/video?t=${Date.now()}`);
    item.appendChild(video);
  } else {
    const error = document.createElement("p");
    error.className = "result-error";
    error.textContent = job.error || "실패";
    item.appendChild(error);
  }
  list.prepend(item);
}

function waitForJob(jobId) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const job = await api(`/api/jobs/${jobId}`);
        if (job.state === "running") {
          setStatus(friendlyJobMessage(job), "busy");
          updateJobProgress(job);
          return;
        }
        updateJobProgress(job);
        clearInterval(timer);
        resolve(job);
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    };
    const timer = setInterval(tick, 700);
    tick();
  });
}

function buildForm(seedValue, useRandom) {
  const form = new FormData();
  form.append("mode", MODE);
  form.append("prompt", document.getElementById("i2v-prompt").value);
  form.append("negative_prompt", document.getElementById("negative-prompt").value);
  form.append("resolution", document.getElementById("resolution").value);
  const aspectField = document.getElementById("aspect-ratio-field");
  if (!aspectField.hidden) {
    form.append("aspect_ratio", document.getElementById("aspect-ratio").value);
  }
  form.append("duration_sec", document.getElementById("duration").value);
  form.append("random_seed", useRandom ? "true" : "false");
  form.append("seed", useRandom ? "" : String(seedValue));
  const imageInput = document.getElementById("i2v-image");
  if (imageInput.files[0]) {
    form.append("image", imageInput.files[0]);
  }
  return form;
}

function showTrainingBlockModal(message) {
  const text = message || "GPU가 학습에 활용 중이므로, 학습이 완료된 후에 생성을 해주시길 바랍니다.";
  document.getElementById("training-block-message").textContent = text;
  document.getElementById("training-block-backdrop").hidden = false;
  document.getElementById("training-block-modal").hidden = false;
}

function hideTrainingBlockModal() {
  document.getElementById("training-block-modal").hidden = true;
  document.getElementById("training-block-backdrop").hidden = true;
}

async function ensureCanGenerate() {
  const status = await api("/api/training-status");
  if (status.training_active) {
    showTrainingBlockModal(status.message);
    return false;
  }
  return true;
}

async function generate() {
  const button = document.getElementById("generate");
  if (!validateInput()) {
    return;
  }
  if (!(await ensureCanGenerate())) {
    return;
  }
  const repeat = Number(document.getElementById("repeat").value);
  const useRandom = document.getElementById("random-seed").checked;
  const startSeed = Number(document.getElementById("seed").value || 0);
  button.disabled = true;
  try {
    await saveSettings();
    for (let index = 0; index < repeat; index += 1) {
      clearJobProgress();
      setStatus(`${index + 1}/${repeat} 생성을 시작합니다…`, "busy");
      const seedValue = useRandom ? 0 : startSeed + index;
      const started = await api("/api/jobs", {
        method: "POST",
        body: buildForm(seedValue, useRandom),
      });
      const job = await waitForJob(started.id);
      appendResult(job, index + 1, repeat);
      if (job.state !== "done") {
        setStatus(`${index + 1}/${repeat} 실패`, "error");
      } else {
        setStatus(`${index + 1}/${repeat} 완료`, "success");
        maybeRefreshLibrary();
      }
    }
  } catch (err) {
    if (err.message.includes("GPU가 학습에 활용 중")) {
      showTrainingBlockModal(err.message);
    } else {
      setStatus(err.message, "error");
    }
  } finally {
    button.disabled = false;
  }
}

document.getElementById("tab-create").addEventListener("click", () => switchView("create"));
document.getElementById("tab-library").addEventListener("click", () => switchView("library"));
document.getElementById("refresh-library").addEventListener("click", () => {
  loadLibrary()
    .then(() => setStatus("저장 폴더를 새로고침했습니다.", "success"))
    .catch((err) => setStatus(err.message, "error"));
});
document.getElementById("clear-library-folder").addEventListener("click", () => {
  clearCurrentLibraryFolder().catch((err) => setStatus(err.message, "error"));
});
document.getElementById("library-select-all").addEventListener("change", (event) => {
  const checked = event.target.checked;
  setLibrarySelection(libraryCurrentItems.map((item) => item.name), checked);
  renderLibraryList(libraryCurrentItems, libraryBrowsePath);
});
document.getElementById("library-bulk-send").addEventListener("click", () => {
  const paths = getSelectedLibraryPaths();
  if (paths.length) {
    openSendToTaskModal(paths);
  }
});
document.getElementById("library-bulk-download").addEventListener("click", () => {
  bulkDownloadLibraryItems().catch((err) => setStatus(err.message, "error"));
});
document.getElementById("library-bulk-delete").addEventListener("click", () => {
  bulkDeleteLibraryItems().catch((err) => setStatus(err.message, "error"));
});
document.getElementById("settings-select-folder").addEventListener("click", () => {
  selectSettingsFolder().catch((err) => setStatus(err.message, "error"));
});
document.getElementById("settings-create-folder").addEventListener("click", () => {
  createSettingsFolder().catch((err) => setStatus(err.message, "error"));
});
document.getElementById("settings-new-folder-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    createSettingsFolder().catch((err) => setStatus(err.message, "error"));
  }
});
document.getElementById("toggle-settings").addEventListener("click", openSettings);
document.getElementById("toggle-advanced").addEventListener("click", openAdvanced);
document.getElementById("close-settings").addEventListener("click", closeSettings);
document.getElementById("close-advanced").addEventListener("click", closeSettings);
document.getElementById("drawer-backdrop").addEventListener("click", closeSettings);
document.getElementById("save-settings").addEventListener("click", () => {
  saveSettings().catch((err) => {
    setStatus(err.message, "error");
    window.alert(err.message);
  });
});
document.getElementById("training-block-ok").addEventListener("click", hideTrainingBlockModal);
document.getElementById("training-block-backdrop").addEventListener("click", hideTrainingBlockModal);
document.getElementById("send-to-task-cancel").addEventListener("click", closeSendToTaskModal);
document.getElementById("send-to-task-backdrop").addEventListener("click", closeSendToTaskModal);
document.getElementById("send-to-task-confirm").addEventListener("click", () => {
  submitSendToTask().catch((err) => setStatus(err.message, "error"));
});
document.querySelectorAll('input[name="send-target"], input[name="send-media-kind"]').forEach((input) => {
  input.addEventListener("change", updateSendToTaskModal);
});
document.getElementById("generate").addEventListener("click", generate);
document.getElementById("random-seed").addEventListener("change", syncSeedInput);
document.getElementById("i2v-image").addEventListener("change", previewSelectedImage);
document.getElementById("i2v-prompt").addEventListener("input", () => {
  if (document.getElementById("i2v-prompt").value.trim()) {
    setFieldError("field-prompt", "error-prompt", "");
  }
});
loadBootstrap().catch((err) => setStatus(err.message, "error"));