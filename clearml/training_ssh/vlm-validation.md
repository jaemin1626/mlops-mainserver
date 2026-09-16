# VLM MLOps 검증 결과

검증일: 2026-09-14 UTC

## UI 및 요청 연동

- 기본·고급 설정 UI 구현 및 `/train/`에 반영.
- 모델 디렉터리·JSON·GPU는 실제 학습 서버 목록을 사용.
- 최종 적용값과 출처, 자동 탐색 경로, 유효 배치, 평가·저장 방식 확인.
- 빈값 생략, 명시적 0/false 전달, LoRA/영상 조건부 전달, VLM 재개 비활성.
- Detector/VLM 화면 흐름 자동 테스트 통과: 시작·종료·화면 재열기·잠금·설정 변경 후 재검토·종료 실패 재시도.
- 서버 테스트 23개 통과: 범위·경로·GPU·명령·API 인증/Origin·정확한 ClearML 작업 상태 동기화.

## 실제 GPU 학습: Image + LoRA 완료

[ClearML 완료 실험](http://172.16.4.84:8080/projects/6f5a3e17612f4825acb578c9522362cc/tasks/ad9f54f747ce4eb1bb030289f646cf32/output/log)

- MLOps 작업 ID: `8c846a1e7dc04c1392441ee5c5272106`
- ClearML 작업 ID: `ad9f54f747ce4eb1bb030289f646cf32`
- 실행 결과: MLOps completed / ClearML completed / SSH exit 0.
- GPU 0 1개, 1 epoch, 최대 샘플 4개 (실제 학습 3 / 검증 1).
- GPU당 batch 1, 누적 1, 유효 batch 1, workers 0, max length 4096.
- LoRA Rank 4 / Alpha 8 / Dropout 0.05, gradient checkpointing true.
- 요청과 실제 ClearML Model/Training 파라미터가 일치함을 대조 확인.
- 학습 loss 마지막 값: 0.775790.
- 검증 loss: 0.478942.
- `best.zip` 산출물: 17,025,479 bytes (약 16.2 MiB).
- adapter weights/config, processor, tokenizer 등의 파일 6개 업로드 확인.
- 서버 저장 위치: `/home/intellivix/train/VLM/runs/train/image/202609140615`.

[모델 산출물](http://172.16.4.84:8081/VLM/mlops_vlm_image_smoke_20260914.ad9f54f747ce4eb1bb030289f646cf32/artifacts/best/best.zip)

실제 설정과 지표의 구조화된 검증 기록: `vlm-validation.json`.

## 실제 종료 검증

- 중단용 검증 작업: `bbd46f6e89c44f26bf2f0a3be2476166`.
- ClearML 작업: `75e7c99472454fbf8af42832154bf2e8`.
- 진행 중 학습을 POST /jobs/{id}/stop으로 종료.
- 원격 학습 없음, MLOps stopped, ClearML stopped가 모두 일치함을 확인.
- 검증 후 진행 중인 학습을 남기지 않음.

## 연동 검증에서 보완한 서버 문제

- 일부 일반 VLM 검증 데이터는 NE/ANI 분류 F1을 생성하지 않음. 이 경우 HF checkpoint 선택을 존재하는 eval_loss로 전환해 평가 이후 실패를 방지. F1이 있는 데이터는 기존 선택 유지.
- Docker 강제 종료에서는 SDK 종료 처리가 실행되지 않을 수 있음. 원격 종료 성공 후 정확한 ClearML task ID로 stopped를 동기화하도록 API 보완. 실패 시 UI에서 해당 상태 갱신을 재시도.

## 검증 범위

UI 구현과 실제 학습 연동 검증을 모두 완료했습니다. 실제 GPU 완료 검증은 Image + LoRA + GPU 1개 조건입니다. Video/Both, Full, 다중 GPU의 전체 학습은 이번에 실행하지 않았으며 해당 조건의 옵션 생성·범위 검증·UI 조건 처리는 자동 테스트로 확인했습니다.

기존 데이터셋 생성 테스트에는 현재 생성 형식과 테스트 기대값 차이로 실패하던 항목이 있으며, 이번 관련 23개 테스트에는 포함하지 않았습니다.
