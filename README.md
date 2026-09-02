# mlops-mainserver

Intellivix MLOps 메인 서버 구성 저장소입니다. ClearML 스택, Data Studio, Grafana 모니터링을 한 곳에서 관리합니다.

| 서버 | IP | 역할 |
|------|-----|------|
| **ai-server** | 172.16.4.82 | ClearML, Data Studio, Grafana |
| **aidev (학습)** | 172.16.4.168 | 학습 Job, Dataset NFS export |

---

## 저장소 구조

```
/opt/
├── clearml/                 # ClearML MLOps 스택 (메인)
│   ├── .env                 # 통합 설정 (gitignore, 서버마다 다름)
│   ├── start.sh             # 한 번에 기동
│   ├── compose.sh           # ClearML docker compose
│   ├── monitoring-compose.sh
│   ├── monitoring/          # Grafana · Prometheus · exporter
│   ├── mount/               # Dataset NFS 마운트
│   └── packaging/           # 오프라인 이관 (pack/install)
├── data_studio/             # Data Studio 빌드 컨텍스트
└── .gitignore
```

자세한 ClearML 운영 방법은 [`clearml/README.md`](clearml/README.md) 를 참고하세요.  
오프라인 서버 이관은 [`clearml/packaging/README.md`](clearml/packaging/README.md) 를 참고하세요.

---

## 빠른 시작 (82 서버)

```bash
cd /opt/clearml
cp .env.example .env
vi .env                    # IP, NFS 경로, 비밀번호 등 수정
bash start.sh              # Dataset 마운트 + ClearML + Data Studio 기동

# Grafana 모니터링 (선택)
./monitoring-compose.sh up -d
```

접속:

| 서비스 | URL |
|--------|-----|
| ClearML UI | http://172.16.4.82:8080 |
| Data Studio | http://172.16.4.82:8080/data-studio/ |
| Grafana | http://172.16.4.82:3000 |

---

## 설정 파일

**모든 설정은 `/opt/clearml/.env` 한 파일**에 있습니다.

| 구분 | 필수 여부 | 설명 |
|------|-----------|------|
| `CLEARML_SERVER_IP`, 포트 | 필수 | ClearML 웹/API 주소 |
| `TRAINING_SERVER_IP`, NFS 경로 | Data Studio용 | 168 Dataset 마운트 |
| `CLEARML_TOKEN_SECRET`, `CLEARML_SESSION_SECRET` | 자동 | `gen-secrets.sh` 가 생성 |
| `CLEARML_LOGIN_*` | 자동 | `gen-auth.sh` 가 생성 |
| `CLEARML_ACCESS_KEY`, `CLEARML_SECRET_KEY` | Grafana용 | ClearML UI에서 수동 발급 |
| `GRAFANA_ADMIN_*` | Grafana용 | 대시보드 로그인 |

주소를 바꾼 뒤:

```bash
bash packaging/apply-env.sh --restart
```

---

## Git

```bash
cd /opt
git add -A
git commit -m "설명"
git push origin main
```

원격: `http://172.16.8.64:1541/woals1626/mlops-mainserver.git`

**커밋하면 안 되는 것:** `.env`, `data/`, `logs/`, `monitoring/data/`, `config/apiserver.conf` (`.gitignore` 처리됨)

---

## 학습 서버 (168)

168에서는 이 저장소의 `.env`를 쓰지 않습니다. ClearML SDK 설정은 **168 로컬의 `clearml.conf`** 로 82 API(`8008`)에 연결합니다.
