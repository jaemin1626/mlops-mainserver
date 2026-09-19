# ClearML MLOps — 82 서버 운영 가이드

Intellivix 브랜딩 ClearML + Data Studio + (선택) Grafana MLOps 현황판입니다.

---

## 1. 빠른 시작 (82 서버)

### 1-1. 사전 조건

- Docker, Docker Compose v2 설치
- 코드 위치: `/opt/clearml`
- Data Studio Dataset: 168 NFS 마운트 가능해야 함

### 1-2. 환경 세팅 순서

```bash
cd /opt/clearml

# Step 1 — 설정 파일 준비
cp .env.example .env
vi .env                    # IP, NFS, (선택) Grafana 비밀번호

# Step 2 — 전체 기동 (.env 수정 후 이것만 실행)
bash start.sh
```

**Step 2 (`start.sh`) 내부 순서:**

```
① Dataset NFS 마운트       mount/scripts/mount_dataset.sh
② 생성형 결과 NFS 마운트   mount/scripts/mount_generated.sh
③ .env 자동 보완           gen-secrets.sh → gen-auth.sh → apply-env.sh
③ ClearML 기동           compose.sh up -d
④ Data Studio · Seoul Studio 재기동
⑤ Grafana 모니터링     monitoring-compose.sh up -d --force-recreate
```

`.env` 수정 후 **`bash start.sh` 만 실행**하면 ClearML·Grafana 모두 `.env` 가 반영됩니다.

마운트 없이 ClearML만:

```bash
bash start.sh --no-mount
```

Grafana 안 쓸 때:

```bash
bash start.sh --no-monitoring
```

**Step 3 — 접속 확인**

| 서비스 | URL |
|--------|-----|
| ClearML UI | http://172.16.4.82:8080 (`.env`의 IP) |
| Data Studio | http://172.16.4.82:8080/data-studio/ |
| Seoul Studio | http://172.16.4.82:8080/seoul-studio/ |
| 모델 평가 콘솔 | http://172.16.4.82:8090 |

로그인: `.env` 의 `CLEARML_LOGIN_USER` / `CLEARML_LOGIN_PASSWORD`  
(비워 두었으면 `start.sh` 가 생성 — 터미널 출력 또는 `grep CLEARML_LOGIN_ .env` 로 확인)

**Step 4 — Grafana API 키 (처음 한 번)**

ClearML UI → Settings → Create credentials → `.env` 에 `CLEARML_ACCESS_KEY` / `CLEARML_SECRET_KEY` 입력 후 **`bash start.sh`** 다시 실행.

Grafana: http://172.16.4.82:3000/d/clearml-mlops-main

### 1-3. 이후 `.env` 수정 후

```bash
cd /opt/clearml
vi .env
bash start.sh                    # 전체 반영 (Grafana 포함)
bash packaging/apply-env.sh --restart   # IP만 바꿀 때
```

---

## 2. 수정해야 할 파일

### ✅ 사용자가 수정하는 파일 — `.env` 하나

| 파일 | 역할 |
|------|------|
| **`/opt/clearml/.env`** | **유일한 사용자 설정 파일** (IP, NFS, 비밀번호, API 키) |
| `/opt/clearml/.env.example` | 템플릿 (복사용, 직접 수정 X) |

#### `.env`에서 직접 입력하는 항목

| 구분 | 키 | 필수 | 설명 |
|------|-----|------|------|
| MLOps 서버 IP | `CLEARML_SERVER_IP` | ✅ | ClearML·Seoul Studio·Grafana |
| 포트 | `CLEARML_WEB_PORT`, `CLEARML_API_PORT`, `CLEARML_FILES_PORT` | ✅ | 기본 8080 / 8008 / 8081 |
| 모니터링 IP | `MONITORING_SERVER_IP` | Grafana 사용 시 | 보통 `CLEARML_SERVER_IP` 와 동일 |
| 학습·ComfyUI IP | `TRAINING_SERVER_IP` | ✅ | Dataset NFS · ComfyUI |
| ComfyUI 포트 | `COMFYUI_PORT` | ✅ | 기본 8188 |
| Dataset NFS | `TRAINING_DATASET_PATH`, `HOST_DATASET_PATH` | Data Studio | |
| 생성형 영상 NFS | `TRAINING_GENERATED_PATH`, `MLOPS_GENERATED_MOUNT_PATH` | Seoul Studio | |
| UI 로그인 | `CLEARML_LOGIN_USER`, `CLEARML_LOGIN_PASSWORD` | 선택 | 비우면 자동 생성 |
| Grafana | `GRAFANA_ADMIN_PASSWORD` | Grafana 사용 시 | |
| Grafana exporter | `CLEARML_ACCESS_KEY`, `CLEARML_SECRET_KEY` | Grafana 사용 시 | ClearML UI에서 발급 |

