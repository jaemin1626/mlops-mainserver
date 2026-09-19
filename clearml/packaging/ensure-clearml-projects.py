#!/usr/bin/env python3
"""ClearML 기본 프로젝트(Dataset, Detector, VLM)가 없으면 만든다. 이미 있으면 건드리지 않는다.

사용법:
    python3 ensure-clearml-projects.py [--dry-run]

.env 에서 읽는 값:
    CLEARML_SERVER_IP + CLEARML_API_PORT                       API 주소
    CLEARML_LOGIN_USER / CLEARML_LOGIN_PASSWORD                로그인 계정
    CLEARML_DEFAULT_PROJECTS                                   쉼표로 구분한 프로젝트 이름 (기본: Dataset,Detector,VLM)

첫 로그인 후 비밀번호를 바꿔서 .env 값과 달라졌다면 인증에 실패하고 안내만 출력한다 (종료 코드 0).
표준 라이브러리만 사용한다.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_PROJECTS = "Dataset,Detector,VLM"

# 프로젝트 Overview 에 표시되는 설명. 여기에 없는 이름은 설명 없이 만든다.
DESCRIPTIONS = {
    "Detector": "Detector (Vision Analysis Model)\n\n"
                "영상 속 객체를 빠르고 정밀하게 탐지하여 위치와 종류를 분석하는 비전 AI 모델",
    "VLM": "VLM (Vision Language Model)\n\n"
           "영상의 장면과 행동, 상황적 맥락을 종합적으로 이해하고 자연어로 해석하는 멀티모달 AI 모델",
}
# 이전 버전이 만들던 설명 — 이 값(또는 빈 값)일 때만 새 설명으로 바꾼다 (사용자가 직접 고친 설명은 건드리지 않음)
OLD_DEFAULT_DESCRIPTIONS = {"", "기본 프로젝트 (start.sh 로 생성)"}


def load_env(path):
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
                val = val[1:-1]
            values[key.strip()] = val
    return values


def call(api, endpoint, payload, headers):
    req = urllib.request.Request(
        f"{api}/{endpoint}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **headers},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp), resp


def main():
    dry_run = "--dry-run" in sys.argv[1:]
    root = os.environ.get("CLEARML_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = {**load_env(os.path.join(root, ".env")), **os.environ}

    # CLEARML_API_HOST 는 컨테이너 안에서 쓰는 주소(host.docker.internal)일 수 있어 쓰지 않는다
    api = "http://{}:{}".format(
        env.get("CLEARML_SERVER_IP") or env.get("CLEARML_HOST_IP") or "localhost",
        env.get("CLEARML_API_PORT", "8008"),
    )
    user, password = env.get("CLEARML_LOGIN_USER", ""), env.get("CLEARML_LOGIN_PASSWORD", "")
    names = [n.strip() for n in env.get("CLEARML_DEFAULT_PROJECTS", DEFAULT_PROJECTS).split(",") if n.strip()]

    if not user or not password:
        print("  ! .env 에 CLEARML_LOGIN_USER / CLEARML_LOGIN_PASSWORD 없음 — 프로젝트 생성 건너뜀")
        return 0

    basic = base64.b64encode(f"{user}:{password}".encode()).decode()
    try:
        data, resp = call(api, "auth.login", {"expiration_sec": 600}, {"Authorization": "Basic " + basic})
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            print(f"  ! ClearML 로그인 실패(401) — 비밀번호를 바꿨다면 .env 의 CLEARML_LOGIN_PASSWORD 를 새 값으로 고치거나,")
            print("    웹 화면에서 직접 프로젝트를 만드세요: " + ", ".join(names))
            return 0
        print(f"  ! ClearML API 오류 {exc.code} — 건너뜀")
        return 0
    except (urllib.error.URLError, OSError) as exc:
        print(f"  ! ClearML API({api}) 에 연결할 수 없음: {exc} — 건너뜀")
        return 0

    token = (data.get("data") or {}).get("token") or ""
    if not token:
        cookie = resp.headers.get("Set-Cookie", "")
        token = cookie.split("clearml_token_basic=", 1)[-1].split(";", 1)[0] if "clearml_token_basic=" in cookie else ""
    if not token:
        print("  ! 로그인 토큰을 받지 못했습니다 — 건너뜀")
        return 0
    auth = {"Authorization": "Bearer " + token}

    existing = {
        p["name"]: p
        for p in call(api, "projects.get_all", {"only_fields": ["name", "description"]}, auth)[0]["data"]["projects"]
    }
    for name in names:
        wanted = DESCRIPTIONS.get(name, "")
        if name not in existing:
            if dry_run:
                print(f"  · [dry-run] 만들 프로젝트: {name}")
            else:
                payload = {"name": name}
                if wanted:
                    payload["description"] = wanted
                call(api, "projects.create", payload, auth)
                print(f"  ✓ 프로젝트 생성: {name}")
        elif (existing[name].get("description") or "") != wanted \
                and (existing[name].get("description") or "") in OLD_DEFAULT_DESCRIPTIONS:
            if dry_run:
                print(f"  · [dry-run] 설명 갱신: {name}")
            else:
                call(api, "projects.update", {"project": existing[name]["id"], "description": wanted}, auth)
                print(f"  ✓ 프로젝트 설명 갱신: {name}")
        else:
            print(f"  ✓ 프로젝트 있음: {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
