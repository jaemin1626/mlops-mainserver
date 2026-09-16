# Seoul Studio (ComfyUI 영상 생성 UI)

ClearML 웹(`/seoul-studio/`)에 통합된 Image→Video 생성 UI입니다.

## 설정

**IP·경로는 `/opt/clearml/.env` 하나에서만 관리합니다.** 이 디렉터리에 별도 `.env`는 없습니다.

| 사용자 설정 (`.env`) | 자동 파생 (`apply-env.sh`) |
|----------------------|----------------------------|
| `TRAINING_SERVER_IP` | `SEOUL_STUDIO_COMFY_URL` |
| `COMFYUI_PORT` (기본 8188) | |
| `MLOPS_GENERATED_MOUNT_PATH` | `GENERATED_EXPORT_PATH` |

IP 변경 시:

```bash
vi /opt/clearml/.env          # CLEARML_SERVER_IP, TRAINING_SERVER_IP 등
bash /opt/clearml/start.sh      # 또는 packaging/apply-env.sh --restart
```

## 빌드

Docker 이미지는 `clearml/docker-compose.yml`의 `seoul-studio` 서비스가 빌드합니다.

```bash
cd /opt/clearml
./compose.sh up -d --build seoul-studio
```

운영 가이드: [`/opt/clearml/README.md`](../clearml/README.md)
