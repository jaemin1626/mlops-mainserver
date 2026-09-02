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

  function projectIdFromPath(path) {
    var m = (path || location.pathname).match(/^\/projects\/([^/]+)/);
    return m ? m[1] : '';
  }

  function normName(name) {
    return (name || '').trim();
  }

  function escRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function rootNameFromDatasetPath(name) {
    var n = normName(name);
    var idx = n.indexOf('/.datasets');
    return idx > 0 ? n.substring(0, idx) : '';
  }

  function loadStoredRoots() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var stored = JSON.parse(raw);
      if (stored && typeof stored === 'object') {
        Object.keys(stored).forEach(function (name) {
          if (stored[name]) datasetRootByName[name] = stored[name];
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
        var rootId = (p.path && p.path.length && p.path[0]) || p.parent || '';
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
      var rootId = (p.path && p.path[0]) || '';
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
    if (n && datasetRootByName[n]) return datasetRootByName[n];

    if (id && projectById[id] && isDatasetRootProject(projectById[id])) return id;

    if (n) {
      if (projectByName[n + '/.datasets']) {
        var child = projectByName[n + '/.datasets'];
        return (child.path && child.path[0]) || datasetRootByName[n] || '';
      }

      var exact = projectByName[n];
      if (exact && isDatasetRootProject(exact)) return exact.id;

      var prefix = n + '/.datasets';
      var keys = Object.keys(projectByName);
      for (var i = 0; i < keys.length; i++) {
        var pn = keys[i];
        if (pn === prefix || pn.indexOf(prefix + '/') === 0) {
          var c = projectByName[pn];
          var rootId = (c.path && c.path[0]) || datasetRootByName[n] || '';
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

  function guardProjectRoute() {
    if (redirecting || !isProjectRoute()) return;

    var id = projectIdFromPath();
    if (!id) return;

    fetchDatasetRootId(null, id).then(function (resolved) {
      if (!resolved) return;
      var url = datasetsUrl(resolved);
      if (location.pathname !== url) {
        redirecting = true;
        window.location.replace(url);
      }
    });
  }

  function patchHistoryMethod(method) {
    var original = history[method].bind(history);
    history[method] = function (state, title, url) {
      original(state, title, url);
      guardProjectRoute();
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

  function handleProjectCardClick(e) {
    if (!onProjectCardPage()) return;
    if (shouldIgnoreClick(e.target)) return;

    var card = findProjectCard(e.target);
    if (!card) return;

    var name = getProjectNameFromCard(card);
    var id = getProjectIdFromCard(card);
    if (!name && !id) return;

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
  window.addEventListener('popstate', guardProjectRoute);
  document.addEventListener('click', handleProjectCardClick, true);

  prefetchDatasetRoots();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', guardProjectRoute);
  } else {
    guardProjectRoute();
  }

  var lastPath = location.pathname;
  setInterval(function () {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      redirecting = false;
      guardProjectRoute();
    }
  }, 250);
})();
