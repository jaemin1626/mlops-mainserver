#!/usr/bin/env python3
"""ClearML API 키를 발급해 학습 서버 train.env 에 넣는다 (학습 서버에 키가 비어 있을 때만).

순서:
  1) SSH 로 학습 서버 train.env 를 읽어 CLEARML_API_ACCESS_KEY/SECRET_KEY 가 이미 있으면 아무것도 안 하고 끝낸다
  2) .env 의 관리자 계정으로 ClearML 에 로그인해 auth.create_credentials 로 키를 발급한다
  3) SSH(표준입력)로 학습 서버 train.env 에 키를 쓰고 ./scripts/config.sh apply 를 실행한다

사용법:
    python3 provision-training-credentials.py            # 실행
    python3 provision-training-credentials.py --check    # 학습 서버에 키가 있는지만 확인 (아무것도 바꾸지 않음)

전제: 학습 서버 SSH 접속이 되어 있고(ssh/id_ed25519), .env 의 CLEARML_LOGIN_PASSWORD 가 현재 비밀번호와 같을 것
      (첫 로그인 후 비밀번호를 바꿨다면 로그인이 실패해 안내만 출력한다). 실패해도 종료 코드는 0.
키 값은 화면에 출력하지 않고(앞 4자리만), 명령줄 인자로도 넘기지 않는다(표준입력 사용).
"""
import base64
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.request

LABEL = "training-server"
SAFE = re.compile(r"^[A-Za-z0-9_-]+$")


def load_env(path):
    values = {}
    if os.path.exists(path):
        for raw in open(path, encoding="utf-8"):
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
                val = val[1:-1]
            values[key.strip()] = val
    return values


def expand(env):
    """.env 의 ${VAR} 참조를 펼친다 (예: TRAINING_SSH_USER=${TRAINING_SERVER_USER})."""
    out = dict(env)
    for _ in range(4):
        for k, v in list(out.items()):
            out[k] = re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: out.get(m.group(1), ""), v)
    return out


def ssh(env, remote, stdin=None):
    key_dir = env["TRAINING_SSH_DIR"]
    cmd = ["ssh", "-i", os.path.join(key_dir, "id_ed25519"), "-p", env.get("TRAINING_SSH_PORT", "22"),
           "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
           "-o", "UserKnownHostsFile=" + os.path.join(key_dir, "known_hosts"), "-o", "ConnectTimeout=8",
           f"{env['TRAINING_SSH_USER']}@{env['TRAINING_SSH_HOST']}", remote]
    return subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=60)


def api(base, endpoint, payload, headers):
    req = urllib.request.Request(f"{base}/{endpoint}", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def main():
    check_only = "--check" in sys.argv[1:]
    root = os.environ.get("CLEARML_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = expand({**load_env(os.path.join(root, ".env")), **os.environ})
    env.setdefault("TRAINING_SSH_HOST", env.get("TRAINING_SERVER_IP", ""))
    for need in ("TRAINING_SSH_HOST", "TRAINING_SSH_USER", "TRAINING_SSH_DIR", "TRAINING_SSH_ROOT"):
        if not env.get(need):
            print(f"  ! .env 에 {need} 없음 — 건너뜀")
            return 0
    root_q = shlex.quote(env["TRAINING_SSH_ROOT"])

    # 1) 학습 서버 train.env 에 이미 키가 있는지
    probe = (f"cd {root_q} && f=mount/config/train.env && [ -f \"$f\" ] || {{ echo NO_TRAIN_ENV; exit 3; }}; "
             "for k in CLEARML_API_ACCESS_KEY CLEARML_API_SECRET_KEY; do "
             "v=$(grep \"^$k=\" \"$f\" | tail -1 | cut -d= -f2- | tr -d \"'\\\" \\r\"); "
             "[ -n \"$v\" ] || { echo EMPTY; exit 0; }; done; echo SET")
    res = ssh(env, probe)
    state = (res.stdout or "").strip().splitlines()[-1] if (res.stdout or "").strip() else ""
    if res.returncode not in (0, 3) or state not in ("SET", "EMPTY", "NO_TRAIN_ENV"):
        print("  ! 학습 서버 train.env 를 확인하지 못했습니다:", (res.stderr or state or "SSH 실패").strip().splitlines()[-1])
        return 0
    if state == "NO_TRAIN_ENV":
        print("  ! 학습 서버에 mount/config/train.env 가 없습니다 — 학습 서버 start.sh 를 먼저 실행하세요")
        return 0
    if state == "SET":
        print("  ✓ 학습 서버에 ClearML API 키가 이미 있음 — 건너뜀")
        return 0
    if check_only:
        print("  · 학습 서버 train.env 의 ClearML API 키가 비어 있음 (실행하면 발급해서 넣습니다)")
        return 0

    # 2) ClearML 로그인 → 키 발급
    base = f"http://{env.get('CLEARML_SERVER_IP') or 'localhost'}:{env.get('CLEARML_API_PORT', '8008')}"
    user, password = env.get("CLEARML_LOGIN_USER", ""), env.get("CLEARML_LOGIN_PASSWORD", "")
    if not user or not password:
        print("  ! .env 에 CLEARML_LOGIN_USER/PASSWORD 없음 — 건너뜀")
        return 0
    basic = base64.b64encode(f"{user}:{password}".encode()).decode()
    try:
        token = api(base, "auth.login", {"expiration_sec": 600}, {"Authorization": "Basic " + basic})["data"]["token"]
        cred = api(base, "auth.create_credentials", {"label": LABEL}, {"Authorization": "Bearer " + token})["data"]["credentials"]
        access, secret = cred["access_key"], cred["secret_key"]
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            print("  ! ClearML 로그인 실패(401) — 비밀번호를 바꿨다면 .env 의 CLEARML_LOGIN_PASSWORD 를 새 값으로 고치고 다시 실행하세요")
        else:
            print(f"  ! ClearML API 오류 {exc.code} — 건너뜀")
        return 0
    except (urllib.error.URLError, OSError, KeyError, ValueError) as exc:
        print(f"  ! ClearML 키 발급 실패: {exc}")
        return 0
    if not (SAFE.match(access) and SAFE.match(secret)):
        print("  ! 발급된 키에 예상 밖의 문자가 있어 train.env 에 쓰지 않습니다 — 웹에서 발급해 수동 등록하세요")
        return 0

    # 3) 학습 서버 train.env 에 기록 + apply (키는 표준입력으로 전달)
    write = (f"set -e; cd {root_q}; f=mount/config/train.env; read -r ACCESS; read -r SECRET; "
             "setv() { if grep -q \"^$1=\" \"$f\"; then sed -i \"s|^$1=.*|$1=$2|\" \"$f\"; else echo \"$1=$2\" >> \"$f\"; fi; }; "
             "setv CLEARML_API_ACCESS_KEY \"$ACCESS\"; setv CLEARML_API_SECRET_KEY \"$SECRET\"; "
             "./scripts/config.sh apply")
    res = ssh(env, write, stdin=f"{access}\n{secret}\n")
    if res.returncode != 0:
        print("  ! 학습 서버에 키를 쓰지 못했습니다:", (res.stderr or res.stdout).strip().splitlines()[-1:] or "알 수 없음")
        print("    (웹 Settings → Workspace 에서 발급해 학습 서버 ./scripts/config.sh setup-clearml 로 등록하세요)")
        return 0
    print(f"  ✓ ClearML API 키 발급({LABEL}, access {access[:4]}…) → 학습 서버 train.env 에 저장하고 config.sh apply 실행")
    return 0


if __name__ == "__main__":
    sys.exit(main())
