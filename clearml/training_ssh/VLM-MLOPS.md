# VLM MLOps 학습 연동

## 구현 범위

- 기존 `scripts/train.sh --type vlm`를 사용합니다. 학습 알고리즘은 기존 VLM 코드입니다.
- 모델은 `.pt`가 아닌 로컬 모델 디렉터리이며, 학습 서버 목록과 config.json을 확인합니다.
- 모델·JSON·GPU 선택, 기본·고급 수치 검증, 요청 전 최종 적용 설정과 출처, 유효 배치 크기, 시작·상태·실패·중지·ClearML 작업 링크를 제공합니다.
- VLM 재개는 제공하지 않습니다. 빈 입력은 요청에서 생략하므로 서버 설정과 명시적 0/false를 구분합니다.

## UI → 요청 → 실행 옵션 → 서버 키

| UI 요청 필드 | 실행 옵션 | train.env 키 | 적용 조건 |
|---|---|---|---|
| modality | `--modality` | `TRAIN_MODALITY` | 공통 |
| mode | `--mode` | `TRAIN_MODE` | 공통 |
| model | `--model` | `IMAGE_MODEL / VIDEO_MODEL / BOTH_MODEL` | 공통 |
| train_json | `--annotation` | `TRAIN_JSON` | 공통 |
| val_json | `--val-json` | `VAL_JSON` | 공통 |
| epochs | `--epochs` | `EPOCHS` | 공통 |
| batch | `--batch` | `BATCH_SIZE` | 공통 |
| gradient_accumulation | `--gradient-accumulation` | `GRAD_ACCUM` | 공통 |
| learning_rate | `--learning-rate` | `LEARNING_RATE` | 공통 |
| max_length | `--max-length` | `MAX_SEQ_LENGTH` | 공통 |
| workers | `--workers` | `DATALOADER_NUM_WORKERS` | 공통 |
| gpu | `--gpu` | `DEVICE` | 공통 |
| name | `--name` | `CLEARML_TASK` | 공통 |
| lora_rank | `--lora-rank` | `LORA_R` | LoRA 방식 |
| lora_alpha | `--lora-alpha` | `LORA_ALPHA` | LoRA 방식 |
| lora_dropout | `--lora-dropout` | `LORA_DROPOUT` | LoRA 방식 |
| lora_target_modules | `--lora-target-modules` | `LORA_TARGET_MODULES` | LoRA 방식 |
| gradient_checkpointing | `--gradient-checkpointing` | `GRADIENT_CHECKPOINTING` | 공통 |
| video_fps | `--video-fps` | `VIDEO_FPS` | Video / Both |
| video_max_pixels | `--video-max-pixels` | `VIDEO_MAX_PIXELS` | Video / Both |
| validation_ratio | `--validation-ratio` | `VALID_RATIO` | 공통 |
| validation_seed | `--validation-seed` | `VALID_SPLIT_SEED` | 공통 |
| max_samples | `--max-samples` | `MAX_SAMPLES` | 공통 |
| eval_steps | `--eval-steps` | `EVAL_STEPS` | 공통 |
| logging_steps | `--logging-steps` | `LOGGING_STEPS` | 공통 |
| save_steps | `--save-steps` | `SAVE_STEPS` | 공통 |
| save_total_limit | `--save-total-limit` | `SAVE_TOTAL_LIMIT` | 공통 |

## 데이터와 기본값

기본값은 매번 학습 서버 `train.env`의 server/vlm 섹션을 조회하며 서버 연결·인증값을 UI에 노출하지 않습니다. 서버 GPU 목록에 없는 ID 또는 중복 ID를 거부합니다.

선택 경로는 `/workspace/VLM/weights`, `/workspace/VLM/annotation/vlm`, `/workspace/Dataset/vlm`으로 변환합니다. 모델은 해당 대상 디렉터리에 존재해야 하고 JSON은 서버에서 제공하는 목록에 존재해야 합니다. 상위 경로 이동·경로 밖 심볼릭 링크를 허용하지 않습니다.

학습 JSON 자동 탐색은 대상별 latest/train.json → legacy latest/train.json → 설정된 JSON 디렉터리입니다. 검증 JSON도 설정 → 대상별 latest/valid.json → legacy latest/valid.json을 탐색하고, 없을 때 분할합니다. 최종 설정 확인에 실제 자동 탐색 경로를 표시합니다.

검증 비율은 별도 검증 JSON이 있더라도 0 초과 1 미만이어야 합니다. EVAL_STEPS ≤ 0은 에포크 평가입니다. 다중 GPU의 save strategy는 no이며 학습 후 저장합니다. 짧은 학습은 logging steps가 1로 변경될 수 있습니다.

## MLOps 서버 변경

