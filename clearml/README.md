# ClearML MLOps — 운영 가이드

Intellivix 브랜딩 ClearML + Data Studio + (선택) Grafana MLOps 현황판입니다.

---

## 1. 빠른 시작 — 처음 세팅

두 서버가 함께 세팅됩니다. **MLOps 서버**(이 저장소, ClearML·Data Studio·Grafana)와 **학습 서버**(별도 저장소, 학습 실행·Dataset NFS 제공)입니다.
사용자가 하는 일은 **① MLOps `.env` 작성 → ② MLOps `bash start.sh` → ③ (안내가 나오면) 학습 서버에서 `bash start.sh` → ④ MLOps에서 `1` 입력** 입니다.

### 1-1. 사전 조건

| 서버 | 필요한 것 |
|------|-----------|
| MLOps | Docker, Docker Compose v2, `python3`, `sudo` 가능한 계정, 이 저장소를 `git clone` 한 상태 |
| 학습 서버 | 학습 서버 저장소가 이미 있고 그 안에 `start.sh` 가 있어야 함 (NFS export·SSH 허용을 그 스크립트가 처리) |
| 네트워크 | MLOps → 학습 서버 SSH(22), NFS(2049) 접근 가능 |

> **`sudo bash start.sh` 로 실행하지 마세요.** 필요한 곳에서 스크립트가 스스로 sudo 를 씁니다. 전체를 sudo 로 돌리면 SSH 키·`.env` 소유자가 root 가 되어 컨테이너가 읽지 못합니다.
> git 명령에도 sudo 를 붙이지 마세요 (`.git` 소유자가 root 로 바뀌어 커밋이 안 됩니다).

### 1-2. 처음 세팅 순서 (전체 흐름)

```
[MLOps]  ① git clone → .env 작성
[MLOps]  ② bash start.sh
            └ 2단계에서 학습 서버 SSH 가 안 되면 멈추고 "학습 서버에서 실행할 내용"을 출력
[학습]   ③ 출력된 공개키를 train.env 에 넣고 bash start.sh
[MLOps]  ④ "진행하셨나요?" 에 1 입력 → 나머지 자동 진행
[MLOps]  ⑤ 접속 확인 · 첫 로그인 · 후속 설정
```

#### ① 저장소 받기 + `.env` 작성 (MLOps)

```bash
cd ~
git clone http://172.16.8.64:1541/woals1626/mlops-mainserver.git
cd mlops-mainserver/clearml
cp .env.example .env
vi .env
```

`.env` 에서 **반드시 확인할 값**:

| 키 | 의미 | 주의 |
|----|------|------|
| `MLOPS_ROOT` | 이 저장소의 위치 | 실제 clone 위치와 **같아야 함**. 다르면 `start.sh` 가 에러로 멈춤. 아래 경로들이 여기서 자동 계산됨 |
| `CLEARML_SERVER_IP` | MLOps 서버 IP | |
| `TRAINING_SERVER_IP` | 학습 서버 IP | SSH 접속 대상(`TRAINING_SSH_HOST`)도 이 값을 따름 |
| `TRAINING_SERVER_USER` | 학습 서버의 로그인 계정 | SSH 계정(`TRAINING_SSH_USER`)도 이 값을 따름. **MLOps 쪽 계정이 아님** |
| `TRAINING_ROOT` | 학습 서버 저장소 루트 | Dataset·생성 영상 경로(`TRAINING_DATASET_PATH` 등)와 SSH 작업 경로가 여기서 자동 계산됨 |

나머지(포트, Grafana, 에이전트 키 등)는 기본값으로 두어도 됩니다. 서명 키·로그인 비밀번호·URL 파생값은 `start.sh` 가 채웁니다.

#### ② `start.sh` 실행 (MLOps)

```bash
bash start.sh
```

화면에 단계가 순서대로 나옵니다. 각 단계가 하는 일:

| 단계 | 내용 |
|------|------|
| 1/6 환경 설정 | `.env` 준비, 서명 키(`CLEARML_TOKEN_SECRET`·`SESSION_SECRET`)·로그인 비밀번호 생성, 파생 URL 반영. `MLOPS_ROOT` 가 실제 위치와 다르면 여기서 중단 |
| 2/6 학습 서버 SSH 키 | SSH 키 생성, 학습 서버 호스트 키를 `ssh/known_hosts` 에 등록, **접속 시험**. 안 되면 → ③ 으로 (아래) |
| 3/6 NFS mount | 학습 서버의 Dataset·생성 영상 폴더를 이 서버에 마운트 (sudo 비밀번호를 물으면 이 서버 계정 비밀번호) |
| 4/6 compose up | 폴더 권한 정리 → ClearML 기동 → 초기 관리자 계정 생성 → 웹서버 재시작 → 학습 서버 지표 수집(`training-metrics`) 기동 |
| 5/6 | Data Studio · Seoul Studio 재기동 (마운트 경로 반영) |
| 6/6 Grafana | 모니터링 스택 기동 |

> 처음에는 `apiserver ... Error` 같은 **빨간 줄이 나올 수 있는데 정상**입니다. 직접 빌드하는 이미지를 Docker Hub 에서 먼저 받으려다 실패하고, 이어서 이 서버에서 빌드하는 순서입니다. 첫 빌드는 시간이 걸립니다.

#### ③ 학습 서버 세팅 (2/6 단계에서 멈췄을 때)

학습 서버가 이 MLOps 서버의 SSH 키를 모르면 `start.sh` 가 이렇게 출력하고 기다립니다.

```
다음은 학습 서버(ailab13@172.16.4.113)에서 실행하세요:
  1) mount/config/train.env 의 MLOPS_SSH_PUBLIC_KEY 를 아래 한 줄로 입력 (이미 다른 키가 있으면 교체)
       ssh-ed25519 AAAA... mlops-aidev-168
  2) bash start.sh
학습 서버에서 위 내용을 진행하셨나요? [1=예 / 0=아니오(종료)] >
```

**이 터미널은 닫지 말고 그대로 두고**, 학습 서버에서 다음을 합니다.

1. 학습 서버(`TRAINING_SERVER_USER` 계정)에 로그인해 저장소 폴더(`TRAINING_ROOT`)로 이동합니다.
2. `mount/config/train.env` 의 `MLOPS_SSH_PUBLIC_KEY=` 값을 출력된 공개키 **한 줄**로 넣습니다. 앞뒤가 잘리거나 줄바꿈이 들어가면 안 됩니다. (이미 다른 키가 들어 있으면 **교체**합니다. 저장소를 다시 clone 하면 키가 새로 만들어지므로 옛 키가 남아 있는 경우가 많습니다.)
3. `bash start.sh` 를 실행합니다.
   - MLOps 서버 IP 와 루트 경로를 물으면 MLOps `.env` 의 `CLEARML_SERVER_IP`, `MLOPS_ROOT` 와 **같은 값**을 입력합니다.
   - 공개키 등록, SSH 허용, NFS export 가 진행됩니다. sudo 비밀번호를 한 번 입력합니다.
   - "학습 서버 세팅 완료"가 나오면 끝입니다. 그 아래에 "다음은 MLOps 서버에서 실행하세요: ssh-keyscan ..." 이라고 나와도 **직접 입력하지 않아도 됩니다.** ④ 에서 MLOps `start.sh` 가 같은 일을 대신 합니다.

> 6단계의 "ClearML API 키가 없어 건너뜁니다" 는 나중 일입니다 (1-4 참고).

#### ④ MLOps 로 돌아와서 `1` 입력

`1` 을 입력하면 MLOps `start.sh` 가 이렇게 자동 실행합니다.