#### `.env`에서 건드리지 않는 항목 (자동)

| 키 | 누가 채움 |
|----|-----------|
| `CLEARML_TOKEN_SECRET`, `CLEARML_SESSION_SECRET` | `gen-secrets.sh` |
| `CLEARML_HOST_IP`, `CLEARML_WEB_HOST`, `SEOUL_STUDIO_COMFY_URL` 등 | `apply-env.sh` |

### ❌ 직접 수정하지 않는 파일

| 파일 | 설명 |
|------|------|
| `config/apiserver.conf` | `gen-auth.sh` 가 `.env` 기준으로 생성 |
| `monitoring/docker-compose.yml` | 기본값 그대로 사용 |
| `docker-compose.yml` | 기본값 그대로 사용 |
| `monitoring/data/` | Grafana·Prometheus 런타임 데이터 |

### 168 학습 서버

82의 `.env`를 **사용하지 않습니다.**  
168 로컬 `~/clearml.conf` (또는 프로젝트 `clearml.conf`)로 82 API에 연결합니다.

---

## 3. 구성 요약

### ClearML 스택 (`compose.sh`)

| 서비스 | 포트 | 용도 |
|--------|------|------|
| webserver | 8080 | ClearML UI, Data Studio |
| apiserver | 8008 | API (학습·exporter 연결) |
| fileserver | 8081 | 아티팩트 |
| data-studio | 8080 하위 | `/data-studio/` |
| model-eval-console | 8090 | 모델 평가 |

### Grafana (선택, `monitoring-compose.sh`)

| 보여 주는 것 | 보여 주지 않는 것 |
|-------------|------------------|
| 학습 횟수, 소요 시간, 진행 중 epoch | epoch별 train/valid **loss 곡선** |
| 버전별 mAP, Valid mA (최종값) | ClearML Scalars와 동일한 상세 차트 |
| 데이터셋·태깅·프로젝트 현황 | |

상세: [`monitoring/architecture.md`](monitoring/architecture.md)

---

## 4. Dataset · 생성형 결과 NFS (168 → 82)

| 용도 | `.env` 키 (168 경로) | `.env` 키 (82 마운트) |
|------|---------------------|----------------------|
| Dataset (Data Studio) | `TRAINING_DATASET_PATH` | `HOST_DATASET_PATH` |
| 생성형 영상 (Seoul Studio) | `TRAINING_GENERATED_PATH` | `MLOPS_GENERATED_MOUNT_PATH` |

```bash
bash mount/scripts/mount_dataset.sh mount
bash mount/scripts/mount_generated.sh mount
bash mount/scripts/mount_generated.sh status
```

Seoul Studio 생성 영상은 `MLOPS_GENERATED_MOUNT_PATH` (`/home/intellivix/train/ComfyUI/generate_datasets`)에 저장됩니다.

### ComfyUI 생성 서버 (Seoul Studio 의존)

Seoul Studio는 **`TRAINING_SERVER_IP`:`COMFYUI_PORT`** ComfyUI에 HTTP로 작업을 보냅니다. 해당 서버에서 ComfyUI가 떠 있어야 생성이 됩니다.

| 항목 | `.env` |
|------|--------|
| 서버 IP | `TRAINING_SERVER_IP` |
| 포트 | `COMFYUI_PORT` (기본 8188) |
| 접속 URL (자동) | `SEOUL_STUDIO_COMFY_URL` ← apply-env 가 계산 |
| repo | `/home/intellivix/train` |
| ComfyUI main | `/home/intellivix/train/ComfyUI/runtime/ComfyUI/main.py` |
| venv | `/home/intellivix/train/ComfyUI/runtime/venv/bin/python` |
| 생성 출력 | `/home/intellivix/train/ComfyUI/generate_datasets/` |
| 포트 | `8188` (`0.0.0.0` listen, Dockerfile CMD) |

**81 서버에서 기동 (Docker Compose):**

```bash
cd /home/intellivix/train
./scripts/config.sh apply
./scripts/comfy.sh build    # 최초 1회
./scripts/comfy.sh up       # 백그라운드 실행
./scripts/comfy.sh status
```

**82에서 연결 확인:**

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' ${SEOUL_STUDIO_COMFY_URL}/
# 200 또는 404 → OK / 000 또는 connection refused → 81에서 comfy.sh up 필요
```

---

## 5. 자주 쓰는 명령

```bash
cd /opt/clearml

./compose.sh ps
./compose.sh logs -f webserver
./compose.sh up -d --force-recreate apiserver

