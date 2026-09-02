# MLOps Main Server

Intellivix MLOps 메인 서버입니다. **82(ai-server)** 에 ClearML, Data Studio, (선택) Grafana 모니터링을 운영합니다.

| 서버 | IP | 역할 |
|------|-----|------|
| **MLOPs서버** | - | ClearML UI, Data Studio, Grafana |
| **학습 서버** | - | 학습 Job 실행, Dataset NFS 제공 |

상세 운영 가이드: [`clearml/README.md`](clearml/README.md)

---

## 1. 실행 준비

### 환경 세팅 순서

```bash
# ① 설정 파일 만들기
cd /opt/clearml
cp .env.example .env
vi .env                          # 아래 "수정해야 할 파일" 참고

# ② 한 번에 기동 (권장)
bash start.sh
```

`start.sh` 가 순서대로 처리합니다:

| 순서 | 내용 |
|------|------|
| 1 | 168 Dataset NFS 마운트 |
| 2 | 서명 키·로그인 계정 생성 + URL 파생 값 반영 |
| 3 | ClearML docker compose 기동 |
| 4 | Data Studio 재기동 (마운트 경로 반영) |
| 5 | Grafana 모니터링 (`.env` 반영) |

`.env` 수정 후 **`bash start.sh`** 만 실행하면 됩니다.

Dataset 마운트 없이: `bash start.sh --no-mount`  
Grafana 안 쓸 때: `bash start.sh --no-monitoring`

### Grafana API 키

ClearML UI에서 credentials 발급 → `.env`에 넣기 → **`bash start.sh`** 재실행.

> train/valid loss 곡선은 **ClearML UI(8080)** 에서 봅니다. Grafana는 요약·현황용입니다.

### 접속 주소

| 서비스 | URL | 비고 |
|--------|-----|------|
| ClearML UI | http://172.16.4.82:8080 | 실험·학습 로그 |
| Data Studio | http://172.16.4.82:8080/data-studio/ | Dataset 라벨링 |
| Grafana | http://172.16.4.82:3000 | 선택, MLOps 현황 |

로그인 계정·비밀번호는 `start.sh` 실행 후 터미널 출력 또는 `/opt/clearml/.env` 의 `CLEARML_LOGIN_*` 를 확인하세요.

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
| ClearML 서버 IP | `CLEARML_SERVER_IP` | ✅ | 82 IP |
| 웹/API/파일 포트 | `CLEARML_WEB_PORT` 등 | ✅ | 기본 8080/8008/8081 |
| Dataset NFS    | `TRAINING_SERVER_IP`, `TRAINING_DATASET_PATH` | Data Studio용 | 168 경로 |
| Dataset 로컬 마운트 | `HOST_DATASET_PATH` | Data Studio용 | 기본 `/opt/clearml/data/datasets` |
| ClearML UI 로그인 | `CLEARML_LOGIN_USER`, `CLEARML_LOGIN_PASSWORD` | 선택 | 비우면 `start.sh` 가 자동 생성 |
| Grafana 비밀번호 | `GRAFANA_ADMIN_PASSWORD` | Grafana 사용 시 | |
| Grafana용 API 키 | `CLEARML_ACCESS_KEY`, `CLEARML_SECRET_KEY` | Grafana 사용 시 | ClearML UI에서 발급 |

### 자동 생성 — 수정하지 않음

| 파일/키 | 생성 스크립트 | 설명 |
|---------|---------------|------|
| `CLEARML_TOKEN_SECRET`, `CLEARML_SESSION_SECRET` | `packaging/gen-secrets.sh` | 서버 고유 JWT 서명 |
| `config/apiserver.conf` | `packaging/gen-auth.sh` | 웹 UI 로그인 계정 |
| `CLEARML_WEB_HOST`, `CLEARML_API_HOST` 등 | `packaging/apply-env.sh` | IP에서 URL 자동 계산 |

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
```

오프라인 서버 이관: [`clearml/packaging/README.md`](clearml/packaging/README.md)