```
ssh-keyscan -p 22 -H <학습서버IP> >> ssh/known_hosts      # 이미 등록됐으면 생략
ssh -o BatchMode=yes -p 22 <계정>@<학습서버IP> true && echo SSH_OK
```

- **접속 성공**: `SSH_OK` 표시 후 3/6 부터 끝까지 자동 진행됩니다.
- **아직 접속 안 됨**: "아직 접속되지 않습니다" 가 나오고 같은 질문이 다시 나옵니다. 학습 서버 세팅을 확인한 뒤 다시 `1` 을 누르세요. 원인은 아래 6장(문제 해결)을 참고하세요.
- `0` 을 입력하면 종료됩니다. 학습 서버를 세팅한 뒤 `bash start.sh` 를 다시 실행하면 됩니다 (이미 한 단계는 건너뜀).
- 터미널이 없는 환경(자동 실행)이나 `--no-remote-setup` 이면 기다리지 않고 진행하고, SSH 는 나중에 연결합니다.

#### ⑤ 끝난 뒤

`start.sh` 마지막에 접속 주소가 출력됩니다.

| 서비스 | URL |
|--------|-----|
| ClearML UI | `http://{CLEARML_SERVER_IP}:8080` |
| Data Studio | `http://{CLEARML_SERVER_IP}:8080/data-studio/` |
| Seoul Studio | `http://{CLEARML_SERVER_IP}:8080/seoul-studio/` |
| 모델 평가 콘솔 | `http://{CLEARML_SERVER_IP}:8090` |
| Grafana | `http://{CLEARML_SERVER_IP}:3000/d/clearml-mlops-main` |

**첫 로그인**

1. `http://{CLEARML_SERVER_IP}:8080` 접속 → `admin` / `.env` 의 `CLEARML_LOGIN_PASSWORD` (`grep CLEARML_LOGIN_ .env`)
2. **첫 로그인 후 비밀번호를 바꾸라는 화면**이 나옵니다. 이 비밀번호는 임시값입니다. 바꾼 뒤에는 `.env` 의 값과 달라집니다.
3. 계정 추가·권한은 관리자 화면(Administration)에서 합니다. 이 서버의 계정 정보는 `access-control` DB 에 있으며, 저장소에는 올라가지 않습니다.

**정상 동작 확인**

| 확인 | 명령 / 화면 |
|------|-------------|
| 컨테이너 | `./compose.sh ps` — 모두 `Up` (`clearml-agent-services` 는 에이전트 키가 없으면 종료되어 있을 수 있음) |
| 학습 서버 SSH | `bash training-ssh.sh doctor` |
| NFS | `mount | grep <학습서버IP>` — Dataset, generate_datasets 2개 |
| 대시보드 | `/dashboard` 상단이 `TRAINING SERVER · <학습서버IP>` + `LIVE · 5초마다 갱신` |

### 1-3. `start.sh` 옵션

```bash
bash start.sh                     # 전체
bash start.sh --no-mount          # NFS 마운트 생략
bash start.sh --no-monitoring     # Grafana 생략
bash start.sh --no-remote-setup   # 학습 서버 SSH 확인에서 기다리지 않고 진행
bash start.sh --no-projects       # 기본 프로젝트(Dataset·Detector·VLM) 생성 생략
```

`start.sh` 는 **여러 번 실행해도 안전**합니다. 이미 있는 키·계정·마운트는 건드리지 않습니다.

### 1-4. 처음 세팅 후 해야 할 일

