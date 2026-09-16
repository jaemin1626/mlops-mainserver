(function () {
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

    fetch('/admin-embedded.html?v=3', {cache:'no-store'}).then(function (response) {
      return response.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var style = doc.querySelector('style');
      var main = doc.querySelector('main');
      shadow.innerHTML = '<style>:host{display:block;min-height:100%;background:#07111d}' + (style ? style.textContent : '') + '</style>' + (main ? main.outerHTML : '<main>Admin 화면을 불러오지 못했습니다.</main>');
      var users = shadow.querySelector('#users');
      var data = [['김철수','chulsoo@intellivix.com','Admin',1],['이영희','younghee@intellivix.com','Worker',1],['박지훈','jihoon@intellivix.com','Reviewer',0],['최민지','minji@intellivix.com','Admin',1],['정우성','woosung@intellivix.com','Worker',1],['한지민','jimin@intellivix.com','Admin',1],['오세훈','sehoon@intellivix.com','Worker',0],['김다은','daeun@intellivix.com','Reviewer',1],['이준호','junho@intellivix.com','Worker',1],['배수빈','subin@intellivix.com','Admin',1]];
      if (users) users.innerHTML = data.map(function (u) { return '<div class="row"><span>□</span><span class="user"><span class="avatar">'+u[0][0]+'</span><span><b>'+u[0]+'</b><small class="email">'+u[1]+'</small></span></span><span><select class="select"><option>'+u[2]+'</option><option>Worker</option><option>Reviewer</option></select></span><span><span class="status '+(u[3]?'':'off')+'"><i class="dot"></i>'+(u[3]?'Active':'Inactive')+'</span></span><span class="actions"><button>Edit</button><button class="'+(u[3]?'danger':'')+'">'+(u[3]?'Deactivate':'Activate')+'</button></span></div>'; }).join('');
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
 var dialog, opener;
 var style=document.createElement('style');
 style.textContent='#ivx-train-nav{display:flex!important;align-items:center;justify-content:center;color:var(--color-primary);font:22px Heebo,sans-serif;cursor:pointer}#ivx-train-dialog{border:1px solid #344358;border-radius:16px;padding:0;width:min(1560px,94vw);height:92vh;max-width:94vw;max-height:94vh;background:#0e131a;box-shadow:0 24px 90px #0008;overflow:hidden}#ivx-train-dialog::backdrop{background:#080d16b8;backdrop-filter:blur(3px)}#ivx-train-dialog iframe{border:0;width:100%;height:100%;display:block}@media(max-width:760px){#ivx-train-dialog{width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border-radius:0}}';
 document.head.appendChild(style);
 function close(){if(dialog?.open)dialog.close();if(opener?.isConnected)opener.focus();}
 function open(e){e.preventDefault();opener=e.currentTarget;if(!dialog){dialog=document.createElement('dialog');dialog.id='ivx-train-dialog';dialog.setAttribute('aria-label','모델 학습 설정');var frame=document.createElement('iframe');frame.title='Detector 및 VLM 학습 설정';frame.src='/train/';dialog.appendChild(frame);document.body.appendChild(dialog);dialog.addEventListener('cancel',e=>{e.preventDefault();close();});}dialog.showModal();}
 window.addEventListener('message',e=>{if(e.origin===location.origin&&dialog&&e.source===dialog.querySelector('iframe').contentWindow&&e.data?.type==='ivx-close-train')close();});
 function sync(){var items=document.querySelector('sm-side-nav .items-container');if(!items||items.querySelector('#ivx-train-nav'))return;var a=document.createElement('a');a.id='ivx-train-nav';a.className='item';a.href='/train/';a.title='모델 학습 · Train';a.setAttribute('aria-label','모델 학습 · Train');a.textContent='▶';a.addEventListener('click',open);items.appendChild(a);}
 function boot(){new MutationObserver(sync).observe(document.body,{childList:true,subtree:true});sync();}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
