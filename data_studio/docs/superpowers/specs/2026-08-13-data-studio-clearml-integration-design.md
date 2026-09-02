# Data Studio × ClearML 통합 설계

날짜: 2026-08-13  
상태: 구현 완료(1차)

## 목표

ClearML 웹 UI에서 **Data Studio** 버튼으로 진입하고, 같은 서버의 데이터셋 경로를 열어 YOLO 라벨링을 하며, 이미지 이동 시 라벨이 **서버 디스크에 자동 저장**되게 한다.

## 비목표 (1차 범위 밖)

- VLM / Polygon / OCR / Landmark 모드 웹 포팅
- Electron 데스크톱 빌드 유지·개선
- ClearML Dataset API와의 직접 연동
- ClearML 로그인/권한과 Data Studio 인증 통합 (추후)

## 아키텍처

브라우저는 ClearML webserver(`:8080`)만 본다. Data Studio는 별도 컨테이너로 두고, nginx가 `/data-studio/`로 프록시한다.

```
[브라우저] ── :8080 (clearml-webserver / nginx)
                 │
                 ├─ / .................. ClearML UI
                 │     └─ [Data Studio] → /data-studio/
                 │
                 └─ /data-studio/* ──proxy──► data-studio 컨테이너
                                              ├─ 정적 UI (React/Vite)
                                              └─ 파일 API
                                                      │
                                                      ▼
                                             호스트 데이터셋 볼륨
```

### 왜 이 구조인가

- URL·포트를 ClearML과 통일 (`http://<host>:8080/data-studio/`)
- 파일 I/O는 전용 컨테이너에 두어 ClearML 이미지 패치를 최소화
- `model-eval-console`과 같이 compose에 서비스를 추가하는 기존 패턴과 일치

## 컴포넌트

### 1. `data-studio` 서비스

- 소스 위치: `/opt/data_studio` (이미 업로드된 Intellivix Data Studio Local v1.2.0)
- 역할:
  - Vite 빌드 산출물 서빙
  - 서버 파일시스템 API (Electron IPC 대체)
- 외부 포트: 원칙적으로 미공개 (webserver 내부 네트워크만)
- 볼륨: 데이터셋 루트(들)를 읽기/쓰기 가능하게 마운트
- 네트워크: ClearML `frontend` (및 필요 시 `backend`)

### 2. ClearML `webserver` nginx 프록시

- `/data-studio/` → `http://data-studio:<internal-port>/`
- WebSocket이 필요하면(개발 핫리로드 등) 동일 prefix로 upgrade 헤더 전달
- 설정은 호스트의 커스텀 nginx conf를 컨테이너에 마운트하는 방식을 우선 (이미지 내부 파일 직접 수정 최소화)

### 3. ClearML UI 버튼

- 기존 branding 커스터마이즈(` /opt/clearml/branding` )에 **Data Studio** 링크 추가
- 대상: `/data-studio/` (같은 origin, 새 탭 또는 동일 탭 — 구현 시 새 탭 기본)

## API 설계

Base path: `/data-studio/api` (프록시 경유 시 브라우저 기준)

| Method | Path | 역할 |
|--------|------|------|
| GET | `/api/health` | 헬스체크 |
| GET | `/api/fs/roots` | 허용된 데이터셋 루트 목록 |
| GET | `/api/fs/list?path=` | 디렉터리 목록 (폴더 브라우저) |
| GET | `/api/fs/images?path=` | 이미지 파일 재귀/비재귀 스캔 |
| GET | `/api/fs/file?path=` | 파일 읽기 (이미지 binary / 라벨 text) |
| PUT | `/api/fs/file` | 라벨 등 텍스트 저장 body: `{ path, content }` |

### 경로 보안

- 환경변수 `DATA_STUDIO_ALLOWED_ROOTS` (콜론/쉼표 구분) 밖의 경로 거부
- `path.resolve` 후 realpath가 허용 루트 하위인지 검사
- `..` 및 심볼릭 링크를 통한 escape 차단
- 쓰기 API는 허용 확장자만 (1차: `.txt` 라벨; 필요 시 `.json`은 2차)

## UI 변경 (1차: YOLO만)

- Electron `preload` / `ipc` 호출을 HTTP 클라이언트로 교체
- “폴더 열기”: OS 다이얼로그 대신 **서버 폴더 브라우저** 모달
- 기존 YOLO 캔버스·단축키(A/D, Ctrl+S) 유지
- A/D 이동 전 현재 라벨 `PUT` 성공 후에만 인덱스 변경
- Vite `base: '/data-studio/'` 로 서브패스 배포

## 데이터 흐름

1. 사용자가 ClearML에서 Data Studio 버튼 클릭 → `/data-studio/`
2. 허용 루트 목록 조회 → 폴더 브라우저에서 작업 폴더 선택
3. 이미지 목록·동명 `.txt` 로드
4. 편집 후 다음/이전 또는 저장 시 서버에 `.txt` 기록
5. 쓰기 실패 시 이동 중단 + 에러 토스트

## 에러 처리

| 상황 | 동작 |
|------|------|
| 허용 루트 밖 | 400 |
| 파일/폴더 없음 | 404 |
| 디스크 쓰기 실패 | 500, UI는 현재 이미지 유지 |
| data-studio 다운 | `/data-studio/` 502/연결 실패 메시지; ClearML 자체는 영향 없음 |

## 배포

1. `/opt/clearml/docker-compose.yml`에 `data-studio` 서비스 추가
2. webserver에 nginx 프록시 conf 마운트
3. branding에 버튼/링크 추가
4. `docker compose up -d data-studio` 및 webserver 재시작

### 환경 변수 (초안)

- `DATA_STUDIO_ALLOWED_ROOTS` — 예: `/data/datasets`
- `DATA_STUDIO_PORT` — 컨테이너 내부 포트 (예: `8091`; ClearML `:8080`과 구분)

## 테스트 계획 (1차)

- [ ] `GET /data-studio/api/health` 성공 (8080 경유)
- [ ] ClearML UI에서 버튼으로 `/data-studio/` 진입
- [ ] 허용 루트 하위 폴더 열어 이미지 표시
- [ ] 박스 편집 후 A/D 시 `.txt`가 서버에 반영
- [ ] 허용 루트 밖 `path` 요청 거부
- [ ] data-studio 중지 시 ClearML `:8080` 나머지 기능 정상

## 리스크

- ClearML webserver 이미지 업그레이드 시 nginx 커스텀 conf 재적용 필요
- branding JS 청크 해시가 바뀌면 버튼 주입 위치 재작업 가능 → **가능하면 index.html/configuration 또는 안정적인 주입점** 우선
- Windows에서 복사한 `node_modules`는 Linux 컨테이너에서 재설치 필요 (`npm ci` in image build)

## 구현 순서 (요약)

1. data-studio Dockerfile + 파일 API 서버
2. Electron IPC → HTTP 어댑터, Vite base path
3. compose 서비스 + 데이터셋 볼륨
4. webserver nginx `/data-studio/` 프록시
5. ClearML branding 버튼
6. YOLO E2E 스모크 테스트
