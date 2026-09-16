# Train UI 및 Detector 실행 API

`/train/`의 Detector 화면은 `type`, `data`, `epochs`, `batch`, `gpu`,
`img_size`, `weights`, `name`, `resume`만 전송합니다. `type=detector`는 고정이며,
학습 옵션 입력을 비우면 스크립트 기본값을 사용합니다. `resume=true`는 값 없는
`--resume` 플래그를 추가하고 false는 생략합니다. VLM은 설정 작성만 지원합니다.

- `GET /training-api/detector/datasets`: 선택 가능한 상대 폴더 경로와 label.txt 기본 클래스 목록
- `POST /training-api/detector/annotations`: `{folders: ["trainset", "testset"], classes: ["person", "car"]}`로 목록과 YAML 생성·전송
- `GET /training-api/capabilities`: 실행 가능 유형 확인
- `POST /training-api/jobs`: 검증 후 202와 작업 ID 반환
- `GET /training-api/jobs/{id}`: 상태, stdout/stderr 로그, 종료 코드 조회

ClearML 로그인과 같은 Origin 검증을 기존 annotation API에서 공유합니다.
동시에 하나의 Detector 작업만 접수합니다. 작업 이력은 프로세스 메모리에 최근 100개,
UI용 로그는 작업별 최근 64 KiB를 보관합니다. 전체 출력은 Backend 로그로 전달됩니다.
Backend 재시작 시 이력은 소실되므로 재시작 후 재실행 전 서버 학습 상태를 확인해야 합니다.

SSH 학습 명령은 `/home/intellivix/train/scripts/train.sh --type detector ...`입니다.
Backend는 이 실행 경로에서 Docker 명령이나 디렉터리 이동을 하지 않습니다.
SSH 주소·인증은 기존 TRAINING_SSH 설정과 호스트 키 검증을 사용합니다.

허용 경로는 서버 `/home/intellivix/train/Detector`를 기준으로
`data/` 아래 `.yaml`, `.yml`, `weights/` 또는 `runs/Detector/` 아래 `.pt`입니다.
상대 경로와 해당 디렉터리의 절대 경로를 지원하며 부모 경로 이탈은 거부합니다.
이는 경로 allowlist 검증입니다. 파일 존재·권한·심볼릭 링크의 실제 목적지 검증은
서버 train.sh가 수행해야 합니다. Backend에서 별도 SSH 경로 조회 명령은 실행하지 않습니다.

서버 train.sh는 포그라운드 학습 완료까지 기다리고 실제 학습 종료 코드를 반환해야 합니다.
SSH가 반환한 0은 성공, 1~254는 원격 실패로 기록합니다. 255는 SSH 오류와 원격 exit 255를
구분할 수 없어 `script_exit_code=null`로 기록하며 성공 처리하지 않습니다.
SSH 연결이 끊기면 원격 학습의 종료 여부는 보장할 수 없습니다.

## 적용 및 검증

기존 스택의 `training-ssh` 프로필로 annotation-api 이미지를 다시 빌드·기동하고,
브랜딩 웹서버의 `/train/` 자산을 갱신합니다. 별도의 DB 변경은 없습니다.
서버 train.sh에서 `--resume`의 값 없는 플래그 처리 및 위 경로 기준을 지원해야 합니다.

`python3 -m unittest discover -s /opt/clearml/training_ssh -p 'test_*.py'`

실제 83번 서버의 스크립트 계약과 GPU 학습은 로컬 자동 테스트에 포함되지 않습니다.

## 폴더 선택 및 클래스 설정

1. 데이터셋 폴더를 선택하고 `＋`로 추가합니다. `×`로 제거할 수 있습니다.
2. 클래스 이름을 줄바꿈 또는 쉼표로 입력합니다. 표시되는 ID 0, 1, 2…는 기존 YOLO 라벨 ID와 일치해야 합니다.
3. `annotation 자동 생성` 또는 `클래스 적용 · data.yaml 저장`을 누릅니다.
4. 완료된 YAML 내용과 서버 파일 경로를 확인한 뒤 학습을 시작합니다.

