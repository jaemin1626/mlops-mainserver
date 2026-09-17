(function (window) {
  window.__env = window.__env || {};
  window.__env.subPath = '';
  if (!['/access-login.html','/change-password.html'].includes(location.pathname)) {
    fetch('/access-api/auth/me', {credentials:'same-origin', cache:'no-store'}).then(function(r){
      if (r.status === 401) return location.replace('/access-login.html?next=' + encodeURIComponent(location.pathname + location.search));
      if (r.ok && location.pathname === '/login') return fetch('/access-api/auth/logout',{method:'POST',credentials:'same-origin'}).finally(function(){location.replace('/access-login.html?next=%2Fdashboard');});
    }).catch(function(){});
  }

  // ClearML can navigate to /login inside the SPA without reloading env.js.
  // Guard that route as well, so the stock ClearML login form is never exposed.
  var integratedLogoutRedirecting = false;
  function redirectStockLogin() {
    if (location.pathname !== '/login' || integratedLogoutRedirecting) return;
    integratedLogoutRedirecting = true;
    fetch('/api/v2.23/auth.logout', {method:'POST', credentials:'same-origin'}).catch(function(){})
      .then(function(){ return fetch('/access-api/auth/logout', {method:'POST', credentials:'same-origin'}); })
      .catch(function(){})
      .finally(function(){ location.replace('/access-login.html?next=%2Fdashboard'); });
  }
  window.addEventListener('popstate', redirectStockLogin);
  window.addEventListener('hashchange', redirectStockLogin);
  setInterval(redirectStockLogin, 200);
  redirectStockLogin();

  // One logout action must close both the ClearML and DB-backed sessions.
  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-id="Logout"]') : null;
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    fetch('/api/v2.23/auth.logout', {method:'POST', credentials:'same-origin'}).catch(function(){})
      .then(function(){ return fetch('/access-api/auth/logout', {method:'POST', credentials:'same-origin'}); })
      .catch(function(){})
      .finally(function(){ location.replace('/access-login.html?next=%2Fdashboard'); });
  }, true);

  // Dataset Archive deletion keeps the native UI, but checks the complete
  // parent/child graph before the native request is sent.
  (function installDatasetCascadeConfirmation() {
    var deleteUrl = /\/api\/v[0-9.]+\/tasks\.(?:delete|delete_many)(?:\?|$)/;
    var nativeFetch = window.fetch.bind(window);

    function label(item) {
      return (item.dataset_name || 'Dataset') + (item.version ? ' ' + item.version : '');
    }

    function confirmationMessage(plan) {
      var descendants = (plan.descendants || []).map(label).join(', ');
      var order = (plan.delete_order || []).map(label).join(' → ');
      return [
        '선택한 Dataset에 연결된 하위 Dataset이 있습니다.',
        '하위 Dataset까지 함께 삭제됩니다.',
        '',
        '하위 Dataset: ' + descendants,
        '삭제 순서: ' + order,
        '',
        '계속 삭제하시겠습니까?'
      ].join('\n');
    }

    function plan(url, body) {
      return nativeFetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {'Content-Type':'application/json', 'X-IVX-Delete-Plan':'1'},
        body: body
      }).then(function(response) {
        if (!response.ok) throw new Error('Dataset 관계 확인 실패');
        return response.json();
      }).then(function(result) { return result.data || {}; });
    }

    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__ivxMethod = String(method || 'GET').toUpperCase();
      this.__ivxUrl = String(url || '');
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      var xhr = this;
      if (xhr.__ivxMethod !== 'POST' || !deleteUrl.test(xhr.__ivxUrl) || typeof body !== 'string') {
        return originalSend.call(xhr, body);
      }
      plan(xhr.__ivxUrl, body).then(function(result) {
        if (result.requires_confirmation && !window.confirm(confirmationMessage(result))) {
          xhr.abort();
          return;
        }
        if (result.requires_confirmation) xhr.setRequestHeader('X-IVX-Dataset-Cascade', 'confirmed');
        originalSend.call(xhr, body);
      }).catch(function() {
        // The server still blocks an unconfirmed parent deletion if planning fails.
        originalSend.call(xhr, body);
      });
    };

    window.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : input && input.url || '';
      var method = String(init && init.method || input && input.method || 'GET').toUpperCase();
      var headers = new Headers(init && init.headers || input && input.headers || {});
      if (method !== 'POST' || !deleteUrl.test(url) || headers.has('X-IVX-Delete-Plan') || headers.has('X-IVX-Dataset-Cascade')) {
        return nativeFetch(input, init);
      }
      var bodyPromise = init && typeof init.body === 'string'
        ? Promise.resolve(init.body)
        : input instanceof Request ? input.clone().text() : Promise.resolve('');
      return bodyPromise.then(function(body) {
        if (!body) return nativeFetch(input, init);
        return plan(url, body).then(function(result) {
          if (result.requires_confirmation && !window.confirm(confirmationMessage(result))) {
            throw new DOMException('Dataset 삭제가 취소되었습니다.', 'AbortError');
          }
          if (!result.requires_confirmation) return nativeFetch(input, init);
          headers.set('X-IVX-Dataset-Cascade', 'confirmed');
          return nativeFetch(input, Object.assign({}, init || {}, {headers:headers}));
        });
      });
    };
  }());

  // Dashboard → DATASETS routing must run before Angular bootstraps.
  // Cached stock index.html may not include ivx-dashboard.js; env.js is no-store.
  if (!document.getElementById('ivx-dashboard-js')) {
    document.write('<script id="ivx-dashboard-js" src="/ivx-dashboard.js?v=13"><\/script>');
  }

  var head = document.head || document.getElementsByTagName('head')[0];
  if (head && !document.getElementById('ivx-clearml-sidebar-style')) {
    var link = document.createElement('link');
    link.id = 'ivx-clearml-sidebar-style';
    link.rel = 'stylesheet';
    link.href = '/ivx-sidebar.css';
    head.appendChild(link);
  }
  if (head && !document.getElementById('ivx-sidebar-js')) {
    var adminScript = document.createElement('script');
    adminScript.src = '/ivx-admin-app.js?v=groups-2';
    adminScript.onload = function () {
      var script = document.createElement('script');
      script.id = 'ivx-sidebar-js';
      script.src = '/ivx-sidebar.js?v=train-perm-1';
      head.appendChild(script);
    };
    head.appendChild(adminScript);
  }
}(this));
