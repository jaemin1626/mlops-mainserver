# SSH로 학습 서버 실행

`/opt/clearml/.env`의 `TRAINING_SSH_*` 설정을 사용합니다. 기본 대상은
`intellivix@172.16.4.83:22`, 프로젝트는 `/home/intellivix/train`입니다.
기존 NFS/ComfyUI의 `TRAINING_SERVER_IP` 설정과 독립적입니다.

이미지는 SSH 클라이언트만 포함합니다. 학습 서버의 GPU/Docker 환경은 기존
`./scripts/remote_train.sh`가 사용합니다. 빌드 중 원격 학습을 실행하지 않습니다.

```bash
cd /opt/clearml
bash compose.sh --profile training-ssh build training-ssh
# 비밀번호를 숨김 입력한 뒤 원격 실행
bash training-ssh.sh --password doctor
bash training-ssh.sh --password detector
bash training-ssh.sh --password vlm
bash training-ssh.sh --password status
bash training-ssh.sh --password logs detector
bash training-ssh.sh --password stop detector
```

비밀번호는 83 서버의 SSH 로그인 비밀번호입니다. 실행마다 입력하며 `.env`나 이미지에
저장하지 않습니다. 해당 단기 컨테이너의 환경 변수로 전달되므로 Docker 관리자는
실행 중 조회할 수 있습니다. 서버가 비밀번호 인증을 허용해야 합니다.

명령은 학습 서버에 이미 있는 스크립트를 실행합니다. 로컬 파일 업로드 기능은 아닙니다.
학습은 기존 원격 래퍼의 분리된 Docker 컨테이너에서 계속되며, `status`/`logs`로 확인합니다.

## 테스트 스크립트

`.env`의 `TRAINING_SSH_TEST_SCRIPT`에 83 서버에 실제로 존재하는 실행 가능한
스크립트의 절대 경로 또는 프로젝트 기준 `./` 경로를 지정합니다.
테스트 스크립트 경로는 아직 확인되지 않아 기본값이 비어 있습니다.

```bash
bash /opt/clearml/training-ssh.sh --password test --help
```

`test` 뒤 인자는 개별 인자로 안전하게 전달됩니다. 테스트의 GPU 설정과 장시간 실행 방식은
지정한 원격 테스트 스크립트에서 처리해야 합니다.

## 키 인증으로 자동 실행

현재 전용 키는 `/opt/clearml/ssh/id_ed25519`, 공개키는 같은 경로의 `.pub`입니다.
공개키 한 줄을 학습 서버 `/home/intellivix/train/mount/config/train.env`의
`MLOPS_SSH_PUBLIC_KEY`에 등록한 뒤 학습 서버에서 다음을 실행합니다.

```bash
cd /home/intellivix/train
./scripts/setup_remote_ssh.sh install-key
```

이후 MLOps 서버에서는 `--password` 없이 같은 명령을 사용합니다.

```bash
bash /opt/clearml/training-ssh.sh doctor
```

새 MLOps 서버에서는 키가 없을 때만 아래처럼 생성합니다. 기존 키를 덮어쓰지 마세요.

```bash
mkdir -p /opt/clearml/ssh
chmod 700 /opt/clearml/ssh
test -e /opt/clearml/ssh/id_ed25519 || ssh-keygen -t ed25519 -N '' -f /opt/clearml/ssh/id_ed25519
```

`TRAINING_SSH_DIR` 디렉터리에는 `id_ed25519`, `known_hosts`를 준비합니다.
현재 `known_hosts`는 호스트에 이미 저장된 83 서버 키를 사용합니다.
다른 서버로 변경할 때에는 해당 서버에서 확인한 SSH 호스트 공개키를 등록하세요.
호스트 키가 다르면 접속은 중단됩니다. 개인키 디렉터리는 Git과 빌드 대상에서 제외되고
컨테이너에는 읽기 전용으로 마운트됩니다.

검증: `python3 -m unittest discover -s /opt/clearml/training_ssh -p 'test_*.py'`

컨테이너는 `TRAINING_SSH_UID:GID` 사용자로 실행합니다. 키 디렉터리 소유자의
`id -u` / `id -g`와 `.env`의 `TRAINING_SSH_UID`, `TRAINING_SSH_GID`를 맞추세요.

## 대시보드 지표 표시

`/dashboard`는 Angular의 `sm-dashboard`가 만드는 화면입니다. `branding/index.html`에
내용을 직접 넣는 대신, `env.js`가 로드하는 `branding/ivx-dashboard.js`에서
`sm-dashboard-projects`와 `sm-dashboard-experiments` 사이에 지표를 삽입합니다.
기존 보고서 영역은 대시보드에서만 숨깁니다. 웹서버의 파일 마운트로 수정이 적용되며,
이미지 재빌드에도 확장 스크립트가 포함되도록 Dockerfile에 COPY를 추가했습니다.

브라우저는 `/training-metrics.json`을 캐시 없이 5초마다 조회합니다.
GPU는 수집된 GPU 사용률의 평균, CPU는 `cpu_percent`, 메모리는
`used_bytes / total_bytes`로 계산합니다. GPU 개수는 서버 노드 수가 아닌 GPU 수입니다.
CPU 코어 수는 `cpu_count`(또는 `cpu_cores`)가 제공될 때만 표시합니다.
학습 서버에서 실행하는 `check_metrics.sh`에도 이 저장소의 최신 스크립트를 반영해야
`cpu_count`가 수집됩니다. 값이 없으면 숫자를 가정하지 않고 `—`로 표시합니다.
수집 실패 또는 마지막 수집으로부터 20초가 지나면 사용률을 `—`로 표시합니다.

`Permission denied (publickey,password)`는 화면 오류가 아닌 학습 서버 SSH 인증 오류입니다.
위의 공개키 등록 절차로 연결을 복구하면 다음 조회부터 실제 값이 표시됩니다.
