(function () {
  window.ivxInitAdminApp = function (shadow) {
    var PERM_LABELS = { TRAIN_DEPLOY: '학습 및 배포', DATA_GENERATE: '데이터 생성', LABEL_WORK: '라벨링 작업', LABEL_REVIEW: '라벨링 검수' };
    var PERM_ORDER = Object.keys(PERM_LABELS);
    var users = [];
    var groups = [];
    var listTab = 'users'; // 'users' | 'groups'
    var permTab = 'user'; // 'user' | 'group'
    var permTargetId = '';

    var q = function (sel) { return shadow.querySelector(sel); };
    var tabUsers = q('#ivx-tab-users');
    var tabGroups = q('#ivx-tab-groups');
    var create = q('#ivx-create');
    var search = q('#ivx-search');
    var table = q('#ivx-table');
    var listTitle = q('#ivx-list-title');
    var listSub = q('#ivx-list-sub');
    var stat1 = q('#ivx-stat-1'), stat2 = q('#ivx-stat-2'), stat3 = q('#ivx-stat-3');
    var stat1Label = q('#ivx-stat-1-label'), stat2Label = q('#ivx-stat-2-label'), stat3Label = q('#ivx-stat-3-label');
    var permCard = q('#ivx-perm-card');
    var historyTable = q('#ivx-history-table');

    function esc(v) { var n = document.createElement('span'); n.textContent = v == null ? '' : String(v); return n.innerHTML; }
    function labelOf(code) { return PERM_LABELS[code] || code; }
    function permList(codes) { return (codes || []).slice().sort(function (a, b) { return PERM_ORDER.indexOf(a) - PERM_ORDER.indexOf(b); }); }

    function api(path, opt) {
      return fetch('/access-api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opt || {}))
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            if (!r.ok) throw Error(d.error || '요청에 실패했습니다.');
            return d;
          });
        });
    }

    function role(u) {
      if (u.is_admin) return '관리자';
      if (u.effective_permissions.indexOf('LABEL_REVIEW') !== -1) return '검수자';
      if (u.effective_permissions.indexOf('LABEL_WORK') !== -1) return '작업자';
      return u.effective_permissions.length ? '권한 보유' : '권한 없음';
    }

    // ---------- 사용자 / 그룹 목록 (좌측) ----------
    function switchListTab(tab) {
      listTab = tab;
      tabUsers.classList.toggle('on', tab === 'users');
      tabGroups.classList.toggle('on', tab === 'groups');
      create.textContent = tab === 'users' ? '＋ 계정 생성' : '＋ 그룹 생성';
      search.hidden = false;
      search.placeholder = tab === 'users' ? '이름, 아이디로 검색' : '그룹 이름, 아이디로 검색';
      listTitle.textContent = tab === 'users' ? '사용자 목록' : '그룹 목록';
      listSub.textContent = tab === 'users' ? '등록된 사용자를 확인하고 권한을 관리할 수 있습니다.' : '그룹을 만들어 여러 사용자에게 한 번에 권한을 부여할 수 있습니다.';
      stat1Label.childNodes[0].nodeValue = tab === 'users' ? '전체 사용자' : '전체 그룹';
      stat2Label.childNodes[0].nodeValue = tab === 'users' ? '활성 사용자' : '소속 인원 있음';
      stat3Label.childNodes[0].nodeValue = tab === 'users' ? '비활성 사용자' : '소속 인원 없음';
      renderList();
      renderStats();
    }
    tabUsers.onclick = function () { switchListTab('users'); };
    tabGroups.onclick = function () { switchListTab('groups'); };

    function renderStats() {
      if (listTab === 'users') {
        stat1.textContent = users.length;
        stat2.textContent = users.filter(function (u) { return u.is_active; }).length;
        stat3.textContent = users.filter(function (u) { return !u.is_active; }).length;
      } else {
        stat1.textContent = groups.length;
        stat2.textContent = groups.filter(function (g) { return g.member_count > 0; }).length;
        stat3.textContent = groups.filter(function (g) { return g.member_count === 0; }).length;
      }
    }

    function renderList() {
      if (listTab === 'groups') return renderGroupList();
      var query = (search.value || '').toLowerCase();
      var rows = users.filter(function (u) { return !query || u.name.toLowerCase().indexOf(query) !== -1 || u.username.toLowerCase().indexOf(query) !== -1; });
      table.innerHTML = '<div class="row head user-row"><span>이름 (계정)</span><span>그룹</span><span>권한</span><span>권한 수</span><span>관리</span></div>' +
        (rows.length ? rows.map(function (u) {
          return '<div class="row user-row" data-id="' + u.id + '">' +
            '<span class="person"><i class="avatar">' + esc(u.name[0]) + '</i><span><b>' + esc(u.name) + '</b><small class="mail">' + esc(u.username) + ' <i class="status compact ' + (u.is_active ? '' : 'off') + '"><i class="dot"></i>' + (u.is_active ? '활성' : '비활성') + '</i></small></span></span>' +
            '<span class="tags">' + ((u.groups || []).length ? u.groups.map(function(g){return '<i class="tag">'+esc(g.name)+'</i>';}).join('') : '<i class="tag muted">없음</i>') + '</span>' +
            '<span class="tags permissions">' + (u.is_admin ? '<i class="tag gold">관리자</i>' : (u.effective_permissions.length ? permList(u.effective_permissions).map(function(p){return '<i class="tag">'+esc(labelOf(p))+'</i>';}).join('') : '<i class="tag muted">없음</i>')) + '</span>' +
            '<b class="permission-count">' + u.effective_permissions.length + '</b>' +
            '<span class="rowactions"><button class="edit">수정</button><button class="toggle ' + (u.is_active ? '' : 'on') + '">' + (u.is_active ? '비활성화' : '활성화') + '</button><button class="remove">삭제</button></span>' +
            '</div>';
        }).join('') : '<div class="empty">검색 결과가 없습니다.</div>');
      table.querySelectorAll('[data-id]').forEach(function (row) {
        var u = users.find(function (x) { return x.id === +row.dataset.id; });
        row.querySelector('.edit').onclick = function () { userEditor(u); };
        row.querySelector('.toggle').onclick = function () { patchUser(u, { is_active: !u.is_active }); };
        row.querySelector('.remove').onclick = function () { removeUser(u); };
      });
    }

    function renderGroupList() {
      var query = (search.value || '').toLowerCase();
      var visibleGroups = groups.filter(function(g){ return !query || g.name.toLowerCase().indexOf(query)!==-1 || String(g.id).indexOf(query)!==-1; });
      table.innerHTML = '<div class="row head" style="grid-template-columns:38px 1.6fr .8fr .8fr 58px 190px"><span></span><span>그룹 이름</span><span>소속 인원</span><span>권한</span><span></span><span>관리</span></div>' +
        (visibleGroups.length ? visibleGroups.map(function (g) {
          return '<div class="row" data-id="' + g.id + '" style="grid-template-columns:38px 1.6fr .8fr .8fr 58px 190px">' +
            '<span></span>' +
            '<span><b>' + esc(g.name) + '</b></span>' +
            '<span>' + g.member_count + '명</span>' +
            '<span class="tags">' + (g.permissions.length ? permList(g.permissions).map(function (p) { return '<i class="tag">' + labelOf(p) + '</i>'; }).join('') : '<i class="tag muted">없음</i>') + '</span>' +
            '<span></span>' +
            '<span class="rowactions"><button class="edit">수정</button><button class="remove">삭제</button></span>' +
            '</div>';
        }).join('') : '<div class="empty">등록된 그룹이 없습니다.</div>');
      table.querySelectorAll('[data-id]').forEach(function (row) {
        var g = groups.find(function (x) { return x.id === +row.dataset.id; });
        row.querySelector('.edit').onclick = function () { groupEditor(g); };
        row.querySelector('.remove').onclick = function () { removeGroup(g); };
      });
    }

    // ---------- 사용자 생성/수정 모달 ----------
    function modal(html) {
      var w = document.createElement('div');
      w.innerHTML = '<div style="position:fixed;inset:0;background:#000a;display:grid;place-items:center;z-index:20">' + html + '</div>';
      shadow.appendChild(w);
      return w;
    }

    function userEditor(u) {
      var fresh = !u;
      u = u || { name: '', username: '', is_admin: false, permissions: [], group_ids: [] };
      var groupChecks = groups.length ? groups.map(function(g){return '<label style="display:block;margin:8px"><input type="checkbox" name="group_id" value="'+g.id+'" '+((u.group_ids||[]).indexOf(g.id)!==-1?'checked':'')+'> '+esc(g.name)+'</label>';}).join('') : '<p class="muted">등록된 그룹이 없습니다.</p>';
      var w = modal(
        '<form style="width:min(520px,90vw);max-height:88vh;overflow:auto;background:#0d1928;border:1px solid #304561;border-radius:10px;padding:24px">' +
        '<h2>' + (fresh ? '계정 생성' : '사용자 수정') + '</h2>' +
        '<label>이름<input class="select" name="name" required value="' + esc(u.name) + '"></label>' +
        '<label>로그인 계정<input class="select" name="username" ' + (fresh ? 'required' : 'disabled') + ' value="' + esc(u.username) + '"></label>' +
        '<label>' + (fresh ? '초기 비밀번호' : '새 비밀번호 (변경 시에만)') + '<input class="select" type="password" name="password" ' + (fresh ? 'required minlength="5"' : '') + '></label>' +
        '<fieldset><legend>소속 그룹 (복수 선택)</legend>' + groupChecks + '</fieldset>' +
        '<label><input type="checkbox" name="admin" ' + (u.is_admin ? 'checked' : '') + '> 관리자</label>' +
        '<div>' + PERM_ORDER.map(function (p) { return '<label style="display:block;margin:10px"><input type="checkbox" name="perm" value="' + p + '" ' + (u.permissions.indexOf(p) !== -1 ? 'checked' : '') + '> ' + labelOf(p) + '</label>'; }).join('') + '</div>' +
        '<p data-error style="color:#ff8995;min-height:18px"></p>' +
        '<div style="text-align:right"><button type="button" class="btn" data-close>취소</button> <button class="primary">저장</button></div>' +
        '</form>'
      );
      w.querySelector('[data-close]').onclick = function () { w.remove(); };
      w.querySelector('form').onsubmit = function (e) {
        e.preventDefault();
        var f = new FormData(e.target);
        var body = { name: String(f.get('name') || '').trim(), is_admin: f.get('admin') === 'on', permissions: f.getAll('perm'), group_ids: f.getAll('group_id').map(Number) };
        if (fresh) body.username = String(f.get('username') || '').trim();
        if (f.get('password')) body.password = String(f.get('password'));
        api(fresh ? '/admin/users' : '/admin/users/' + u.id, { method: fresh ? 'POST' : 'PATCH', body: JSON.stringify(body) })
          .then(function () { w.remove(); load(); })
          .catch(function (x) { w.querySelector('[data-error]').textContent = x.message; });
      };
    }

    function patchUser(u, body) { api('/admin/users/' + u.id, { method: 'PATCH', body: JSON.stringify(body) }).then(load).catch(function (e) { alert(e.message); }); }

    function removeUser(u) {
      if (!confirm('"' + u.name + '"(' + u.username + ') 계정을 삭제할까요?\n이 작업은 되돌릴 수 없습니다.')) return;
      if (!confirm('정말로 삭제하시겠습니까? 다시 한번 확인합니다.')) return;
      api('/admin/users/' + u.id, { method: 'DELETE' }).then(load).catch(function (e) { alert(e.message); });
    }

    // ---------- 그룹 생성/수정 모달 ----------
    function groupEditor(g) {
      var fresh = !g;
      g = g || { name: '', permissions: [], members: [] };
      var memberIds=(g.members||[]).map(function(x){return x.id;});
      var memberChecks=users.length?users.map(function(u){return '<label style="display:block;margin:8px"><input type="checkbox" name="member_id" value="'+u.id+'" '+(memberIds.indexOf(u.id)!==-1?'checked':'')+'> '+esc(u.name)+' ('+esc(u.username)+')</label>';}).join(''):'<p class="muted">등록된 사용자가 없습니다.</p>';
      var w = modal(
        '<form style="width:min(440px,90vw);background:#0d1928;border:1px solid #304561;border-radius:10px;padding:24px">' +
        '<h2>' + (fresh ? '그룹 생성' : '그룹 수정') + '</h2>' +
        '<label>그룹 이름<input class="select" name="name" required maxlength="64" value="' + esc(g.name) + '"></label>' +
        '<h3>그룹 권한</h3><div>' + PERM_ORDER.map(function (p) { return '<label style="display:block;margin:10px"><input type="checkbox" name="perm" value="' + p + '" ' + (g.permissions.indexOf(p) !== -1 ? 'checked' : '') + '> ' + labelOf(p) + '</label>'; }).join('') + '</div><h3>소속 사용자</h3><div style="max-height:180px;overflow:auto">'+memberChecks+'</div>' +
        '<p data-error style="color:#ff8995;min-height:18px"></p>' +
        '<div style="text-align:right"><button type="button" class="btn" data-close>취소</button> <button class="primary">저장</button></div>' +
        '</form>'
      );
      w.querySelector('[data-close]').onclick = function () { w.remove(); };
      w.querySelector('form').onsubmit = function (e) {
        e.preventDefault();
        var f = new FormData(e.target);
        var body = { name: String(f.get('name') || '').trim(), permissions: f.getAll('perm'), member_ids: f.getAll('member_id').map(Number) };
        api(fresh ? '/admin/groups' : '/admin/groups/' + g.id, { method: fresh ? 'POST' : 'PATCH', body: JSON.stringify(body) })
          .then(function () { w.remove(); load(); })
          .catch(function (x) { w.querySelector('[data-error]').textContent = x.message; });
      };
    }

    function removeGroup(g) {
      var warn = g.member_count > 0 ? ('\n현재 ' + g.member_count + '명이 속해 있으며, 삭제하면 그룹으로부터 받던 권한을 잃습니다.') : '';
      if (!confirm('"' + g.name + '" 그룹을 삭제할까요?' + warn)) return;
      if (!confirm('정말로 삭제하시겠습니까? 다시 한번 확인합니다.')) return;
      api('/admin/groups/' + g.id, { method: 'DELETE' }).then(load).catch(function (e) { alert(e.message); });
    }

    create.onclick = function () { listTab === 'users' ? userEditor() : groupEditor(); };
    search.oninput = renderList;

    // ---------- 권한 설정 (우측) ----------
    function switchPermTab(tab) {
      permTab = tab;
      permTargetId = '';
      renderPermCard();
    }

    function renderPermCard() {
      var options = permTab === 'user'
        ? users.map(function (u) { return '<option value="' + u.id + '">' + esc(u.name) + ' (' + esc(u.username) + ')</option>'; }).join('')
        : groups.map(function (g) { return '<option value="' + g.id + '">' + esc(g.name) + '</option>'; }).join('');
      permCard.innerHTML =
        '<h2>권한 설정</h2>' +
        '<div class="muted">개인 또는 그룹을 선택하여 기능별 권한을 설정할 수 있습니다.</div>' +
        '<div class="permission-tabs"><span class="ptab-user ' + (permTab === 'user' ? 'on' : '') + '">♟　개인별 권한 설정</span><span class="ptab-group ' + (permTab === 'group' ? 'on' : '') + '">♟　그룹별 권한 설정</span></div>' +
        '<label>' + (permTab === 'user' ? '사용자 선택' : '그룹 선택') + '</label>' +
        '<select class="select" data-target><option value="">' + (permTab === 'user' ? '사용자를 선택하세요.' : '그룹을 선택하세요.') + '</option>' + options + '</select>' +
        '<div data-perms></div>';
      permCard.querySelector('.ptab-user').onclick = function () { switchPermTab('user'); };
      permCard.querySelector('.ptab-group').onclick = function () { switchPermTab('group'); };
      var sel = permCard.querySelector('[data-target]');
      if (permTargetId) sel.value = permTargetId;
      sel.onchange = function () { permTargetId = sel.value; renderPermChecklist(); };
      renderPermChecklist();
    }

    function renderPermChecklist() {
      var box = permCard.querySelector('[data-perms]');
      if (!permTargetId) { box.innerHTML = ''; return; }
      if (permTab === 'user') {
        var u = users.find(function (x) { return x.id === +permTargetId; });
        if (!u) { box.innerHTML = ''; return; }
        var inherited = (u.groups||[]).length ? u.effective_permissions.filter(function (p) { return u.permissions.indexOf(p) === -1; }) : [];
        box.innerHTML = PERM_ORDER.map(function (p) {
          return '<div class="perm-row"><label><input type="checkbox" value="' + p + '" ' + (u.permissions.indexOf(p) !== -1 ? 'checked' : '') + '> ' + labelOf(p) + '</label></div>';
        }).join('') +
          (inherited.length ? '<p class="muted" style="margin-top:10px">그룹(' + esc(u.group.name) + ')에서 이미 부여됨: ' + permList(inherited).map(labelOf).join(', ') + '</p>' : '') +
          '<div class="save"><button class="primary">변경사항 저장</button></div>';
        box.querySelector('button').onclick = function () {
          patchUser(u, { permissions: Array.from(box.querySelectorAll('input:checked')).map(function (x) { return x.value; }) });
        };
      } else {
        var g = groups.find(function (x) { return x.id === +permTargetId; });
        if (!g) { box.innerHTML = ''; return; }
        box.innerHTML = PERM_ORDER.map(function (p) {
          return '<div class="perm-row"><label><input type="checkbox" value="' + p + '" ' + (g.permissions.indexOf(p) !== -1 ? 'checked' : '') + '> ' + labelOf(p) + '</label></div>';
        }).join('') +
          '<p class="muted" style="margin-top:10px">이 그룹에 속한 ' + g.member_count + '명 모두에게 적용됩니다.</p>' +
          '<div class="save"><button class="primary">변경사항 저장</button></div>';
        box.querySelector('button').onclick = function () {
          api('/admin/groups/' + g.id, { method: 'PATCH', body: JSON.stringify({ permissions: Array.from(box.querySelectorAll('input:checked')).map(function (x) { return x.value; }) }) })
            .then(load).catch(function (e) { alert(e.message); });
        };
      }
    }

    // ---------- 권한 변경 이력 ----------
    var HISTORY_ACTIONS = { CREATE_USER: 1, UPDATE_USER: 1, DELETE_USER: 1, CREATE_GROUP: 1, UPDATE_GROUP: 1, DELETE_GROUP: 1 };

    function historyChanges(entry) {
      var d={};try{d=entry.details?JSON.parse(entry.details):{};}catch(e){}
      var rows=[];
      (d.added_permissions||[]).forEach(function(p){rows.push(['권한 추가',labelOf(p)]);});
      (d.removed_permissions||[]).forEach(function(p){rows.push(['권한 삭제',labelOf(p)]);});
      if(entry.action==='DELETE_USER')rows.push(['아이디 삭제','계정 삭제']);
      else if(entry.action==='DELETE_GROUP')rows.push(['그룹 삭제','그룹 삭제']);
      else if(entry.action==='CREATE_USER')rows.push(['계정 생성','계정 생성']);
      else if(entry.action==='CREATE_GROUP')rows.push(['그룹 생성','그룹 생성']);
      if('is_active' in d)rows.push([d.is_active?'활성화':'비활성화',d.is_active?'계정 활성화':'계정 비활성화']);
      if('name' in d)rows.push(['정보 수정','이름 변경']);
      if('group_ids' in d||'group_id' in d)rows.push(['그룹 변경','소속 그룹 변경']);
      return rows;
    }

    function loadHistory() {
      api('/admin/audit').then(function (d) {
        var rows=[];(d.logs||[]).filter(function(x){return HISTORY_ACTIONS[x.action];}).forEach(function(x){historyChanges(x).forEach(function(change){rows.push({entry:x,change:change});});});rows=rows.slice(0,100);
        historyTable.innerHTML='<div class="hrow head"><span>일시</span><span>대상 유형</span><span>대상</span><span>변경 유형</span><span>변경 내용</span><span>변경자</span></div>'+
          (rows.length?rows.map(function(r){var x=r.entry;return '<div class="hrow"><span>'+esc(new Date(x.created_at).toLocaleString())+'</span><span>'+esc(x.target_type==='group'?'그룹':'사용자')+'</span><span>'+esc(x.target_name||'-')+'</span><span>'+esc(r.change[0])+'</span><span>'+esc(r.change[1])+'</span><span>'+esc(x.actor_name||'시스템')+'</span></div>';}).join(''):'<div class="hrow"><span class="muted" style="grid-column:1/-1">변경 이력이 없습니다.</span></div>');
      }).catch(function(e){historyTable.innerHTML='<div class="hrow"><span style="grid-column:1/-1;color:#ff8995">'+esc(e.message)+'</span></div>';});
    }

    // ---------- 로드 ----------
    function load() {
      Promise.all([api('/admin/users'), api('/admin/groups')]).then(function (r) {
        users = r[0].users || [];
        groups = r[1].groups || [];
        renderList();
        renderStats();
        renderPermCard();
        loadHistory();
      }).catch(function (e) {
        table.innerHTML = '<div class="empty" style="color:#ff8995">' + esc(e.message) + '</div>';
      });
    }

    load();
  };
})();
