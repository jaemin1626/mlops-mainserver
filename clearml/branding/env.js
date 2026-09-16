(function (window) {
  window.__env = window.__env || {};
  window.__env.subPath = '';

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
    var script = document.createElement('script');
    script.id = 'ivx-sidebar-js';
    script.src = '/ivx-sidebar.js?v=train-7';
    script.defer = true;
    head.appendChild(script);
  }
}(this));
