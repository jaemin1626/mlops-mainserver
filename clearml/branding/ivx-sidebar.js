(function () {
  if (window.__ivxSidebarLoaded) return;
  window.__ivxSidebarLoaded = true;
  var DATA_STUDIO_URL = '/data-studio/';
  var SEOUL_STUDIO_URL = '/seoul-studio/';

  function wireExternalLink(link, url, marker, title) {
    if (link.dataset[marker]) return link;
    link.dataset[marker] = '1';
    link.setAttribute('aria-label', title);
    link.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      window.open(url, '_blank', 'noopener,noreferrer');
    }, true);
    return link;
  }

  function wireDataStudioRocket(link) {
    return wireExternalLink(link, DATA_STUDIO_URL, 'ivxDataStudio', 'Data Studio');
  }

  function renamePipelinesTooltip() {
    document.querySelectorAll('.cdk-overlay-container .cdk-overlay-pane').forEach(function (pane) {
      var text = (pane.textContent || '').trim();
      if (text !== 'PIPELINES') return;

      var surface =
        pane.querySelector('.mat-mdc-tooltip-surface') ||
        pane.querySelector('.mdc-tooltip__surface') ||
        pane.firstElementChild ||
        pane;
      surface.textContent = 'Video Studio';
    });
  }

  function wireVideoStudioPipelines(link) {
    wireExternalLink(link, SEOUL_STUDIO_URL, 'ivxVideoStudio', 'Video Studio');
    if (link.dataset.ivxVideoStudioTooltip) return link;
    link.dataset.ivxVideoStudioTooltip = '1';

    function onHover() {
      renamePipelinesTooltip();
      setTimeout(renamePipelinesTooltip, 0);
      setTimeout(renamePipelinesTooltip, 80);
      setTimeout(renamePipelinesTooltip, 180);
    }

    link.addEventListener('mouseenter', onHover, true);
    link.addEventListener('focus', onHover, true);
    return link;
  }

  function removeInjectedSeoulNav(root) {
    var old = root.getElementById('ivx-seoul-studio-nav');
    if (old) old.remove();
  }

  function hideGlobalHelp(root) {
    root.querySelectorAll('button,a,[role="button"]').forEach(function (control) {
      var icons=Array.from(control.querySelectorAll('i,mat-icon,svg,use'));
      var signature=[control.getAttribute('aria-label'),control.getAttribute('title'),control.getAttribute('data-id'),control.className]
        .concat(icons.reduce(function(all,icon){return all.concat([icon.className && (icon.className.baseVal || icon.className),icon.textContent,icon.getAttribute('href'),icon.getAttribute('data-id')]);},[]))
        .filter(Boolean).join(' ').toLowerCase();
      if (/(^|[ _-])(help|help_outline|question|question_circle)([ _-]|$)/.test(signature)) {
        control.style.setProperty('display','none','important');
        control.setAttribute('aria-hidden','true');
      }
    });
  }

  function renderSettingsAdmin() {
    var content = document.querySelector('sm-settings mat-drawer-content .section .content');
    if (!content || document.getElementById('ivx-settings-admin-panel')) return;
    Array.from(content.children).forEach(function (child) { child.style.display = 'none'; });

    var panel = document.createElement('div');
    panel.id = 'ivx-settings-admin-panel';
    panel.style.cssText = 'width:100%;height:100%;overflow:auto;background:#07111d';
    content.appendChild(panel);
    var shadow = panel.attachShadow({mode:'open'});

    fetch('/admin-embedded.html?v=4', {cache:'no-store'}).then(function (response) {
      return response.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var style = doc.querySelector('style');
      var main = doc.querySelector('main');
      shadow.innerHTML = '<style>:host{display:block;min-height:100%;background:#07111d}' + (style ? style.textContent : '') + '</style>' + (main ? main.outerHTML : '<main>Admin 화면을 불러오지 못했습니다.</main>');
      if (window.ivxInitAdminApp) window.ivxInitAdminApp(shadow);
    });

    document.querySelectorAll('body *').forEach(function (node) {
      if (!node.children.length && /^(Profile|Configuration|Workspace|Storage Cleanup)$/.test((node.textContent||'').trim())) {
        var box=node.getBoundingClientRect();
        if (box.top >= 0 && box.top < 64 && box.left > 60) node.textContent='Admin';
      }
    });
    window.history.replaceState(window.history.state, '', '/settings/admin');
  }

  function syncSettingsAdmin(root) {
    if (!/^\/settings(?:\/|$)/.test(location.pathname) || root.getElementById('ivx-settings-admin')) return;
    if (window.__ivxAccessAdmin === undefined) {
      if (!window.__ivxAccessLookup) window.__ivxAccessLookup = fetch('/access-api/auth/me',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(me){window.__ivxAccessAdmin=!!(me&&me.is_admin);applySidebarCustomizations(document);}).catch(function(){window.__ivxAccessAdmin=false;});
      return;
    }
    if (!window.__ivxAccessAdmin) return;
    var items=Array.from(root.querySelectorAll('sm-settings mat-drawer mat-list-item'));
    var reference=items.find(function(item){return (item.textContent||'').trim()==='Profile';});
    if (!reference) return;
    var routes={'Profile':'/settings/profile','Configuration':'/settings/webapp-configuration','Workspace':'/settings/workspace-configuration','Storage Cleanup':'/settings/storage-credentials'};
    items.forEach(function(item){
      var route=routes[(item.textContent||'').trim()];
      if (!route || item.dataset.ivxAdminExit) return;
      item.dataset.ivxAdminExit='1';
      item.addEventListener('pointerdown',function(event){
        if (!document.getElementById('ivx-settings-admin-panel')) return;
        event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();location.assign(route);
      },true);
    });
    var admin=reference.cloneNode(true);
    admin.id='ivx-settings-admin';admin.classList.remove('active','selected');admin.removeAttribute('routerlink');
    var label=admin.querySelector('.mdc-list-item__primary-text, .mat-mdc-list-item-title, [matlistitemtitle]');
    if(label)label.textContent='Admin';else admin.textContent='Admin';
    admin.addEventListener('click',function(event){
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
      items.forEach(function(item){
        item.classList.remove('active','selected');
        item.removeAttribute('aria-current');
      });
      renderSettingsAdmin();
      admin.classList.add('active');
      admin.setAttribute('aria-current','page');
    });
    items[items.length-1].parentElement.appendChild(admin);
  }

  function applySidebarCustomizations(root) {
    if (root.getElementById('ivx-settings-admin-panel')) {
      root.querySelectorAll('sm-settings mat-drawer mat-list-item').forEach(function(item){
        item.classList.toggle('active', item.id === 'ivx-settings-admin');
        if (item.id !== 'ivx-settings-admin') item.removeAttribute('aria-current');
      });
    }
    removeInjectedSeoulNav(root);
    hideGlobalHelp(root);
    syncSettingsAdmin(root);

    root.querySelectorAll('sm-side-nav .al-ico-enterprise-rocket').forEach(function (el) {
      wireDataStudioRocket(el.closest('a, button') || el);
    });

    root.querySelectorAll('sm-side-nav .al-ico-pipelines').forEach(function (el) {
      wireVideoStudioPipelines(el.closest('a, button') || el);
    });
  }

  function start() {
    applySidebarCustomizations(document);
    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        applySidebarCustomizations(document);
      });
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

