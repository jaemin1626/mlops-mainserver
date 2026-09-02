# ClearML MLOps Stack

Intellivix 브랜딩이 적용된 ClearML 서버 + Data Studio + Grafana 모니터링입니다.

---

## 구성

### ClearML 스택 (`docker-compose.yml`)

| 서비스 | 포트 | 설명 |
|--------|------|------|
| webserver | 8080 | ClearML UI, Data Studio 프록시 |
| apiserver | 8008 | REST API |
| fileserver | 8081 | 아티팩트 업/다운로드 |
| data-studio | (8080 하위) | `/data-studio/` |
| model-eval-console | 8090 | 모델 평가 콘솔 |
| mongo, elasticsearch, redis | 내부 | ClearML 백엔드 |

### 모니터링 스택 (`monitoring/`, 선택)

ClearML UI(8080)와 **별개**입니다. Grafana 운영 대시보드용입니다.

```
ClearML API (8008)
    → clearml-exporter (9090)
    → Prometheus (9091)
    → Grafana (3000)
```

| 서비스 | 포트 |
|--------|------|
| Grafana | 3000 |
| Prometheus | 9091 |
| clearml-exporter | 9090 |

아키텍처 상세: [`monitoring/architecture.md`](monitoring/architecture.md)

---

## 디렉터리

```
clearml/
├── .env                 # 통합 설정 (유일한 설정 파일)
├── .env.example         # 템플릿 (Git 추적)
├── start.sh             # 전체 기동 (마운트 + compose)
├── compose.sh           # docker compose 래퍼
├── monitoring-compose.sh
├── docker-compose.yml
├── config/              # apiserver.conf 등 (gen-auth.sh 생성)
├── branding/            # Intellivix UI 커스터마이징
├── mount/               # Dataset NFS 마운트 스크립트
├── monitoring/          # exporter, grafana, prometheus
├── model_eval_console/
└── packaging/           # pack.sh / install.sh (오프라인 이관)
```

---

## 설치 · 기동

### 최초 설정

```bash
cd /opt/clearml
cp .env.example .env
vi .env
```

`.env`에서 꼭 확인할 항목:

- `CLEARML_SERVER_IP` — 이 서버 IP (예: 172.16.4.82)
- `TRAINING_SERVER_IP`, `TRAINING_DATASET_PATH`, `HOST_DATASET_PATH` — Dataset NFS
- `GRAFANA_ADMIN_PASSWORD` — Grafana 비밀번호 (모니터링 사용 시)

### 한 번에 기동

```bash
bash start.sh
```

`start.sh` 순서:

1. Dataset NFS 마운트 (`mount/scripts/mount_dataset.sh`)
2. `.env` 준비 (`gen-secrets.sh`, `gen-auth.sh`, `apply-env.sh`)
3. `./compose.sh up -d`
4. Data Studio 재기동 (마운트 경로 반영)

Dataset 마운트 없이 ClearML만:

```bash
bash start.sh --no-mount
```

### 개별 제어

```bash
./compose.sh ps
./compose.sh logs -f webserver
./compose.sh up -d --force-recreate apiserver

./monitoring-compose.sh up -d
./monitoring-compose.sh ps
```

---

## `.env` 키 정리

| 키 | 누가 채움 | 용도 |
|----|-----------|------|
| `CLEARML_SERVER_IP`, 포트 | 사용자 | 서버 주소 |
| `CLEARML_TOKEN_SECRET`, `CLEARML_SESSION_SECRET` | `gen-secrets.sh` | JWT 서명 (서버 고유) |
| `CLEARML_LOGIN_USER/PASSWORD` | `gen-auth.sh` | 웹 UI 로그인 |
| `CLEARML_ACCESS_KEY`, `CLEARML_SECRET_KEY` | **수동** (ClearML UI) | Grafana exporter |
| `CLEARML_AGENT_*` | 선택 | agent-services 컨테이너 |
| `CLEARML_HOST_IP`, `CLEARML_WEB_HOST` 등 | `apply-env.sh` | IP에서 자동 계산 (직접 수정 X) |

ClearML UI → **Settings → Workspace → Create new credentials** 에서 API 키 발급 후 `.env`에 넣고:

```bash
./monitoring-compose.sh up -d --force-recreate clearml-exporter
```

---

## Dataset NFS (168 → 82)

168 학습 서버의 Dataset 폴더를 82에 마운트해 Data Studio에서 사용합니다.

```bash
bash mount/scripts/mount_dataset.sh mount    # 마운트
bash mount/scripts/mount_dataset.sh status   # 상태 확인
bash mount/scripts/mount_dataset.sh umount   # 해제
```

경로는 `.env`의 `TRAINING_*`, `HOST_DATASET_PATH` 를 따릅니다.

---

## Grafana 문제 해결

Grafana/Prometheus가 `permission denied`로 재시작 반복되면:

```bash
docker run --rm -v /opt/clearml/monitoring/data/grafana:/d alpine chown -R 472:472 /d
docker run --rm -v /opt/clearml/monitoring/data/prometheus:/d alpine chown -R 65534:65534 /d
./monitoring-compose.sh up -d --force-recreate
```

대시보드가 비어 있으면 exporter 로그에서 `401` 확인 → `.env`의 `CLEARML_ACCESS_KEY` / `CLEARML_SECRET_KEY` 점검.

---

## 오프라인 이관

다른 서버로 통째로 옮길 때:

```bash
bash packaging/pack.sh              # 번들 생성
# 대상 서버에서
bash packaging/install.sh
```

상세: [`packaging/README.md`](packaging/README.md)

---

## Git에 포함되지 않는 것

- `.env` — 서버별 비밀값
- `data/`, `logs/`, `agent/` — 런타임 데이터
- `config/apiserver.conf` — gen-auth.sh 생성
- `monitoring/data/` — Grafana DB, Prometheus TSDB
