# MLOps Main Server

Intellivix MLOps 메인 서버입니다. ClearML, Data Studio, Seoul Studio, (선택) Grafana 모니터링을 운영합니다.

| 서버 | IP | 역할 |
|------|-----|------|
| **MLOPs서버** | - | ClearML UI, Data Studio, Grafana |
| **학습 서버** | - | 학습 Job 실행, Dataset NFS 제공 |

상세 운영 가이드: [`clearml/README.md`](clearml/README.md)

---

## 1. 실행 준비

**처음 세팅 절차는 [`clearml/README.md` 1장](clearml/README.md#1-빠른-시작--처음-세팅)에 단계별로 정리되어 있습니다.** 요약:

```bash
git clone http://172.16.8.64:1541/woals1626/mlops-mainserver.git
cd mlops-mainserver/clearml
cp .env.example .env
vi .env                # MLOPS_ROOT, CLEARML_SERVER_IP, TRAINING_SERVER_IP, TRAINING_SERVER_USER, TRAINING_ROOT
bash start.sh          # sudo 없이 실행
```

`start.sh` 가 학습 서버 SSH 가 안 되는 것을 발견하면 **학습 서버에서 실행할 내용(공개키)** 을 출력하고 기다립니다.
학습 서버에서 `bash start.sh` 를 실행한 뒤, MLOps 터미널로 돌아와 `1` 을 입력하면 나머지가 자동으로 진행됩니다.

| 순서 | 서버 | 할 일 |
|------|------|-------|
| 1 | MLOps | `.env` 작성 → `bash start.sh` (2단계에서 멈추면 안내를 따름) |
| 2 | 학습 | `train.env` 의 `MLOPS_SSH_PUBLIC_KEY` 에 안내된 공개키 입력 → `bash start.sh` |
| 3 | MLOps | "진행하셨나요?" 에 `1` → NFS 마운트, ClearML·Grafana 기동, 관리자 생성, 지표 수집까지 자동 |
| 4 | MLOps | 웹 첫 로그인(비밀번호 변경) → 학습 서버에 ClearML API 키 등록 |

`start.sh` 는 여러 번 실행해도 안전합니다. 옵션: `--no-mount`, `--no-monitoring`, `--no-remote-setup`, `--no-projects`.

### 접속 주소

| 서비스 | URL | 비고 |
|--------|-----|------|
| ClearML UI | `http://{CLEARML_SERVER_IP}:8080` | `.env` 참고 |
| Data Studio | `http://{CLEARML_SERVER_IP}:8080/data-studio/` | |
| Seoul Studio | `http://{CLEARML_SERVER_IP}:8080/seoul-studio/` | ComfyUI: `{TRAINING_SERVER_IP}:{COMFYUI_PORT}` |
| Grafana | `http://{MONITORING_SERVER_IP}:3000` | 선택 |

첫 로그인: `admin` / `clearml/.env` 의 `CLEARML_LOGIN_PASSWORD`. 로그인 후 비밀번호를 바꾸라는 화면이 나옵니다.

### IP·NFS 변경 후

```bash
vi /opt/clearml/.env
bash /opt/clearml/packaging/apply-env.sh --restart
```

---

## 2. 수정해야 할 파일

### 사용자가 직접 수정 — `.env` 하나면 됨

**경로:** `/opt/clearml/.env`  
**템플릿:** `/opt/clearml/.env.example`

| 항목 | `.env` 키 | 필수 | 설명 |
|------|-----------|------|------|
| MLOps 서버 IP | `CLEARML_SERVER_IP` | ✅ | ClearML·Seoul Studio·Grafana |
| 웹/API/파일 포트 | `CLEARML_WEB_PORT` 등 | ✅ | 기본 8080/8008/8081 |
| 학습·ComfyUI IP | `TRAINING_SERVER_IP` | ✅ | NFS + ComfyUI |
| ComfyUI 포트 | `COMFYUI_PORT` | ✅ | 기본 8188 |
| Dataset NFS | `TRAINING_DATASET_PATH`, `HOST_DATASET_PATH` | Data Studio | |
| 생성 영상 NFS | `TRAINING_GENERATED_PATH`, `MLOPS_GENERATED_MOUNT_PATH` | Seoul Studio | |
| ClearML UI 로그인 | `CLEARML_LOGIN_USER`, `CLEARML_LOGIN_PASSWORD` | 선택 | 비우면 `start.sh` 가 자동 생성 |
| Grafana 비밀번호 | `GRAFANA_ADMIN_PASSWORD` | Grafana 사용 시 | |
| Grafana용 API 키 | `CLEARML_ACCESS_KEY`, `CLEARML_SECRET_KEY` | Grafana 사용 시 | ClearML UI에서 발급 |

### 자동 생성 — 수정하지 않음

| 파일/키 | 생성 스크립트 | 설명 |
|---------|---------------|------|
| `CLEARML_TOKEN_SECRET`, `CLEARML_SESSION_SECRET` | `packaging/gen-secrets.sh` | 서버 고유 JWT 서명 |
| `config/apiserver.conf` | `packaging/gen-auth.sh` | 웹 UI 로그인 계정 |
| `CLEARML_WEB_HOST`, `SEOUL_STUDIO_COMFY_URL` 등 | `packaging/apply-env.sh` | IP에서 URL 자동 계산 |

### Grafana API 키 발급 (선택)

1. http://{MLOps IP}:8080 접속
2. 프로필 → **Settings → Workspace → Create new credentials**
3. `.env` 에 `CLEARML_ACCESS_KEY`, `CLEARML_SECRET_KEY` 입력
4. **`bash start.sh`** 재실행

## 디렉터리

```
/opt/
├── clearml/           # MLOps 스택 (설정·기동은 여기서)
│   ├── .env           ← 사용자가 수정하는 유일한 설정
│   ├── start.sh       ← 최초·재기동
│   └── monitoring/    ← Grafana (선택)
└── data_studio/       # Data Studio 빌드 소스
└── ComfyUI_seoul/     # Seoul Studio (ComfyUI 영상 생성) 빌드 소스
```

오프라인 서버 이관: [`clearml/packaging/README.md`](clearml/packaging/README.md)