/* Training settings: isolated modal, using the existing sidebar container. */
(function(){
 if(window.__ivxTrainNav)return;window.__ivxTrainNav=true;
 var dialog, opener, canTrain=false;
 var style=document.createElement('style');
 style.textContent='#ivx-train-nav{display:flex!important;align-items:center;justify-content:center;color:var(--color-primary);font:22px Heebo,sans-serif;cursor:pointer}#ivx-train-nav[aria-disabled="true"]{color:#66758a!important;cursor:not-allowed!important;opacity:.5}#ivx-train-dialog{border:1px solid #344358;border-radius:16px;padding:0;width:min(1560px,94vw);height:92vh;max-width:94vw;max-height:94vh;background:#0e131a;box-shadow:0 24px 90px #0008;overflow:hidden}#ivx-train-dialog::backdrop{background:#080d16b8;backdrop-filter:blur(3px)}#ivx-train-dialog iframe{border:0;width:100%;height:100%;display:block}@media(max-width:760px){#ivx-train-dialog{width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border-radius:0}}';
 document.head.appendChild(style);
 function close(){if(dialog?.open)dialog.close();if(opener?.isConnected)opener.focus();}
 function open(e){e.preventDefault();if(!canTrain){e.stopPropagation();e.stopImmediatePropagation();return;}opener=e.currentTarget;if(!dialog){dialog=document.createElement('dialog');dialog.id='ivx-train-dialog';dialog.setAttribute('aria-label','모델 학습 설정');var frame=document.createElement('iframe');frame.title='Detector 및 VLM 학습 설정';frame.src='/train/';dialog.appendChild(frame);document.body.appendChild(dialog);dialog.addEventListener('cancel',e=>{e.preventDefault();close();});}else{dialog.querySelector('iframe').contentWindow.postMessage({type:'ivx-train-reopened'},location.origin);}dialog.showModal();}
 window.addEventListener('message',e=>{if(e.origin===location.origin&&dialog&&e.source===dialog.querySelector('iframe').contentWindow&&e.data?.type==='ivx-close-train')close();});
 function applyPermission(){var a=document.querySelector('#ivx-train-nav');if(!a)return;a.setAttribute('aria-disabled',canTrain?'false':'true');a.title=canTrain?'모델 학습 · Train':'모델 학습 및 배포 권한이 필요합니다.';if(canTrain){a.href='/train/';a.tabIndex=0;}else{a.removeAttribute('href');a.tabIndex=-1;if(dialog?.open)close();}}
 function sync(){var items=document.querySelector('sm-side-nav .items-container'),a=items&&items.querySelector('#ivx-train-nav');if(!items)return;if(!a){a=document.createElement('a');a.id='ivx-train-nav';a.className='item';a.setAttribute('aria-label','모델 학습 · Train');a.textContent='▶';a.addEventListener('click',open,true);items.appendChild(a);}applyPermission();}
 function boot(){new MutationObserver(sync).observe(document.body,{childList:true,subtree:true});sync();fetch('/access-api/auth/me',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(me){canTrain=!!(me&&(me.is_admin||(me.permissions||[]).includes('TRAIN_DEPLOY')));applyPermission();}).catch(function(){canTrain=false;applyPermission();});}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
