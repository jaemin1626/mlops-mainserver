(function () {
  if (window.__ivxDashboardLoaded) return;
  window.__ivxDashboardLoaded = true;

  var API_EX = '/api/v2.23/projects.get_all_ex';
  var API_BY_ID = '/api/v2.23/projects.get_by_id';
  var STORAGE_KEY = 'ivx-dataset-roots-v1';
  var projectById = Object.create(null);
  var projectByName = Object.create(null);
  var datasetRootByName = Object.create(null);
  var redirecting = false;
  var prefetchPromise = null;
  var prefetchFailed = false;

  function onProjectCardPage() {
    var path = location.pathname.replace(/\/$/, '') || '/';
    if (path === '/dashboard' || path === '/projects') return true;
    return /^\/projects\/[^/]+\/projects$/.test(path);
  }

  function datasetsUrl(projectId) {
    return '/datasets/simple/' + encodeURIComponent(projectId) + '/datasets';
  }

  function isProjectRoute(path) {
    return /^\/projects\/[^/]+(\/projects)?\/?$/.test(path || location.pathname);
  }

  function isDatasetsRoute(path) {
    return /^\/datasets\/simple\/[^/]+\/datasets/.test(path || location.pathname);
  }

  function datasetProjectIdFromPath(path) {
    var m = (path || location.pathname).match(/^\/datasets\/simple\/([^/]+)\/datasets/);
    return m ? m[1] : '';
  }

  function projectIdFromPath(path) {
    var m = (path || location.pathname).match(/^\/projects\/([^/]+)/);
    return m ? m[1] : '';
  }

  function normName(name) {
    return (name || '').trim();
  }

  function projectRefId(value) {
    if (typeof value === 'string') return value;
    return value && typeof value.id === 'string' ? value.id : '';
  }

  function escRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function rootNameFromDatasetPath(name) {
    var n = normName(name);
    var idx = n.indexOf('/.datasets');
    return idx > 0 ? n.substring(0, idx) : '';
  }

  function rootProjectIdFor(project) {
    if (!project || !project.id) return '';
    var name = normName(project.name || project.basename);
    var rootName = rootNameFromDatasetPath(name);
    if (rootName) {
      if (datasetRootByName[rootName]) return datasetRootByName[rootName];
      if (projectByName[rootName] && projectByName[rootName].id) {
        return projectByName[rootName].id;
      }
      if (projectRefId(project.parent)) return projectRefId(project.parent);
    }
    if (datasetRootByName[name]) return datasetRootByName[name];
    if (projectByName[name + '/.datasets']) {
      return project.id;
    }
    return project.id;
  }

  function loadStoredRoots() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var stored = JSON.parse(raw);
      if (stored && typeof stored === 'object') {
        Object.keys(stored).forEach(function (name) {
          var storedId = projectRefId(stored[name]);
          if (storedId) datasetRootByName[name] = storedId;
        });
      }
    } catch (err) {}
  }

  function saveStoredRoots() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(datasetRootByName));
    } catch (err) {}
  }

  function indexProjects(projects) {
    if (!projects || !projects.length) return;

    var changed = false;

    projects.forEach(function (p) {
      if (!p || !p.id) return;
      projectById[p.id] = p;
      if (p.name) projectByName[p.name] = p;
      if (p.basename) projectByName[p.basename] = p;

      var rootFromPath = rootNameFromDatasetPath(p.name);
      if (rootFromPath) {
        var rootId = projectRefId(p.path && p.path.length && p.path[0]) || projectRefId(p.parent);
        if (rootId && datasetRootByName[rootFromPath] !== rootId) {
          datasetRootByName[rootFromPath] = rootId;
          changed = true;
        }
      }

      (p.sub_projects || []).forEach(function (sub) {
        if (!sub || !sub.name) return;
        if (sub.name.indexOf('/.datasets') === -1 && sub.basename !== '.datasets') return;
        var root = rootNameFromDatasetPath(sub.name) || normName(p.name);
        if (root && datasetRootByName[root] !== p.id) {
          datasetRootByName[root] = p.id;
          changed = true;
        }
      });
    });

    Object.keys(projectById).forEach(function (id) {
      var p = projectById[id];
      if (!p.name || p.name.indexOf('/.datasets') === -1) return;
      var root = rootNameFromDatasetPath(p.name);
      var rootId = projectRefId(p.path && p.path[0]) || projectRefId(p.parent);
      if (root && rootId && datasetRootByName[root] !== rootId) {
        datasetRootByName[root] = rootId;
        changed = true;
      }
    });

    if (changed) saveStoredRoots();
    if (changed) prefetchFailed = false;
  }

  function ingestPayload(payload) {
    var projects = payload && payload.data && payload.data.projects;
    if (!projects && payload && payload.projects) projects = payload.projects;
    if (projects && projects.length) indexProjects(projects);

    var project = payload && payload.data && payload.data.project;
    if (!project && payload && payload.project) project = payload.project;
    if (project && project.id) indexProjects([project]);
  }

  function isProjectsApi(url) {
    return url.indexOf('projects.get_all_ex') !== -1 ||
      url.indexOf('projects.get_all') !== -1 ||
      url.indexOf('projects.get_by_id') !== -1;
  }

  function apiPost(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    }).then(function (payload) {
      ingestPayload(payload);
      return payload;
    });
  }

  function resetPrefetch() {
    prefetchPromise = null;
    prefetchFailed = false;
  }

  function prefetchDatasetRoots() {
    if (prefetchPromise && !prefetchFailed) return prefetchPromise;

    prefetchPromise = Promise.all([
      apiPost(API_EX, {
        page: 0,
        page_size: 500,
        search_hidden: true,
        shallow_search: false,
        system_tags: ['dataset'],
        name: '/\\.datasets/',
        include_stats: true,
        check_own_contents: true,
        stats_for_state: 'active'
      }).catch(function () { prefetchFailed = true; }),
      apiPost(API_EX, {
        page: 0,
        page_size: 500,
        search_hidden: true,
        include_stats: true,
        check_own_contents: true,
        stats_for_state: 'active',
        order_by: ['featured', '-last_update']
      }).catch(function () { prefetchFailed = true; })
    ]).then(function () {
      if (Object.keys(datasetRootByName).length) prefetchFailed = false;
    });

    return prefetchPromise;
  }

  function waitForHookData(maxMs) {
    return new Promise(function (resolve) {
      if (Object.keys(datasetRootByName).length) {
        resolve();
        return;
      }
      var tries = 0;
      var limit = Math.max(1, Math.floor((maxMs || 5000) / 50));
      var timer = setInterval(function () {
        if (Object.keys(datasetRootByName).length || ++tries >= limit) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }

  function ensureIndexed() {
    if (Object.keys(datasetRootByName).length) {
      return Promise.resolve();
    }
    return prefetchDatasetRoots().then(function () {
      return waitForHookData(5000);
    });
  }

  function fetchProjectByName(name) {
    var n = normName(name);
    if (!n) return Promise.resolve(null);
    if (projectByName[n]) return Promise.resolve(projectByName[n]);

    return apiPost(API_EX, {
      page: 0,
      page_size: 10,
      search_hidden: true,
      shallow_search: false,
      include_stats: true,
      check_own_contents: true,
      stats_for_state: 'active',
      name: '^' + escRegex(n) + '$'
    }).then(function () {
      return projectByName[n] || null;
    }).catch(function () {
      return null;
    });
  }

  function fetchProjectById(id) {
    if (!id) return Promise.resolve(null);
    if (projectById[id]) return Promise.resolve(projectById[id]);

    return apiPost(API_BY_ID, {
      project: id,
      include_stats: true,
      check_own_contents: true,
      stats_for_state: 'active',
      search_hidden: true
    }).then(function () {
      return projectById[id] || null;
    }).catch(function () {
      return null;
    });
  }

  function hasDatasetChild(name, project) {
    var n = normName(name);
    if (n && datasetRootByName[n]) return true;
    if (n && projectByName[n + '/.datasets']) return true;
    if (!project) return false;
    return (project.sub_projects || []).some(function (sub) {
      return sub.name && (sub.name.indexOf('/.datasets') !== -1 || sub.basename === '.datasets');
    });
  }

  function taskCount(project) {
    if (!project) return null;
    if (project.stats && project.stats.active && project.stats.active.total_tasks != null) {
      return project.stats.active.total_tasks;
    }
    if (project.own_tasks != null) return project.own_tasks;
    return null;
  }

  function hasNoTasks(project) {
    var n = taskCount(project);
    return n === null || n === 0;
  }

  function isDatasetRootProject(project) {
    if (!project || !project.id) return false;
    var name = normName(project.name || project.basename);
    if (datasetRootByName[name]) return true;
    if (projectByName[name + '/.datasets']) return true;
    if (!hasNoTasks(project)) return false;
    return hasDatasetChild(name, project);
  }

  function resolveDatasetId(name, id) {
    var n = normName(name);
    if (n && datasetRootByName[n]) return projectRefId(datasetRootByName[n]);

    if (id && projectById[id]) {
      var byId = projectById[id];
      var rootFromId = rootProjectIdFor(byId);
      if (rootFromId && rootFromId !== id && rootNameFromDatasetPath(byId.name)) {
        return rootFromId;
      }
      if (isDatasetRootProject(byId)) return rootFromId || id;
    }

    if (n) {
      if (projectByName[n + '/.datasets']) {
        var child = projectByName[n + '/.datasets'];
        return projectRefId(child.path && child.path[0]) || projectRefId(datasetRootByName[n]);
      }

      var exact = projectByName[n];
      if (exact && isDatasetRootProject(exact)) return exact.id;

      var prefix = n + '/.datasets';
      var keys = Object.keys(projectByName);
      for (var i = 0; i < keys.length; i++) {
        var pn = keys[i];
        if (pn === prefix || pn.indexOf(prefix + '/') === 0) {
          var c = projectByName[pn];
          var rootId = projectRefId(c.path && c.path[0]) || projectRefId(datasetRootByName[n]);
          if (rootId) return rootId;
        }
      }
    }

    return '';
  }

  function fetchDatasetRootId(name, id) {
    var cached = resolveDatasetId(name, id);
    if (cached) return Promise.resolve(cached);

    return ensureIndexed().then(function () {
      var resolved = resolveDatasetId(name, id);
      if (resolved) return resolved;

      if (id) {
        return fetchProjectById(id).then(function (project) {
          if (project && isDatasetRootProject(project)) return project.id;
          return resolveDatasetId(name, id);
        });
      }

      return fetchProjectByName(name).then(function (project) {
        if (project && isDatasetRootProject(project)) return project.id;
        return resolveDatasetId(name, id);
      });
    });
  }

  function hookXHR() {
    if (window.__ivxXHRHooked) return;
    window.__ivxXHRHooked = true;
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ivxUrl = url || '';
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      xhr.addEventListener('load', function () {
        if (!isProjectsApi(xhr.__ivxUrl || '')) return;
        if (xhr.status < 200 || xhr.status >= 300) return;
        try { ingestPayload(JSON.parse(xhr.responseText)); } catch (err) {}
      });
      return send.apply(this, arguments);
    };
  }

  function hookFetch() {
    if (window.__ivxFetchHooked) return;
    window.__ivxFetchHooked = true;
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var track = isProjectsApi(url);
      return nativeFetch(input, init).then(function (res) {
        if (track && res.ok) {
          res.clone().json().then(ingestPayload).catch(function () {});
        }
        return res;
      });
    };
  }

  function goDatasets(projectId) {
    if (!projectId) return;
    var url = datasetsUrl(projectId);
    if (location.pathname === url) return;
    redirecting = true;
    window.location.assign(url);
  }

  function goProjects(projectId) {
    if (!projectId) return;
    window.location.assign('/projects/' + encodeURIComponent(projectId));
  }

  function guardDatasetViewRoute() {
    if (redirecting) return;

    var id = '';
    var datasetName = null;
    var targetUrl = '';

    if (/^\/datasets\/?$/.test(location.pathname) || /^\/datasets\/simple\/(?:\*|%2a)\/projects\/?$/i.test(location.pathname)) {
      datasetName = 'Dataset';
    } else if (isProjectRoute()) {
      id = projectIdFromPath();
    } else if (isDatasetsRoute()) {
      id = datasetProjectIdFromPath();
    } else {
      return;
    }

    if (!id && !datasetName) return;

    fetchDatasetRootId(datasetName, id).then(function (resolved) {
      if (!resolved) return;
      targetUrl = datasetsUrl(resolved);
      if (location.pathname !== targetUrl) {
        redirecting = true;
        window.location.replace(targetUrl);
      }
    });
  }

  function patchHistoryMethod(method) {
    var original = history[method].bind(history);
    history[method] = function (state, title, url) {
      original(state, title, url);
      guardDatasetViewRoute();
    };
  }

  function patchLocationMethod(method) {
    var proto = window.Location && window.Location.prototype;
    if (!proto || proto['__ivx' + method + 'Patched']) return;
    proto['__ivx' + method + 'Patched'] = true;
    var original = proto[method];
    proto[method] = function (url) {
      var path = String(url || '');
      if (path.charAt(0) === '/') {
        if (isProjectRoute(path)) {
          var id = projectIdFromPath(path);
          var immediate = resolveDatasetId(null, id);
          if (immediate) {
            redirecting = true;
            return original.call(this, datasetsUrl(immediate));
          }
          fetchDatasetRootId(null, id).then(function (resolved) {
            if (resolved) goDatasets(resolved);
            else original.call(location, url);
          });
          return;
        }
      }
      return original.call(this, url);
    };
  }

  function shouldIgnoreClick(target) {
    return !!target.closest(
      'button, a, input, textarea, sm-menu, mat-menu, .mat-mdc-menu-panel, [smClickStopPropagation], .sub-projects-list a'
    );
  }

  function findProjectCard(target) {
    var cardBody = target.closest('.project-card');
    if (cardBody) return cardBody.closest('sm-project-card, sm-nested-card') || cardBody;
    return target.closest('sm-project-card, sm-nested-card');
  }

  function getProjectNameFromCard(card) {
    var nameEl = card.querySelector('.project-name');
    if (nameEl) {
      var tip = nameEl.getAttribute('ng-reflect-sm-tooltip') || nameEl.getAttribute('mattooltip') || '';
      if (tip) return normName(tip);
      var text = normName(nameEl.textContent || '');
      if (text) return text;
    }
    var tipped = card.querySelector('[ng-reflect-sm-tooltip]');
    if (tipped) {
      var t = tipped.getAttribute('ng-reflect-sm-tooltip');
      if (t) return normName(t);
    }
    return '';
  }

  function getProjectIdFromCard(card) {
    var host = card.closest('sm-project-card, sm-nested-card') || card;
    var reflected = host.getAttribute('ng-reflect-project');
    if (reflected) {
      try {
        var parsed = JSON.parse(reflected);
        if (parsed && parsed.id) return parsed.id;
      } catch (err) {
        var match = reflected.match(/"id"\s*:\s*"([^"]+)"/);
        if (match) return match[1];
      }
    }
    return '';
  }

  function cardMayBeDatasetRoot(card, name) {
    if (name && (datasetRootByName[name] || projectByName[name + '/.datasets'])) return true;
    if (card.querySelector('.sub-projects-list')) return true;
    var counters = card.querySelectorAll('sm-circle-counter');
    for (var i = 0; i < counters.length; i++) {
      var label = (
        counters[i].getAttribute('ng-reflect-label') ||
        counters[i].getAttribute('label') ||
        counters[i].textContent ||
        ''
      ).toUpperCase();
      if (label.indexOf('DATASET') !== -1) return true;
    }
    return false;
  }

  /* Dashboard: Detector / VLM 카드를 누르면 프로젝트 Overview 가 아니라 진행 중인 Task 로 이동한다.
     진행 중인 Task 가 없으면 가장 최근 Task, Task 가 아예 없으면 기존처럼 프로젝트 화면으로 간다. */
  var TASKS_EX = '/api/v2.23/tasks.get_all_ex';
  var TASK_PROJECTS = { detector: true, vlm: true };

  function onDashboardPage() {
    return (location.pathname.replace(/\/$/, '') || '/') === '/dashboard';
  }

  function apiRaw(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    });
  }

  function findTaskForProject(projectId, statuses) {
    var body = {
      project: [projectId],
      include_subprojects: true,
      order_by: ['-last_update'],
      page: 0,
      page_size: 1,
      only_fields: ['id', 'name', 'status', 'project']
    };
    if (statuses) body.status = statuses;
    return apiRaw(TASKS_EX, body).catch(function () {
      delete body.include_subprojects;   // 서버가 이 옵션을 모르면 하위 프로젝트 없이 다시 조회
      return apiRaw(TASKS_EX, body);
    }).then(function (payload) {
      var tasks = payload && payload.data && payload.data.tasks;
      return tasks && tasks.length ? tasks[0] : null;
    });
  }

  function goToTask(task, fallbackProjectId) {
    var projectId = projectRefId(task.project) || fallbackProjectId;
    window.location.assign('/projects/' + encodeURIComponent(projectId) + '/tasks/' + encodeURIComponent(task.id));
  }

  function handleProjectCardClick(e) {
    if (!onProjectCardPage()) return;
    if (shouldIgnoreClick(e.target)) return;

    var card = findProjectCard(e.target);
    if (!card) return;

    var name = getProjectNameFromCard(card);
    var id = getProjectIdFromCard(card);
    if (!name && !id) return;

    if (onDashboardPage() && TASK_PROJECTS[normName(name).toLowerCase()]) {
      var taskProjectId = id || (projectByName[normName(name)] || {}).id;
      if (taskProjectId) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        findTaskForProject(taskProjectId, ['in_progress'])
          .then(function (task) { return task || findTaskForProject(taskProjectId); })
          .then(function (task) {
            if (task) goToTask(task, taskProjectId);
            else goProjects(taskProjectId);
          })
          .catch(function () { goProjects(taskProjectId); });
        return;
      }
    }

    var immediate = resolveDatasetId(name, id);
    if (immediate) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      goDatasets(immediate);
      return;
    }

    if (!cardMayBeDatasetRoot(card, name)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    fetchDatasetRootId(name, id).then(function (resolved) {
      if (resolved) goDatasets(resolved);
      else if (id) goProjects(id);
    });
  }

  loadStoredRoots();
  hookFetch();
  hookXHR();
  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');
  patchLocationMethod('assign');
  patchLocationMethod('replace');
  window.addEventListener('popstate', guardDatasetViewRoute);
  document.addEventListener('click', handleProjectCardClick, true);

  prefetchDatasetRoots();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', guardDatasetViewRoute);
  } else {
    guardDatasetViewRoute();
  }

  var lastPath = location.pathname;
  setInterval(function () {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      redirecting = false;
      guardDatasetViewRoute();
    }
  }, 250);
})();

