#!/usr/bin/env python3
"""MLOps 서비스(Seoul Studio 의 학습 중 생성 차단, Grafana exporter)가 ClearML API 를 읽을 키를 발급해 .env 에 넣는다.

  .env 의 CLEARML_ACCESS_KEY / CLEARML_SECRET_KEY 가 이미 있으면 아무것도 하지 않는다.
  없으면 관리자 계정으로 로그인해 auth.create_credentials(라벨 mlops-services)로 발급하고 .env 에 저장한다.

사용법:
    python3 provision-service-credentials.py

  Seoul Studio 는 이 키가 없으면 학습 진행 여부를 확인할 수 없어 영상 생성을 막지 못한다.
  첫 로그인 후 비밀번호를 바꿨다면 로그인이 실패해 안내만 출력한다 (종료 코드 0).
  키 값은 화면에 출력하지 않는다(앞 4자리만).
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

LABEL = "mlops-services"


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


def api(base, endpoint, payload, headers):
    req = urllib.request.Request(f"{base}/{endpoint}", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def create_and_store(base, token, root):
    """token 으로 키를 발급해 .env 에 저장한다. (access 앞 4자리를 돌려준다)"""
    cred = api(base, "auth.create_credentials", {"label": LABEL}, {"Authorization": "Bearer " + token})["data"]["credentials"]
    access, secret = cred["access_key"], cred["secret_key"]
    subprocess.run([sys.executable, os.path.join(root, "packaging", "lib", "set_env.py"), os.path.join(root, ".env"),
                    f"CLEARML_ACCESS_KEY={access}", f"CLEARML_SECRET_KEY={secret}"],
                   check=True, capture_output=True)
    return access[:4]


def main():
    root = os.environ.get("CLEARML_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = {**load_env(os.path.join(root, ".env")), **os.environ}
    if env.get("CLEARML_ACCESS_KEY") and env.get("CLEARML_SECRET_KEY"):
        print("  ✓ .env 에 ClearML 서비스 키(CLEARML_ACCESS_KEY/SECRET_KEY)가 이미 있음 — 건너뜀")
        return 0
    base = f"http://{env.get('CLEARML_SERVER_IP') or 'localhost'}:{env.get('CLEARML_API_PORT', '8008')}"
    user, password = env.get("CLEARML_LOGIN_USER", ""), env.get("CLEARML_LOGIN_PASSWORD", "")
    if not user or not password:
        print("  ! .env 에 CLEARML_LOGIN_USER/PASSWORD 없음 — 서비스 키 발급 건너뜀")
        return 0
    basic = base64.b64encode(f"{user}:{password}".encode()).decode()
    try:
        token = api(base, "auth.login", {"expiration_sec": 600}, {"Authorization": "Basic " + basic})["data"]["token"]
        prefix = create_and_store(base, token, root)
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            print("  ! ClearML 로그인 실패(401) — 서비스 키를 발급하지 못했습니다. 웹 Settings > Workspace 에서 발급해")
            print("    .env 의 CLEARML_ACCESS_KEY / CLEARML_SECRET_KEY 에 넣고 start.sh 를 다시 실행하세요")
        else:
            print(f"  ! ClearML API 오류 {exc.code} — 건너뜀")
        return 0
    except (urllib.error.URLError, OSError, KeyError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"  ! 서비스 키 발급 실패: {exc}")
        return 0
    print(f"  ✓ ClearML 서비스 키 발급: 라벨 {LABEL}, access {prefix}… → .env 의 CLEARML_ACCESS_KEY / CLEARML_SECRET_KEY 에 저장")
    print("    (Seoul Studio 학습 중 생성 차단, Grafana exporter 가 이 키를 사용합니다)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
