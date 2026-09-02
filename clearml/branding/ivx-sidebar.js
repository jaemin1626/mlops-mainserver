(function () {
  var DATA_STUDIO_URL = '/data-studio/';

  function wireDataStudioRocket(link) {
    if (link.dataset.ivxDataStudio) return;
    link.dataset.ivxDataStudio = '1';
    link.setAttribute('title', 'Data Studio');
    link.setAttribute('aria-label', 'Data Studio');
    link.setAttribute('ng-reflect-sm-tooltip', 'Data Studio');
    link.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      window.open(DATA_STUDIO_URL, '_blank', 'noopener,noreferrer');
    }, true);
  }

  function applySidebarCustomizations(root) {
    root.querySelectorAll('sm-side-nav .al-ico-enterprise-rocket').forEach(wireDataStudioRocket);
  }

  function start() {
    applySidebarCustomizations(document);
    var observer = new MutationObserver(function () {
      applySidebarCustomizations(document);
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
