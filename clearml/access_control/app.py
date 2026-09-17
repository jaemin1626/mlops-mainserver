import base64,hashlib,hmac,json,os,re,secrets,sqlite3,time,urllib.request
import bcrypt
from datetime import datetime,timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse,parse_qs
DB=os.getenv('ACCESS_DB','/data/access.db'); ORIGIN=os.getenv('ACCESS_ALLOWED_ORIGIN',''); CLEARML=os.getenv('CLEARML_API','http://apiserver:8008'); FIXED_USERS_FILE=os.getenv('CLEARML_FIXED_USERS_FILE','/config/fixed-users.json')
MONGO_HOST=os.getenv('CLEARML_MONGODB_SERVICE_HOST','mongo'); MONGO_PORT=int(os.getenv('CLEARML_MONGODB_SERVICE_PORT','27017'))
PERMS=('TRAIN_DEPLOY','DATA_GENERATE','LABEL_WORK','LABEL_REVIEW')
FLOW={'UNASSIGNED':{'ASSIGNED'},'ASSIGNED':{'IN_PROGRESS'},'IN_PROGRESS':{'REVIEW_REQUESTED'},'REVIEW_REQUESTED':{'IN_REVIEW'},'IN_REVIEW':{'COMPLETED','REJECTED'},'REJECTED':{'IN_PROGRESS'}}
def now():return datetime.now(timezone.utc).isoformat()
def conn():c=sqlite3.connect(DB,timeout=15);c.row_factory=sqlite3.Row;c.execute('PRAGMA foreign_keys=ON');return c
def init():
 os.makedirs(os.path.dirname(DB),exist_ok=True)
 with conn() as c:
  c.executescript('''PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,clearml_user_id TEXT UNIQUE,username TEXT UNIQUE NOT NULL,password_hash TEXT,name TEXT NOT NULL,is_admin INTEGER NOT NULL DEFAULT 0,is_active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,clearml_password_hash TEXT,must_change_password INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS permissions(id INTEGER PRIMARY KEY,code TEXT UNIQUE NOT NULL,description TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_permissions(user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,PRIMARY KEY(user_id,permission_id));
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT UNIQUE NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS labeling_tasks(id INTEGER PRIMARY KEY,dataset_id TEXT NOT NULL,title TEXT NOT NULL,assignee_id INTEGER REFERENCES users(id),reviewer_id INTEGER REFERENCES users(id),status TEXT NOT NULL,created_by INTEGER REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS labeling_task_history(id INTEGER PRIMARY KEY,task_id INTEGER REFERENCES labeling_tasks(id) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id),action TEXT NOT NULL,before_status TEXT,after_status TEXT,comment TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY,actor_id INTEGER REFERENCES users(id),action TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT,details TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS group_permissions(group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,PRIMARY KEY(group_id,permission_id));
CREATE TABLE IF NOT EXISTS user_groups(user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,PRIMARY KEY(user_id,group_id));''')
  cols={x['name'] for x in c.execute('PRAGMA table_info(users)')}
  if 'clearml_password_hash' not in cols:c.execute('ALTER TABLE users ADD COLUMN clearml_password_hash TEXT')
  if 'must_change_password' not in cols:c.execute('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0')
  if 'group_id' not in cols:c.execute('ALTER TABLE users ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL')
  c.execute('INSERT OR IGNORE INTO user_groups(user_id,group_id) SELECT id,group_id FROM users WHERE group_id IS NOT NULL')
  acols={x['name'] for x in c.execute('PRAGMA table_info(audit_logs)')}
  if 'actor_name' not in acols:c.execute('ALTER TABLE audit_logs ADD COLUMN actor_name TEXT')
  if 'target_name' not in acols:c.execute('ALTER TABLE audit_logs ADD COLUMN target_name TEXT')
  for code,desc in zip(PERMS,('학습 및 배포','데이터 생성','라벨링 작업','라벨링 검수')):c.execute('INSERT OR IGNORE INTO permissions(code,description) VALUES(?,?)',(code,desc))