두 적용 버튼은 동일한 준비 API를 사용합니다. 폴더나 클래스를 수정한 뒤에는 다시 적용해야
학습할 수 있습니다. 실패하면 이전 YAML 경로를 유지하고 오류 메시지를 표시합니다.
생성된 YAML 경로는 학습 요청의 `data`에만 전달하며 `folders`, `classes`는 train.sh 옵션에 넣지 않습니다.

선택한 폴더의 하위 이미지를 모으고 경로 중복을 제거합니다. 같은 입력 이미지 집합은 고정된
seed=42로 동일한 학습 90% / 검증·테스트 10% 분할을 만듭니다. 최소 이미지는 2개입니다.
`testset`이라는 이름의 폴더도 별도 고정 테스트 세트로 취급하지 않고 선택된 이미지 풀에 합칩니다.

생성 파일:

- `train.txt`, `test.txt`: 학습 컨테이너에서 읽는 이미지 절대 경로를 한 줄에 하나씩 저장
- `data.yaml`: `train: train.txt`, `val: test.txt`, `test: test.txt`, `nc`, `names`

검증과 테스트는 같은 10% 이미지 목록을 사용하므로 독립적인 최종 평가 세트는 아닙니다.
YAML의 상대 목록 경로는 YAML 파일 위치를 기준으로 해석되도록 작성합니다.
참고: [Ultralytics 데이터 경로 및 클래스 처리](https://github.com/ultralytics/ultralytics/blob/main/ultralytics/data/utils.py).

박스 annotation을 자동 추론하거나 원본 라벨 ID를 변경하지 않습니다. 기존 YOLO `.txt` 라벨을 사용하고,
ID가 설정한 클래스 범위를 벗어나면 생성 요청을 거부합니다. 라벨이 없는 이미지는 배경 이미지로 포함하고
그 개수를 UI에 표시합니다. 클래스 이름 변경은 ID의 의미를 바꾸므로 원본 라벨 순서에 맞춰 입력해야 합니다.
기본 클래스는 Dataset 루트의 `label.txt`에서 읽습니다.

각 적용 결과는 83번 서버의 `/home/intellivix/train/Detector/data/generated/<id>/`에
새 버전으로 저장하며 UI의 `data`는 `data/generated/<id>/data.yaml`로 갱신됩니다.
기존 YAML을 덮어쓰지 않아 진행 중인 학습이나 다른 사용자의 설정에 영향을 주지 않습니다.
클래스만 바꾸고 이미지 집합이 같으면 분할은 유지됩니다.

파일 전송은 기존 SSH 키·호스트 검증 설정을 공유하는 SFTP 배치로 처리합니다.
3개 파일을 임시 디렉터리에 모두 올린 뒤 디렉터리 이름을 변경하고 성공한 경로만 반환합니다.
SFTP 실패 또는 시간 초과 시 준비 API는 실패를 반환합니다. 실패한 임시 디렉터리가 서버에 남을 수 있습니다.
서버에서 SFTP subsystem과 Detector/data 하위 쓰기 권한이 필요하며, Detector/data는 학습 컨테이너에도
노출되어야 합니다. 이미지 목록의 기준 경로는 기존 `TRAINING_IMAGE_ROOT` 설정
(기본 `/workspace/Dataset/detector`)을 사용합니다. 학습 명령은 계속 공통 train.sh만 호출합니다.

추가 UI 흐름 테스트:
`node /opt/clearml/training_ssh/test_train_ui.js /opt/clearml/branding/train/app.js`

Detector 준비 API는 TXT 목록 2개와 data.yaml만 생성·전송합니다. 기존 `/annotations` JSON 경로는 Detector 화면에서 사용하지 않습니다.

Backend 코드 변경 후 `bash /opt/clearml/compose.sh --profile training-ssh up -d --build --no-deps annotation-api`로 실행 컨테이너도 갱신해야 합니다. `/train/`은 bind mount로 즉시 반영되므로 Backend 갱신을 누락하면 새 버튼 API에 404가 발생합니다.