- `vlm_options.py`: 필드·옵션·서버 키 매핑과 양쪽 서버에서 재사용하는 수치 검증.
- `vlm.py`: 자원 조회, 입력/경로/GPU 검증, 최종 설정 및 command 생성.
- `annotation_api.py`: `/vlm/resources`, `POST /vlm/preview`, VLM 작업 실행과 `/stop/vlm`. 기존 로그인·Origin 검증을 적용합니다.
- `detector.py`: 공통 작업 추적, 대상별 종료, ClearML task ID 연결. 종료 API는 원격 중단 성공 뒤 해당 ID만 공식 tasks.stopped API로 동기화하며 실패하면 갱신 재시도를 제공합니다.
- 브랜딩 `/train/` UI: 기본·고급 입력, 미리보기와 설정 확인, 진행 중 입력 잠금.

## 학습 서버 변경 (적용 완료)

원격 `/home/intellivix/train`에 다음 변경을 적용했습니다. 원본이 있던 파일은 `.before-vlm-mlops`로 백업했습니다. 재배포용 diff는 `server-patches/`에 보관합니다.

- `scripts/train.sh`: 고급 전용 옵션 → 요청별 환경변수 확장, 실행 전 VLM 검증 호출.
- `mount/scripts/train_env.py`: LORA_*, GRADIENT_CHECKPOINTING, VIDEO_*, VALID_*, MAX_SAMPLES, EVAL_STEPS, LOGGING_STEPS, SAVE_*를 TRAIN_OVERRIDE_KEYS 허용 목록에 추가.
- `scripts/mlops_vlm_probe.py`: 허용된 기본값, 실제 GPU, 모델·JSON 목록, 자동 탐색 경로 조회.
- `scripts/vlm_options.py`: 공통 옵션 매핑·검증.
- `scripts/mlops_vlm_validate.py`: 컨테이너 생성 전 유효 설정·GPU·로컬 모델·JSON 경로 검증.
- `VLM/scripts/train/train_clearml.py`: 검증 데이터에 NE/ANI 분류 지표가 생성되지 않는 경우 HF best checkpoint가 존재하는 eval_loss를 사용하도록 호환성 처리. 분류 F1이 생성되는 데이터에서는 기존 선택을 유지합니다. Image·Video·Both 모두 이진 분류 지표 유무와 관계없이 학습/검증 loss 결과 플롯을 ClearML PLOTS와 로컬 `_plots` 폴더에 게시합니다.

학습 서버의 설정 파일 자체는 변경하지 않으며 요청별 override만 적용합니다. `remote_train.sh vlm`에 override를 보내지 않습니다. 이 스크립트는 상태·종료 조회에 사용합니다.

## 적용과 테스트

`bash /opt/clearml/compose.sh --profile training-ssh up -d --build --no-deps annotation-api`

`PYTHONPATH=/opt/clearml/training_ssh python3 -m unittest test_vlm`

`node /opt/clearml/training_ssh/test_train_ui.js /opt/clearml/branding/train/app.js`

실제 학습 검증의 조건과 결과는 `vlm-validation.md`에 기록합니다. UI 자동 테스트와 실제 GPU 실행 검증은 별도로 보고합니다.


## Folder dataset preparation (2026-09-14)
VLM uses the same folder picker, plus button, selected folder chips and refresh placement as Detector. The base model selector is hidden; the API always supplies `/workspace/VLM/weights/Image` for image and `/workspace/VLM/weights/Video` for video/both.

Authenticated `POST /vlm/annotations` receives `{folders: [relative Dataset/vlm folders], modality: image|video|both}`. The remote `scripts/mlops_vlm_dataset.py` recursively gathers JSON and mirrors selected `images/` and `videos/` folders to their `images_json/` and `videos_json/` label trees. Existing project `vlm_dataset_utils` normalizes media/conversations and `split_dataset.split_records` splits 90/10 using a fresh seed. Media is deduplicated across overlapping folders; missing or other-modality media is skipped. At least two valid examples are required.

Files are saved to `/home/intellivix/train/VLM/data/vlm/<modality>/<YYYYMMDD>/train.json` and `valid.json`. Both generated paths must be explicitly supplied for preview/start. Regeneration is blocked while a job is active; source/modality changes invalidate the UI's prepared dataset and final review. GPU resource refresh preserves selected source folders. Generated files use container-portable `vlm/...` media paths.

Real image preparation: 3,707 records → 3,336 train / 371 valid, no missing media. UI launch/stop and restoration harness passed; Python request/API regression checks passed.

Validation finished: 24 Python tests and the UI harness passed; remote dataset fixture checks passed for image/video/both. A 4-sample Image LoRA smoke completed one epoch with ClearML task `a2296ded91954cf292d7b0e2640ab87a`, stored metrics and uploaded `best.zip` (16.2 MiB). See `vlm-folder-smoke.log`.