def clearml_hash(password):return base64.b64encode(bcrypt.hashpw(password.encode(),bcrypt.gensalt())).decode()
def sync_clearml_users(c):
 rows=c.execute('SELECT username,name,clearml_password_hash FROM users WHERE is_active=1 AND clearml_password_hash IS NOT NULL ORDER BY id')
 data=[{'username':x['username'],'password':x['clearml_password_hash'],'name':x['name']} for x in rows]
 os.makedirs(os.path.dirname(FIXED_USERS_FILE),exist_ok=True);tmp=FIXED_USERS_FILE+'.tmp'
 with open(tmp,'w',encoding='utf-8') as f:json.dump(data,f,ensure_ascii=False)
 os.chmod(tmp,0o600);os.replace(tmp,FIXED_USERS_FILE)
def ensure_clearml_profile(username,name):
 '''ClearML apiserver는 fixed-users 목록을 프로세스 시작 시점에만 읽어 대시보드용
 프로필(backend.user)을 만든다. 재시작 없이 새/이름이 바뀐 계정도 즉시 정상 동작하도록
 apiserver가 시작 시 실행하는 것과 동일한 프로필 생성을 여기서도 직접 수행한다.
 apiserver의 fixed user id 규칙(md5("{company}:{username}"))과 반드시 일치해야 한다.'''
 try:
  from pymongo import MongoClient
  client=MongoClient(host=MONGO_HOST,port=MONGO_PORT,serverSelectionTimeoutMS=4000)
  try:
   db=client['backend']
   company=db.company.find_one({'name':'clearml'},{'_id':1})
   if not company:return
   company_id=company['_id']
   user_id=hashlib.md5(f'{company_id}:{username}'.encode()).hexdigest()
   given_name,_,family_name=name.partition(' ')
   if db.user.find_one({'_id':user_id}):
    db.user.update_one({'_id':user_id},{'$set':{'name':name,'given_name':given_name,'family_name':family_name}})
   else:
    db.user.insert_one({'_id':user_id,'company':company_id,'name':name,'given_name':given_name,'family_name':family_name,'created':datetime.now(timezone.utc)})
  finally:
   client.close()
 except Exception:
  pass
