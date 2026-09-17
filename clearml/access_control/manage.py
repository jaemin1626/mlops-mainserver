import argparse, sqlite3
import app

def main():
 p=argparse.ArgumentParser(description='Access-control account management')
 sub=p.add_subparsers(dest='command',required=True)
 a=sub.add_parser('create-admin');a.add_argument('--username',required=True);a.add_argument('--name',required=True);a.add_argument('--password',required=True)
 args=p.parse_args();app.init()
 if args.command=='create-admin':
  if len(args.password)<5:raise SystemExit('password must contain at least 5 characters')
  with app.conn() as c:
   t=app.now();u=c.execute('SELECT * FROM users WHERE username=?',(args.username,)).fetchone()
   if u:
    c.execute('UPDATE users SET name=?,password_hash=?,is_admin=1,is_active=1,must_change_password=1,updated_at=? WHERE id=?',(args.name,app.ph(args.password),t,u['id']));uid=u['id']
   else:
    uid=c.execute('INSERT INTO users(username,password_hash,name,is_admin,is_active,created_at,updated_at,must_change_password) VALUES(?,?,?,?,?,?,?,1)',(args.username,app.ph(args.password),args.name,1,1,t,t)).lastrowid
   c.execute('UPDATE users SET clearml_password_hash=? WHERE id=?',(app.clearml_hash(args.password),uid));app.sync_clearml_users(c);app.setp(c,uid,app.PERMS);app.audit(c,uid,'CREATE_OR_RESET_ADMIN','user',uid)
  print(f'admin ready: {args.username}')
if __name__=='__main__':main()
