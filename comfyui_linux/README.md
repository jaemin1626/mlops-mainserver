# Linux 생성 서버 (ComfyUI + LTX 2.3)

## 목표

24GB VRAM GPU에서 LTX-2.3 distilled FP8로 T2V/I2V만 돌린다.
Gemma 3 12B 인코더는 CPU/RAM, `--reserve-vram 8`.

## 설치 순서

1. NVIDIA 드라이버 설치 (`nvidia-smi` 동작 확인). CUDA 버전을 키트의 torch와 맞춘다.
2. 인터넷 PC에서 `./collect_online.sh` 후 모델 파일을 `models/`에 둔다.
3. `linux-server/`와 저장소의 `workflows/`를 USB로 폐쇄망에 복사한다.
4. `sudo ./install.sh` (또는 `INSTALL_ROOT=... ./install.sh`).
5. `systemctl start seoul-comfyui` 또는 `./start.sh`.
6. Windows에서 `http://<서버IP>:8188/system_stats` 가 열리는지 확인한다.

## 워크플로 고정

동봉 `workflows/t2v_api.json`, `i2v_api.json`은 GUI가 치환하는 API 그래프다.
실서버에서 템플릿을 한 번 성공시킨 뒤 **Save (API Format)** 으로 덮어쓰고 `workflows/mapping.json` 노드 ID를 맞춘다.

## 방화벽

Windows PC IP만 8188 허용. ComfyUI `--listen`은 내부 LAN IP.

## 프리셋 상한 (24GB, 길이 단위는 초)

- `480p_short`: 832x480, 5초
- `720p_short`: 1280x720, 5초 (기본)
- `720p_medium`: 1280x720, 15초 (OOM이면 쓰지 말 것)

워크플로는 `LTX2.3test2.json` API 그래프. 모델 목록은 `models/REQUIRED.txt`.