def clearml_login(username,password):
 auth=base64.b64encode((username+':'+password).encode()).decode()
 req=urllib.request.Request(CLEARML+'/auth.login',data=b'{"expiration_sec":28800}',headers={'Authorization':'Basic '+auth,'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=5) as response:cookie=response.headers.get('Set-Cookie','').split(';',1)[0]
 if not cookie.startswith('clearml_token_basic='):raise RuntimeError('ClearML cookie missing')
 return cookie+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800'
def ph(password):
 salt=secrets.token_bytes(16);r=310000;d=hashlib.pbkdf2_hmac('sha256',password.encode(),salt,r);return f'pbkdf2_sha256${r}${base64.urlsafe_b64encode(salt).decode()}${base64.urlsafe_b64encode(d).decode()}'
def pv(password,value):
 try:_,r,s,d=value.split('$');return hmac.compare_digest(hashlib.pbkdf2_hmac('sha256',password.encode(),base64.urlsafe_b64decode(s),int(r)),base64.urlsafe_b64decode(d))
 except:return False
def audit(c,actor,action,typ,target=None,target_name=None,details=None):
 actor_name=None
 if actor:
  row=c.execute('SELECT name FROM users WHERE id=?',(actor,)).fetchone()
  actor_name=row['name'] if row else None
 c.execute('INSERT INTO audit_logs(actor_id,actor_name,action,target_type,target_id,target_name,details,created_at) VALUES(?,?,?,?,?,?,?,?)',(actor,actor_name,action,typ,str(target) if target is not None else None,target_name,json.dumps(details,ensure_ascii=False) if details else None,now()))
def own_permissions(c,uid):
 return [x['code'] for x in c.execute('SELECT p.code FROM permissions p JOIN user_permissions up ON p.id=up.permission_id WHERE up.user_id=? ORDER BY p.id',(uid,))]
def group_permissions_of(c,gid):
 return [x['code'] for x in c.execute('SELECT p.code FROM permissions p JOIN group_permissions gp ON p.id=gp.permission_id WHERE gp.group_id=? ORDER BY p.id',(gid,))]
def groups_of(c,uid):
 return [dict(x) for x in c.execute('SELECT g.id,g.name FROM groups g JOIN user_groups ug ON ug.group_id=g.id WHERE ug.user_id=? ORDER BY g.name',(uid,))]
def effective_permissions(c,u):
 own=own_permissions(c,u['id'])
 grp=[x['code'] for x in c.execute('SELECT DISTINCT p.code FROM permissions p JOIN group_permissions gp ON p.id=gp.permission_id JOIN user_groups ug ON ug.group_id=gp.group_id WHERE ug.user_id=?',(u['id'],))]
 return sorted(set(own)|set(grp),key=lambda code:PERMS.index(code) if code in PERMS else 99)
def has_permission(c,uid,code):
 return bool(c.execute('SELECT 1 FROM user_permissions up JOIN permissions p ON p.id=up.permission_id WHERE up.user_id=? AND p.code=? UNION SELECT 1 FROM user_groups ug JOIN group_permissions gp ON gp.group_id=ug.group_id JOIN permissions p ON p.id=gp.permission_id WHERE ug.user_id=? AND p.code=? LIMIT 1',(uid,code,uid,code)).fetchone())
def uj(c,u):
 groups=groups_of(c,u['id'])
 base={k:(bool(u[k]) if k in ('is_admin','is_active','must_change_password') else u[k]) for k in ('id','username','name','is_admin','is_active','must_change_password','created_at','updated_at')}
 return base|{'permissions':own_permissions(c,u['id']),'effective_permissions':effective_permissions(c,u),'groups':groups,'group':groups[0] if groups else None,'group_ids':[g['id'] for g in groups]}
def setp(c,uid,codes):
 if set(codes)-set(PERMS):raise ValueError('지원하지 않는 권한입니다.')
 c.execute('DELETE FROM user_permissions WHERE user_id=?',(uid,))
 for x in codes:c.execute('INSERT INTO user_permissions SELECT ?,id FROM permissions WHERE code=?',(uid,x))
def set_user_groups(c,uid,group_ids):
 if not isinstance(group_ids,list) or any(not isinstance(gid,int) for gid in group_ids):raise ValueError('올바른 그룹 목록이 필요합니다.')
 ids=list(dict.fromkeys(group_ids))
 if ids and c.execute('SELECT COUNT(*) n FROM groups WHERE id IN (%s)'%','.join('?'*len(ids)),ids).fetchone()['n']!=len(ids):raise ValueError('존재하지 않는 그룹입니다.')
 c.execute('DELETE FROM user_groups WHERE user_id=?',(uid,))
 for gid in ids:c.execute('INSERT INTO user_groups(user_id,group_id) VALUES(?,?)',(uid,gid))
def setgp(c,gid,codes):
 if set(codes)-set(PERMS):raise ValueError('지원하지 않는 권한입니다.')
 c.execute('DELETE FROM group_permissions WHERE group_id=?',(gid,))
 for x in codes:c.execute('INSERT INTO group_permissions SELECT ?,id FROM permissions WHERE code=?',(gid,x))
def set_group_members(c,gid,user_ids):
 if not isinstance(user_ids,list) or any(not isinstance(uid,int) for uid in user_ids):raise ValueError('올바른 사용자 목록이 필요합니다.')
 ids=list(dict.fromkeys(user_ids))
 if ids and c.execute('SELECT COUNT(*) n FROM users WHERE id IN (%s)'%','.join('?'*len(ids)),ids).fetchone()['n']!=len(ids):raise ValueError('존재하지 않는 사용자입니다.')
 c.execute('DELETE FROM user_groups WHERE group_id=?',(gid,))
 for uid in ids:c.execute('INSERT INTO user_groups(user_id,group_id) VALUES(?,?)',(uid,gid))
def gj(c,g):
 members=[dict(x) for x in c.execute('SELECT u.id,u.name,u.username FROM users u JOIN user_groups ug ON ug.user_id=u.id WHERE ug.group_id=? ORDER BY u.name',(g['id'],))]
 return {'id':g['id'],'name':g['name'],'permissions':group_permissions_of(c,g['id']),'member_count':len(members),'members':members,'created_at':g['created_at'],'updated_at':g['updated_at']}
def clearml(cookie):
 try:
  q=urllib.request.Request(CLEARML+'/users.get_current_user',data=b'{}',headers={'Cookie':cookie,'Content-Type':'application/json'})
  with urllib.request.urlopen(q,timeout=5) as r:u=json.load(r).get('data',{}).get('user',{})
  return u if u.get('id') else None
 except:return None
def user(cookie):
 cs=SimpleCookie();cs.load(cookie or '');m=cs.get('ivx_session')
 if not m:return None
 with conn() as c:
  return c.execute('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.is_active=1',(hashlib.sha256(m.value.encode()).hexdigest(),int(time.time()))).fetchone()

class H(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def out(self,n,d,h={}):
  b=json.dumps(d,ensure_ascii=False).encode();self.send_response(n);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(b)))
  for k,v in h.items():
   for item in (v if isinstance(v,(list,tuple)) else [v]):self.send_header(k,item)
  self.end_headers();self.wfile.write(b)
 def body(self,limit=65536):
  n=int(self.headers.get('Content-Length','0'))
  if not 0<n<=limit:raise ValueError('잘못된 요청 크기입니다.')
  q=json.loads(self.rfile.read(n))
  if not isinstance(q,dict):raise ValueError('JSON 객체가 필요합니다.')
  return q
 def auth(self,perm=None,admin=False):
  u=user(self.headers.get('Cookie',''))
  if not u:self.out(401,{'error':'로그인이 필요합니다.'});return
  if admin and not u['is_admin']:self.out(403,{'error':'관리자 권한이 필요합니다.'});return
  if perm and not u['is_admin']:
   with conn() as c:
    ok=has_permission(c,u['id'],perm)
   if not ok:self.out(403,{'error':perm+' 권한이 필요합니다.'});return
  return u
 def mutation(self):return not self.headers.get('Origin') or self.headers.get('Origin')==ORIGIN
 def do_GET(self):
  p=urlparse(self.path).path
  if p=='/health':return self.out(200,{'ok':True})
  if p=='/auth/status':
   with conn() as c:return self.out(200,{'initialized':bool(c.execute('SELECT 1 FROM users LIMIT 1').fetchone())})
  if p=='/authorize':
   perm=parse_qs(urlparse(self.path).query).get('permission',[None])[0];u=self.auth(perm)
   if u:return self.out(200,{'allowed':True})
   return
  u=self.auth()
  if not u:return
  with conn() as c:
   if p=='/auth/me':return self.out(200,uj(c,u))
   if p=='/permissions':return self.out(200,{'permissions':[dict(x) for x in c.execute('SELECT code,description FROM permissions ORDER BY id')]})
   if p=='/admin/users':
    if not u['is_admin']:return self.out(403,{'error':'관리자 권한이 필요합니다.'})
    return self.out(200,{'users':[uj(c,x) for x in c.execute('SELECT * FROM users ORDER BY id')]})
   if p=='/admin/groups':
    if not u['is_admin']:return self.out(403,{'error':'관리자 권한이 필요합니다.'})
    return self.out(200,{'groups':[gj(c,x) for x in c.execute('SELECT * FROM groups ORDER BY name')]})
   if p=='/admin/audit':
    if not u['is_admin']:return self.out(403,{'error':'관리자 권한이 필요합니다.'})
    rows=c.execute('SELECT a.id,a.actor_id,COALESCE(a.actor_name,u.name) actor_name,a.action,a.target_type,a.target_id,a.target_name,a.details,a.created_at FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200')
    return self.out(200,{'logs':[dict(x) for x in rows]})
   m=re.fullmatch(r'/labeling/tasks/(\d+)/history',p)
   if m:
    task=c.execute('SELECT * FROM labeling_tasks WHERE id=?',(m.group(1),)).fetchone()
    if not task:return self.out(404,{'error':'작업이 없습니다.'})
    if not u['is_admin'] and u['id'] not in (task['assignee_id'],task['reviewer_id']):return self.out(403,{'error':'할당된 작업만 조회할 수 있습니다.'})
    return self.out(200,{'history':[dict(x) for x in c.execute('SELECT * FROM labeling_task_history WHERE task_id=? ORDER BY id',(task['id'],))]})
   if p=='/labeling/tasks':
    rows=c.execute('SELECT * FROM labeling_tasks ORDER BY id DESC') if u['is_admin'] else c.execute('SELECT * FROM labeling_tasks WHERE assignee_id=? OR reviewer_id=? ORDER BY id DESC',(u['id'],u['id']))
    return self.out(200,{'tasks':[dict(x) for x in rows]})
  self.out(404,{'error':'not found'})
 def do_POST(self):
  if not self.mutation():return self.out(403,{'error':'Origin rejected'})
  p=urlparse(self.path).path
  try:
   if p=='/auth/login':
    q=self.body()
    with conn() as c:
     u=c.execute('SELECT * FROM users WHERE username=? AND is_active=1',(q.get('username'),)).fetchone()
     if not u or not u['password_hash'] or not pv(q.get('password',''),u['password_hash']):return self.out(401,{'error':'아이디 또는 비밀번호가 올바르지 않습니다.'})
     password=q.get('password','');ch=clearml_hash(password);c.execute('UPDATE users SET clearml_password_hash=? WHERE id=?',(ch,u['id']));sync_clearml_users(c)
     try:clearml_cookie=clearml_login(u['username'],password)
     except Exception:return self.out(503,{'error':'MLOps 사용자 인증 연동에 실패했습니다.'})
     tok=secrets.token_urlsafe(32);c.execute('INSERT INTO sessions(user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?)',(u['id'],hashlib.sha256(tok.encode()).hexdigest(),int(time.time())+28800,now()));audit(c,u['id'],'LOGIN','session');return self.out(200,uj(c,u),{'Set-Cookie':[f'ivx_session={tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800',clearml_cookie]})
   if p=='/authorize':
    q=self.body(4096);u=self.auth(q.get('permission'))
    if u:return self.out(200,{'allowed':True})
    return
   if p=='/auth/logout':
    cs=SimpleCookie();cs.load(self.headers.get('Cookie',''));m=cs.get('ivx_session')
    if m:
     with conn() as c:c.execute('DELETE FROM sessions WHERE token_hash=?',(hashlib.sha256(m.value.encode()).hexdigest(),))
    return self.out(200,{'ok':True},{'Set-Cookie':['ivx_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0','clearml_token_basic=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']})
   if p=='/auth/change-password':
    u=self.auth()
    if not u:return
    q=self.body();old=q.get('current_password','');new=q.get('new_password','')
    if len(new)<5:return self.out(400,{'error':'새 비밀번호는 5자 이상이어야 합니다.'})
    with conn() as c:
     current=c.execute('SELECT * FROM users WHERE id=?',(u['id'],)).fetchone()
     if not current['password_hash'] or not pv(old,current['password_hash']):return self.out(403,{'error':'현재 비밀번호가 올바르지 않습니다.'})
     c.execute('UPDATE users SET password_hash=?,clearml_password_hash=?,must_change_password=0,updated_at=? WHERE id=?',(ph(new),clearml_hash(new),now(),u['id']));sync_clearml_users(c);audit(c,u['id'],'CHANGE_PASSWORD','user',u['id'],u['name'])
    return self.out(200,{'ok':True})
   if p=='/admin/users':
    a=self.auth(admin=True)
    if not a:return
    q=self.body();username=str(q.get('username','')).strip();name=str(q.get('name','')).strip();password=q.get('password','')
    if not re.fullmatch(r'[A-Za-z0-9_.@-]{3,64}',username) or not name or len(password)<5:return self.out(400,{'error':'사용자명, 이름, 5자 이상 비밀번호가 필요합니다.'})
    group_ids=q.get('group_ids',[] if q.get('group_id') is None else [q.get('group_id')])
    with conn() as c:
     t=now();cur=c.execute('INSERT INTO users(username,password_hash,name,is_admin,is_active,created_at,updated_at,must_change_password,group_id) VALUES(?,?,?,?,?,?,?,0,NULL)',(username,ph(password),name,int(bool(q.get('is_admin'))),1,t,t));c.execute('UPDATE users SET clearml_password_hash=? WHERE id=?',(clearml_hash(password),cur.lastrowid));sync_clearml_users(c);ensure_clearml_profile(username,name);setp(c,cur.lastrowid,q.get('permissions',[]));set_user_groups(c,cur.lastrowid,group_ids);audit(c,a['id'],'CREATE_USER','user',cur.lastrowid,name,{'added_permissions':q.get('permissions',[]),'group_ids':group_ids});return self.out(201,uj(c,c.execute('SELECT * FROM users WHERE id=?',(cur.lastrowid,)).fetchone()))
   if p=='/admin/groups':
    a=self.auth(admin=True)
    if not a:return
    q=self.body();name=str(q.get('name','')).strip()
    if not name or len(name)>64:return self.out(400,{'error':'그룹 이름을 입력하세요.'})
    with conn() as c:
     t=now();cur=c.execute('INSERT INTO groups(name,created_at,updated_at) VALUES(?,?,?)',(name,t,t))
     setgp(c,cur.lastrowid,q.get('permissions',[]));set_group_members(c,cur.lastrowid,q.get('member_ids',[]));audit(c,a['id'],'CREATE_GROUP','group',cur.lastrowid,name,{'added_permissions':q.get('permissions',[]),'member_ids':q.get('member_ids',[])})
     return self.out(201,gj(c,c.execute('SELECT * FROM groups WHERE id=?',(cur.lastrowid,)).fetchone()))
   if p=='/labeling/tasks':
    a=self.auth(admin=True)
    if not a:return
    q=self.body();status='ASSIGNED' if q.get('assignee_id') else 'UNASSIGNED'
    with conn() as c:
     if q.get('assignee_id') and not has_permission(c,q['assignee_id'],'LABEL_WORK'):return self.out(400,{'error':'담당자에게 라벨링 작업 권한이 없습니다.'})
     if q.get('reviewer_id') and not has_permission(c,q['reviewer_id'],'LABEL_REVIEW'):return self.out(400,{'error':'검수자에게 라벨링 검수 권한이 없습니다.'})
     t=now();cur=c.execute('INSERT INTO labeling_tasks(dataset_id,title,assignee_id,reviewer_id,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',(q['dataset_id'],q['title'],q.get('assignee_id'),q.get('reviewer_id'),status,a['id'],t,t));audit(c,a['id'],'CREATE_LABEL_TASK','task',cur.lastrowid);return self.out(201,{'id':cur.lastrowid,'status':status})
   m=re.fullmatch(r'/labeling/tasks/(\d+)/transition',p)
   if m:
    q=self.body();target=q.get('status');u=self.auth('LABEL_REVIEW' if target in ('IN_REVIEW','COMPLETED','REJECTED') else 'LABEL_WORK')
    if not u:return
    with conn() as c:
     task=c.execute('SELECT * FROM labeling_tasks WHERE id=?',(m.group(1),)).fetchone()
     if not task:return self.out(404,{'error':'작업이 없습니다.'})
     reviewing=target in ('IN_REVIEW','COMPLETED','REJECTED')
     if not u['is_admin'] and ((reviewing and task['reviewer_id']!=u['id']) or (not reviewing and task['assignee_id']!=u['id'])):return self.out(403,{'error':'본인에게 할당된 작업만 변경할 수 있습니다.'})
     if target not in FLOW.get(task['status'],set()):return self.out(409,{'error':task['status']+' 상태에서 변경할 수 없습니다.'})
     c.execute('UPDATE labeling_tasks SET status=?,updated_at=? WHERE id=?',(target,now(),task['id']));c.execute('INSERT INTO labeling_task_history(task_id,user_id,action,before_status,after_status,comment,created_at) VALUES(?,?,?,?,?,?,?)',(task['id'],u['id'],'TRANSITION',task['status'],target,q.get('comment'),now()));return self.out(200,{'id':task['id'],'status':target})
   self.out(404,{'error':'not found'})
  except sqlite3.IntegrityError:return self.out(409,{'error':'중복되거나 참조할 수 없는 값입니다.'})
  except (ValueError,KeyError) as e:return self.out(400,{'error':str(e)})
 def do_PATCH(self):
  if not self.mutation():return self.out(403,{'error':'Origin rejected'})
  a=self.auth(admin=True)
  if not a:return
  path=urlparse(self.path).path
  mu=re.fullmatch(r'/admin/users/(\d+)',path)
  mg=re.fullmatch(r'/admin/groups/(\d+)',path)
  if not mu and not mg:return self.out(404,{'error':'not found'})
  try:q=self.body()
  except Exception as e:return self.out(400,{'error':str(e)})
  try:
   if mu:
    uid=int(mu.group(1))
    if set(q)-{'name','is_admin','is_active','permissions','password','group_id','group_ids'}:return self.out(400,{'error':'지원하지 않는 필드입니다.'})
    with conn() as c:
     old=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
     if not old:return self.out(404,{'error':'사용자가 없습니다.'})
     if uid==a['id'] and q.get('is_active') is False:return self.out(409,{'error':'현재 관리자는 비활성화할 수 없습니다.'})
     fs=[];vs=[]
     for k in ('name','is_admin','is_active'):
      if k in q:fs.append(k+'=?');vs.append(q[k] if k=='name' else int(q[k]))
     if 'group_ids' in q or 'group_id' in q:
      set_user_groups(c,uid,q.get('group_ids',[] if q.get('group_id') is None else [q.get('group_id')]))
     if q.get('password'):
      if len(q['password'])<5:return self.out(400,{'error':'비밀번호는 5자 이상이어야 합니다.'})
      fs.extend(('password_hash=?','clearml_password_hash=?','must_change_password=?'));vs.extend((ph(q['password']),clearml_hash(q['password']),0))
     if fs:vs.extend((now(),uid));c.execute('UPDATE users SET '+','.join(fs)+',updated_at=? WHERE id=?',vs)
     old_permissions=own_permissions(c,uid)
     if 'permissions'in q:setp(c,uid,q['permissions'])
     new_permissions=own_permissions(c,uid)
     sync_clearml_users(c)
     ensure_clearml_profile(old['username'],q.get('name',old['name']))
     details={k:v for k,v in q.items() if k not in ('password','permissions')}
     details['added_permissions']=[x for x in new_permissions if x not in old_permissions]
     details['removed_permissions']=[x for x in old_permissions if x not in new_permissions]
     if details['added_permissions'] or details['removed_permissions'] or any(k in q for k in ('is_active','name','is_admin','group_id','group_ids')):audit(c,a['id'],'UPDATE_USER','user',uid,q.get('name',old['name']),details=details)
     return self.out(200,uj(c,c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()))
   gid=int(mg.group(1))
   if set(q)-{'name','permissions','member_ids'}:return self.out(400,{'error':'지원하지 않는 필드입니다.'})
   with conn() as c:
    old=c.execute('SELECT * FROM groups WHERE id=?',(gid,)).fetchone()
    if not old:return self.out(404,{'error':'그룹이 없습니다.'})
    fs=[];vs=[]
    if 'name' in q:
     name=str(q['name']).strip()
     if not name or len(name)>64:return self.out(400,{'error':'그룹 이름을 입력하세요.'})
     fs.append('name=?');vs.append(name)
    if fs:vs.extend((now(),gid));c.execute('UPDATE groups SET '+','.join(fs)+',updated_at=? WHERE id=?',vs)
    old_permissions=group_permissions_of(c,gid)
    if 'permissions' in q:setgp(c,gid,q['permissions'])
    if 'member_ids' in q:set_group_members(c,gid,q['member_ids'])
    new_permissions=group_permissions_of(c,gid)
    details={'added_permissions':[x for x in new_permissions if x not in old_permissions],'removed_permissions':[x for x in old_permissions if x not in new_permissions]}
    if 'name' in q:details['name']=q['name']
    if details['added_permissions'] or details['removed_permissions'] or 'name' in q:audit(c,a['id'],'UPDATE_GROUP','group',gid,q.get('name',old['name']),details=details)
    return self.out(200,gj(c,c.execute('SELECT * FROM groups WHERE id=?',(gid,)).fetchone()))
  except sqlite3.IntegrityError:return self.out(409,{'error':'중복되거나 참조할 수 없는 값입니다.'})
  except (ValueError,KeyError) as e:return self.out(400,{'error':str(e)})
 def do_DELETE(self):
  if not self.mutation():return self.out(403,{'error':'Origin rejected'})
  a=self.auth(admin=True)
  if not a:return
  path=urlparse(self.path).path
  mu=re.fullmatch(r'/admin/users/(\d+)',path)
  mg=re.fullmatch(r'/admin/groups/(\d+)',path)
  if not mu and not mg:return self.out(404,{'error':'not found'})
  try:
   if mu:
    uid=int(mu.group(1))
    if uid==a['id']:return self.out(409,{'error':'현재 로그인한 관리자 계정은 삭제할 수 없습니다.'})
    with conn() as c:
     target=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
     if not target:return self.out(404,{'error':'사용자가 없습니다.'})
     if c.execute('SELECT 1 FROM labeling_tasks WHERE assignee_id=? OR reviewer_id=?',(uid,uid)).fetchone():
      return self.out(409,{'error':'이 사용자에게 할당된 라벨링 작업이 있어 삭제할 수 없습니다. 작업을 재할당한 뒤 다시 시도하세요.'})
     c.execute('UPDATE audit_logs SET actor_id=NULL WHERE actor_id=?',(uid,))
     c.execute('DELETE FROM users WHERE id=?',(uid,))
     sync_clearml_users(c)
     audit(c,a['id'],'DELETE_USER','user',uid,target['name'])
     return self.out(200,{'ok':True})
   gid=int(mg.group(1))
   with conn() as c:
    target=c.execute('SELECT * FROM groups WHERE id=?',(gid,)).fetchone()
    if not target:return self.out(404,{'error':'그룹이 없습니다.'})
    c.execute('DELETE FROM groups WHERE id=?',(gid,))
    audit(c,a['id'],'DELETE_GROUP','group',gid,target['name'])
    return self.out(200,{'ok':True})
  except sqlite3.IntegrityError:return self.out(409,{'error':'중복되거나 참조할 수 없는 값입니다.'})
if __name__=='__main__':
 init()
 with conn() as c:sync_clearml_users(c)
 ThreadingHTTPServer(('0.0.0.0',8095),H).serve_forever()
