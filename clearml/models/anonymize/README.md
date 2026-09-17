# 비식별화 YOLO 가중치

Video Studio(seoul-studio) 비식별화에 사용하는 `.pt` 를 이 폴더에 둡니다.

## 지원 형식

| 형식 | 예시 | 비고 |
|------|------|------|
| **YOLOv7 native** | `04_OBD_BASE_INTEGRATED_v2.1.8.pt` | WongKinYiu yolov7 학습 가중치 (자동 감지) |
| **ultralytics YOLOv8+** | ultralytics로 export한 `.pt` | YOLOv5 구버전 `.pt` 는 미지원 |

## 배치

```bash
cp your_model.pt /opt/clearml/models/anonymize/best.pt
docker compose -f /opt/clearml/docker-compose.yml up -d --force-recreate seoul-studio
```

환경변수 `SEOUL_STUDIO_BLUR_WEIGHTS` 로 다른 파일명도 지정할 수 있습니다.