/* Training server monitor: attach after Angular creates the dashboard. */
(function () {
  if (window.__ivxTrainingMonitor) return;
  window.__ivxTrainingMonitor = true;
  var panel, banner, timer, controller, generation = 0;
  var style = document.createElement('style');
  style.textContent = `
    body.ivx-monitor-active {padding-top:80px!important;box-sizing:border-box}
    body.ivx-monitor-active sm-root {height:calc(100vh - 80px)!important}
    #ivx-training-banner {position:fixed;inset:0 0 auto;height:80px;box-sizing:border-box;background:#181c24;color:#fff;padding:16px;z-index:1000;font:14px Heebo,sans-serif}
    #ivx-training-banner strong {font-size:14px} #ivx-training-status {float:right;font-size:12px;color:#8ee0b1}
    #ivx-training-detail {font-size:12px;margin-top:12px;color:#dce3ee}
    body.ivx-monitor-active sm-dashboard-reports {display:none!important}
    body.ivx-monitor-active sm-dashboard-experiments {height:auto!important;min-height:310px;padding-top:12px!important}
    body.ivx-monitor-active sm-dashboard-experiments [header-buttons] {display:none!important}
    body.ivx-monitor-active sm-show-only-user-work-menu.ivx-team-work-label {display:inline-flex;align-items:center;pointer-events:none;cursor:default}
    body.ivx-monitor-active sm-show-only-user-work-menu.ivx-team-work-label > sm-menu {display:none!important}
    .ivx-team-work-static {display:inline-flex;align-items:center;gap:7px;color:var(--color-on-surface);font:500 13px Heebo,sans-serif;white-space:nowrap}
    .ivx-team-work-static i {font-size:15px;color:var(--color-primary)}
    #ivx-training-server-panel {box-sizing:border-box;margin:18px auto 0;color:var(--color-on-surface,#172033);font-family:Heebo,sans-serif}
    #ivx-training-server-panel h2 {font:500 16px Heebo,sans-serif;color:var(--color-primary);margin:0 0 16px;line-height:24px}
    .ivx-metric-grid {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
    .ivx-metric-card {padding:20px 24px 18px;border:1px solid color-mix(in srgb,var(--color-on-surface) 10%,transparent);border-radius:14px;background:color-mix(in srgb,var(--color-primary) 3%,var(--color-surface));box-shadow:0 3px 12px rgba(0,0,0,.025)}
    .ivx-metric-label {font:500 16px Heebo,sans-serif;color:var(--color-primary);margin-bottom:14px;line-height:24px}
    .ivx-gauge {position:relative;width:160px;height:160px;margin:0 auto}
    .ivx-gauge svg {width:100%;height:100%;transform:rotate(-90deg)}
    .ivx-gauge circle {fill:none;stroke-width:9}
    .ivx-gauge circle:first-of-type {stroke:color-mix(in srgb,var(--color-primary) 12%,var(--color-surface))}
    .ivx-progress {transition:stroke-dasharray .65s ease,opacity .3s ease}
    @media(prefers-reduced-motion:reduce){.ivx-progress{transition:none}}
    .ivx-gauge-value {position:absolute;inset:0;display:grid;place-items:center;font-size:34px;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:-1px}
    .ivx-metric-total {text-align:center;margin-top:14px;font-size:13px;min-height:20px;color:var(--color-on-surface-variant);font-variant-numeric:tabular-nums}
    .ivx-gpu-gauges {display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:12px;align-items:start}
    .ivx-gpu-unit {min-width:0;text-align:center}.ivx-gpu-unit .ivx-gauge{width:122px;height:122px}
    .ivx-gpu-name {font-size:13px;font-weight:600;margin-bottom:7px}.ivx-gpu-detail {font-size:11px;color:var(--color-on-surface-variant);margin-top:7px;white-space:nowrap}
    .ivx-gpu-empty {height:160px;display:grid;place-items:center;color:var(--color-on-surface-variant)}
    @media(max-width:650px){.ivx-metric-grid{grid-template-columns:1fr}.ivx-gauge{width:130px;height:130px}#ivx-training-status{float:none;display:block;margin-top:5px}#ivx-training-banner{padding:10px}#ivx-training-detail{margin-top:5px}}
  `;
  document.head.appendChild(style);
  function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
  function gauge(id, label) {
    return '<div class="ivx-gauge" role="img" aria-label="'+label+'"><svg viewBox="0 0 120 120" aria-hidden="true"><defs><linearGradient id="ivx-gradient-'+id+'"><stop stop-color="#2166a2"/><stop offset="1" stop-color="#52bbef"/></linearGradient></defs><circle cx="60" cy="60" r="50" stroke="#d3e3fa"/><circle class="ivx-progress" cx="60" cy="60" r="50" stroke="url(#ivx-gradient-'+id+')" stroke-linecap="round" stroke-dasharray="0 314.159"/></svg><span class="ivx-gauge-value">—</span></div>';
  }
  function card(label, id) {
    return '<div class="ivx-metric-card" data-metric="'+id+'"><div class="ivx-metric-label">'+label+'</div>'+gauge(id,label)+'<div class="ivx-metric-total">Total: —</div></div>';
  }
  function gpuCard() {
    return '<div class="ivx-metric-card ivx-gpu-card" data-metric="gpu"><div class="ivx-metric-label">GPU usage</div><div class="ivx-gpu-gauges"><div class="ivx-gpu-empty">GPU 상태 대기 중</div></div><div class="ivx-metric-total">Total: —</div></div>';
  }
  function gpuUnit(g, i) {
    var index=number(g.index);if(index===null)index=i;
    return '<div class="ivx-gpu-unit" data-gpu="'+index+'"><div class="ivx-gpu-name">GPU '+index+'</div>'+gauge('gpu-'+index,'GPU '+index+' usage')+'<div class="ivx-gpu-detail"></div></div>';
  }
  function updateGauge(el, value, aria) {
    var pct=value===null?null:Math.max(0,Math.min(100,value)),label=pct===null?'—':Math.round(pct)+'%';
    el.querySelector('.ivx-gauge-value').textContent=label;
    el.querySelector('.ivx-progress').style.opacity=pct>0?'1':'0';
    el.querySelector('.ivx-progress').setAttribute('stroke-dasharray',(pct===null?0:pct*3.14159)+' 314.159');
    el.querySelector('.ivx-gauge').setAttribute('aria-label',aria+': '+(pct===null?'unavailable':label));
  }
  function render(data) {
    if (!panel || !panel.isConnected) return;
    var timestamp = number(data.updated_at) || number(data.timestamp);
    var stale = !timestamp || Date.now()/1000 - timestamp > 20;
    var live = data.ok === true && !stale;
    banner.querySelector('#ivx-training-host').textContent = 'TRAINING SERVER' + (data.host ? ' · ' + data.host : '');
    var status = banner.querySelector('#ivx-training-status');
    status.textContent = live ? 'LIVE · 5초마다 갱신' : (data.ok === false ? '연결 실패' : '데이터 지연');
    status.style.color = live ? '#8ee0b1' : '#ff9b9b';
    banner.querySelector('#ivx-training-detail').textContent = data.error || (timestamp ? '마지막 수집: '+new Date(timestamp*1000).toLocaleString() : '학습 서버 응답 대기 중');
    var memory = data.memory || {}, gpus = Array.isArray(data.gpus) ? data.gpus : [];
    var gpuCardEl=panel.querySelector('[data-metric="gpu"]'),gpuList=gpuCardEl.querySelector('.ivx-gpu-gauges');
    var signature=gpus.map(function(g,i){return number(g.index)===null?i:g.index}).join(',');
    if(gpuList.dataset.signature!==signature){
      gpuList.innerHTML=gpus.length?gpus.map(gpuUnit).join(''):'<div class="ivx-gpu-empty">GPU 정보를 사용할 수 없습니다.</div>';
      gpuList.dataset.signature=signature;
    }
    gpus.forEach(function(g,i){
      var index=number(g.index);if(index===null)index=i;
      var unit=gpuList.querySelector('[data-gpu="'+index+'"]'),usage=live?number(g.utilization_percent):null;
      if(!unit)return;updateGauge(unit,usage,'GPU '+index+' usage');
      var used=number(g.memory_used_mb),total=number(g.memory_total_mb),temp=number(g.temperature_c);
      unit.querySelector('.ivx-gpu-detail').textContent=(used===null||total===null?'VRAM —':Math.round(used)+' / '+Math.round(total)+' MB')+(temp===null?'':' · '+Math.round(temp)+'°C');
    });
    gpuCardEl.querySelector('.ivx-metric-total').textContent='Total: '+(data.ok===true&&!data.gpu_error?gpus.length+' GPUs':'—');
    var cpu=live?number(data.cpu_percent):null;
    var mem=live&&number(memory.total_bytes)>0&&number(memory.used_bytes)!==null?memory.used_bytes/memory.total_bytes*100:null;
    var cores=number(data.cpu_count)||number(data.cpu_cores),cpuEl=panel.querySelector('[data-metric="cpu"]'),memEl=panel.querySelector('[data-metric="memory"]');
    updateGauge(cpuEl,cpu,'CPU usage');updateGauge(memEl,mem,'Memory usage');
    cpuEl.querySelector('.ivx-metric-total').textContent='Total: '+(cores?cores+' Cores':'—');
    memEl.querySelector('.ivx-metric-total').textContent='Total: '+(number(memory.total_bytes)>0?Math.round(memory.total_bytes/1073741824)+' GB RAM':'—');
  }
  async function poll() {
    if (!panel || !panel.isConnected || controller) return;
    var run = generation;
    controller = new AbortController();
    var timeout = setTimeout(function(){if(controller) controller.abort()},4500);
    try {
      var response = await fetch('/training-metrics.json?t='+Date.now(), {cache:'no-store',credentials:'same-origin',signal:controller.signal});
      if (!response.ok) throw new Error('HTTP '+response.status);
      var data = await response.json();
      if (run === generation) render(data || {});
    } catch(error) {
      if (run === generation) render({ok:false,error:'지표를 불러오지 못했습니다: '+error.message});
    } finally {clearTimeout(timeout);controller=null;}
  }
  function normalizeTeamWork() {
    var host=document.querySelector('sm-show-only-user-work-menu');
    if(!host)return;
    host.classList.add('ivx-team-work-label');
    if(!host.querySelector('.ivx-team-work-static')){
      var label=document.createElement('span');label.className='ivx-team-work-static';label.setAttribute('aria-label',"Team's Work");label.innerHTML='<i class="al-ico-users" aria-hidden="true"></i><span>Team&amp;#39;s Work</span>';
      label.lastElementChild.textContent="Team's Work";host.appendChild(label);
    }
  }
  function sync() {
    normalizeTeamWork();
    var dashboard = /^\/dashboard\/?$/.test(location.pathname) && document.querySelector('sm-dashboard');
    var projects = dashboard && dashboard.querySelector('sm-dashboard-projects');
    var tasks = dashboard && dashboard.querySelector('sm-dashboard-experiments');
    if (!projects || !tasks) {
      if (panel) {generation++;clearInterval(timer);timer=null;panel.remove();banner.remove();panel=banner=null;document.body.classList.remove('ivx-monitor-active');if(controller)controller.abort();}
      return;
    }
    if (!panel || !panel.isConnected) {
      if (banner) banner.remove();
      panel=document.createElement('section');panel.id='ivx-training-server-panel';
      panel.innerHTML='<h2>TRAINING SERVER METRICS</h2><div class="ivx-metric-grid">'+gpuCard()+card('CPU usage','cpu')+card('Memory usage','memory')+'</div>';
      tasks.parentNode.insertBefore(panel,tasks);
      banner=document.createElement('header');banner.id='ivx-training-banner';
      banner.innerHTML='<strong id="ivx-training-host">TRAINING SERVER</strong><span id="ivx-training-status">연결 확인 중</span><div id="ivx-training-detail">학습 서버 응답 대기 중</div>';
      document.body.prepend(banner);document.body.classList.add('ivx-monitor-active');
      clearInterval(timer);poll();timer=setInterval(poll,5000);
    }
    var title=tasks.querySelector('.recent-title');
    if(title){
      var typography=getComputedStyle(title);
      panel.querySelectorAll('h2,.ivx-metric-label').forEach(function(el){
        if(el.style.font!==typography.font)el.style.font=typography.font;
        if(el.style.color!==typography.color)el.style.color=typography.color;
      });
    }
    var width=tasks.getBoundingClientRect().width;
    if(width && panel.style.width!==width+'px')panel.style.width=width+'px';
  }
  function boot(){new MutationObserver(sync).observe(document.body,{childList:true,subtree:true});window.addEventListener('resize',sync);window.addEventListener('popstate',sync);setInterval(sync,500);sync();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
