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
① Dataset NFS 마운트     mount/scripts/mount_dataset.sh
② .env 자동 보완         gen-secrets.sh → gen-auth.sh → apply-env.sh
③ ClearML 기동           compose.sh up -d
④ Data Studio 재기동     마운트 경로 반영
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
| 서버 주소 | `CLEARML_SERVER_IP` | ✅ | 82 IP (예: 172.16.4.82) |
| 포트 | `CLEARML_WEB_PORT`, `CLEARML_API_PORT`, `CLEARML_FILES_PORT` | ✅ | 기본 8080 / 8008 / 8081 |
| 모니터링 IP | `MONITORING_SERVER_IP` | Grafana 사용 시 | 보통 `CLEARML_SERVER_IP` 와 동일 |
| Dataset NFS | `TRAINING_SERVER_IP`, `TRAINING_SERVER_USER`, `TRAINING_DATASET_PATH` | Data Studio | 168 쪽 경로 |
| Dataset 로컬 | `HOST_DATASET_PATH` | Data Studio | 82 마운트 지점 |
| UI 로그인 | `CLEARML_LOGIN_USER`, `CLEARML_LOGIN_PASSWORD` | 선택 | 비우면 자동 생성 |
| Grafana | `GRAFANA_ADMIN_PASSWORD` | Grafana 사용 시 | |
| Grafana exporter | `CLEARML_ACCESS_KEY`, `CLEARML_SECRET_KEY` | Grafana 사용 시 | ClearML UI에서 발급 |

#### `.env`에서 건드리지 않는 항목 (자동)

| 키 | 누가 채움 |
|----|-----------|
| `CLEARML_TOKEN_SECRET`, `CLEARML_SESSION_SECRET` | `gen-secrets.sh` |
| `CLEARML_HOST_IP`, `CLEARML_WEB_HOST`, `CLEARML_API_HOST` 등 | `apply-env.sh` |

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

## 4. Dataset NFS (168 → 82)

`.env` 의 NFS 설정을 따릅니다.

```bash
bash mount/scripts/mount_dataset.sh mount
bash mount/scripts/mount_dataset.sh status
bash mount/scripts/mount_dataset.sh umount
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
- 168 NFS export 및 방화벽 확인

---

## 7. 다른 서버로 이관

```bash
bash packaging/pack.sh
# 대상 서버에서 packaging/install.sh
```

상세: [`packaging/README.md`](packaging/README.md)