| 일 | 방법 |
|----|------|
| **학습 Task 를 ClearML 에 연결** | MLOps 웹 → 프로필 → Settings → Workspace → Create new credentials 로 키 발급 → 학습 서버에서 `./scripts/config.sh setup-clearml` 로 등록. 등록 전에는 학습 결과(Task)가 대시보드에 나오지 않음 |
| 기본 프로젝트 만들기 | 웹에서 `NEW PROJECT` 로 `Dataset`, `Detector`, `VLM` 생성. 또는 `.env` 의 `CLEARML_LOGIN_PASSWORD` 를 **현재 비밀번호로 고친 뒤** `python3 packaging/ensure-clearml-projects.py` |
| Grafana 연동(선택) | 위와 같이 키를 발급해 `.env` 의 `CLEARML_ACCESS_KEY` / `CLEARML_SECRET_KEY` 에 넣고 `bash start.sh` 다시 실행 |
| 재부팅 후 | 컨테이너는 자동으로 다시 뜨지만 **NFS 마운트는 자동으로 붙지 않음** (`/etc/fstab` 미설정). `bash start.sh` 를 다시 실행하거나 `bash mount/scripts/mount_dataset.sh mount`, `bash mount/scripts/mount_generated.sh mount` |

### 1-5. `.env` 를 수정한 뒤

```bash
cd ~/mlops-mainserver/clearml
vi .env
bash start.sh                          # 전체 반영
bash packaging/apply-env.sh --restart  # IP 만 바꿀 때
```

### 1-6. 처음부터 다시 시험하기 (초기화)

> `.env`(비밀번호·서명 키), `ssh/`(개인 키), ClearML·Grafana DB 는 **저장소에 없어서 지우면 복구할 수 없습니다.** 지우기 전에 코드 변경은 커밋·push 했는지 확인하세요.

```bash
# 1) 컨테이너·이미지 정리
cd ~/mlops-mainserver/clearml
./compose.sh --profile training-ssh down --remove-orphans
./monitoring-compose.sh down --remove-orphans

# 2) NFS 마운트 해제 — 반드시 폴더 삭제보다 먼저 (아래 주의 참고)
sudo umount ~/mlops-mainserver/clearml/data/datasets
sudo umount ~/mlops-mainserver/clearml/data/generate_datasets
mount | grep -E "mlops-mainserver|<학습서버IP>"     # 아무것도 나오지 않아야 함

# 3) 폴더 삭제 후 다시 clone
cd ~ && sudo rm -rf ~/mlops-mainserver
git clone http://172.16.8.64:1541/woals1626/mlops-mainserver.git
```

> **마운트를 풀기 전에 폴더를 지우면 학습 서버의 데이터가 지워질 수 있습니다.** 마운트가 읽기·쓰기이므로 `rm -rf` 가 NFS 너머의 파일까지 지웁니다. 2번에서 아무것도 안 나온 것을 확인한 뒤에만 3번을 하세요.
> 다시 clone 하면 SSH 키가 **새로 만들어지므로**, 학습 서버 `train.env` 의 `MLOPS_SSH_PUBLIC_KEY` 를 새 키로 교체해야 합니다 (③ 과정).

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
cd ~/mlops-mainserver/clearml

./compose.sh ps
./compose.sh logs -f webserver
./compose.sh up -d --force-recreate apiserver