./monitoring-compose.sh ps
./monitoring-compose.sh logs -f clearml-exporter
```

---

## 6. 문제 해결

**Grafana/Prometheus 재시작 반복 (permission denied)**

```bash
docker run --rm -v /opt/clearml/monitoring/data/grafana:/d alpine chown -R 472:472 /d
docker run --rm -v /opt/clearml/monitoring/data/prometheus:/d alpine chown -R 65534:65534 /d
./monitoring-compose.sh up -d --force-recreate
```

**Grafana 대시board 비어 있음**

- exporter 로그: `docker logs clearml-exporter`
- `401` → `.env` 의 `CLEARML_ACCESS_KEY` / `CLEARML_SECRET_KEY` 확인

**Dataset 마운트 실패**

- `.env` 의 `TRAINING_SERVER_IP`, `TRAINING_DATASET_PATH` 확인
- 81 NFS export 및 방화벽 확인

**Seoul Studio — "생성 서버에 연결할 수 없습니다"**

- 82 설정 문제가 아니라 **81 ComfyUI 미기동**인 경우가 대부분
- 81: `./scripts/comfy.sh status` → `up` 필요
- MLOps 서버: `curl ${SEOUL_STUDIO_COMFY_URL}/` 로 확인 (`connection refused` = ComfyUI 꺼짐)
- `.env` 의 `TRAINING_SERVER_IP` / `COMFYUI_PORT` 변경 후 `bash start.sh` 실행

---

## 7. 다른 서버로 이관

```bash
bash packaging/pack.sh
# 대상 서버에서 packaging/install.sh
```

상세: [`packaging/README.md`](packaging/README.md)

## SSH 원격 학습·테스트

`.env`의 `TRAINING_SSH_*`로 전용 SSH 클라이언트를 설정합니다. 접속 대상(`TRAINING_SSH_HOST`)은
`TRAINING_SERVER_IP`를 그대로 따르고, `TRAINING_SSH_USER`는 **학습 서버의 로그인 계정**입니다.

### 가장 쉬운 방법 (자동)

`.env`만 채우고 터미널에서 `bash start.sh` 를 실행합니다. 학습 서버 쪽 작업이 필요하면 물어보고 SSH 로 대신 합니다.

- 키가 학습 서버에 등록되어 있지 않으면 → 공개키 자동 등록을 제안합니다 (학습 서버 비밀번호 1회)
- 학습 서버 NFS(2049)가 열려 있지 않으면 → `train.env` 값을 채우고 `export_dataset.sh setup` 을 SSH 로 실행하도록 제안합니다 (sudo 비밀번호 입력)
- 학습 서버 작업을 원하지 않으면 `bash start.sh --no-remote-setup`. 단독 실행은 `bash packaging/bootstrap-training-server.sh key|nfs|all [--dry-run]`

### 수동으로 하는 순서

| 순서 | 서버 | 할 일 | 확인 |
|---|---|---|---|
| 1 | MLOps | `.env` 작성 후 `bash packaging/gen-ssh-key.sh` — 공개키 한 줄 출력 | 지문: `ssh-keygen -lf ssh/id_ed25519.pub` |
| 2 | 학습 | `train.env`의 `MLOPS_SSH_PUBLIC_KEY`에 그 줄 입력 → `install-key`, `export_dataset.sh setup` | **`ssh-keygen -lf ~/.ssh/authorized_keys` 에 1번의 지문이 있어야 함** |
| 3 | MLOps | `ssh-keyscan -p <포트> -H <학습서버IP> >> ssh/known_hosts` | `ssh-keygen -lf ssh/known_hosts` |
| 4 | MLOps | `bash start.sh` — SSH 접속을 시험하고, 실패하면 조치 명령을 출력 | `bash training-ssh.sh doctor` |
| 5 | MLOps | `./compose.sh --profile training-ssh up -d` — 지표 수집(`training-metrics`) 시작 | 대시보드 `TRAINING SERVER` 헤더 |

- `train.env`에 키를 적는 것과 `authorized_keys`에 들어가는 것은 별개입니다. 2번 확인을 건너뛰면
  `Permission denied (publickey,password)` 로 막힙니다. `install-key`가 등록하지 못하면
  `echo '<공개키 한 줄>' >> ~/.ssh/authorized_keys` 로 직접 덧붙이세요(`.ssh` 700, `authorized_keys` 600).
- `sudo bash start.sh` 나 `sudo bash training-ssh.sh` 로 실행하지 마세요. 키 소유자와 컨테이너 UID 가 어긋납니다.
  `start.sh`가 키 소유자에 맞춰 `TRAINING_SSH_UID/GID`를 설정하며, 값이 바뀌면
  `bash compose.sh --profile training-ssh build training-ssh`로 이미지를 다시 빌드합니다.

학습은 `doctor` 대신 `detector` 또는 `vlm`을 지정합니다.
키 인증, 상태·로그 조회, 테스트 경로 설정은 [SSH 실행 가이드](training_ssh/README.md)를 참고하세요.