./monitoring-compose.sh ps
./monitoring-compose.sh logs -f clearml-exporter
```

---

## 6. 문제 해결

**SSH 접속이 `Permission denied (publickey,password)` — 학습 서버가 키를 받아 주지 않음**

1. 학습 서버(`TRAINING_SERVER_USER` 계정)에서 등록된 키 지문을 봅니다: `ssh-keygen -lf ~/.ssh/authorized_keys`
2. MLOps 서버 키의 지문과 비교합니다: `ssh-keygen -lf ~/mlops-mainserver/clearml/ssh/id_ed25519.pub`
3. 같은 지문이 없으면 `train.env` 의 `MLOPS_SSH_PUBLIC_KEY` 를 새 공개키로 교체하고 학습 서버 `bash start.sh` 를 다시 실행합니다. (긴 문자열을 눈으로 비교하지 말고 **지문**으로 비교하세요. 앞부분 `ssh-ed25519 AAAAC3...` 은 모든 키가 같습니다.)
4. 그래도 안 되면 학습 서버에서 `sudo grep sshd /var/log/auth.log | tail` 로 거부 사유를 확인합니다. `~/.ssh` 는 `700`, `authorized_keys` 는 `600` 이어야 합니다.
5. `TRAINING_SERVER_USER` 가 학습 서버의 실제 계정과 같은지 확인합니다.

**`mkdir: cannot create directory ... Permission denied` / 컨테이너가 시작하자마자 종료**

- 마운트용 폴더를 Docker 가 root 소유로 만들면, root 가 아닌 컨테이너(Elasticsearch, Prometheus, Grafana, access-control)가 쓰지 못합니다. `start.sh` 가 4단계 앞에서 `packaging/prepare-dirs.sh` 로 자동 정리합니다. 수동 실행도 가능: `bash packaging/prepare-dirs.sh`
- `sudo` 로 `start.sh` 를 실행했거나 `sudo git add` 를 했다면 소유자가 root 로 바뀝니다. `sudo chown -R $USER:$USER ~/mlops-mainserver/.git` 등으로 되돌립니다.

**대시보드에 왼쪽 메뉴·프로젝트가 안 나옴 (`Connection refused` 로그)**

- 웹서버(nginx)는 시작할 때 apiserver 의 IP 를 기억합니다. apiserver 를 다시 만든 뒤에는 웹서버를 재시작해야 합니다: `./compose.sh restart webserver` (`start.sh` 는 자동으로 합니다)

**로그인 화면에서 "MLOps 사용자 인증 연동에 실패했습니다"**

- apiserver 가 안 떠 있거나(`docker logs clearml-apiserver`) 계정이 없는 경우입니다. Elasticsearch 가 죽어 있으면 apiserver 도 못 뜹니다(`docker logs clearml-elastic`).

**대시보드 `TRAINING SERVER` 가 "데이터 지연" / 옛 IP**

- `training-metrics` 서비스가 꺼져 있는 경우입니다: `./compose.sh --profile training-ssh up -d training-metrics` (SSH 접속이 되어야 함)
- Memory 가 `—` 이면 학습 서버의 `check_metrics.sh` 가 메모리를 0으로 보내는 것입니다 (학습 서버 쪽 스크립트 문제).

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

`.env` 의 `TRAINING_SSH_*` 로 전용 SSH 클라이언트를 설정합니다.
접속 대상(`TRAINING_SSH_HOST`)은 `TRAINING_SERVER_IP`, 계정(`TRAINING_SSH_USER`)은 `TRAINING_SERVER_USER` 를 그대로 따릅니다.

- **처음 연결**: 위 1장의 ③④ 과정이 곧 SSH 연결입니다. `start.sh` 가 키 생성 → 호스트 키 등록 → 접속 시험까지 합니다.
- **키 위치**: `clearml/ssh/id_ed25519`(개인 키, 절대 공유 금지), `id_ed25519.pub`, `known_hosts`. 저장소에는 올라가지 않습니다.
- **컨테이너 UID**: 컨테이너가 키를 읽으려면 키 소유자와 `.env` 의 `TRAINING_SSH_UID/GID` 가 같아야 합니다. `start.sh` 가 키 소유자에 맞춰 자동으로 설정합니다. 값이 바뀌면 이미지를 다시 빌드하세요: `./compose.sh --profile training-ssh build training-ssh`
- **확인 / 실행**: `bash training-ssh.sh doctor`, 학습은 `doctor` 대신 `detector` 또는 `vlm` 을 지정합니다.
- **지표 수집**: `training-metrics` 서비스가 5초마다 학습 서버의 `check_metrics.sh` 를 SSH 로 실행해 `branding/training-metrics.json` 을 갱신합니다. 이 파일은 서버가 자동으로 만드는 파일이라 저장소에 올리지 않습니다 (`.gitignore`).

키 인증, 상태·로그 조회, 테스트 경로 설정은 [SSH 실행 가이드](training_ssh/README.md)를 참고하세요.
