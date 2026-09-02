# VLM 검수 웹 포팅 + YOLO detector 시작 경로 설계

날짜: 2026-08-13  
상태: 구현 완료(1차)  
선행: `2026-08-13-data-studio-clearml-integration-design.md` (YOLO 웹 1차)

## 목표

ClearML Data Studio 웹에서 **VLM 검수**를 Electron과 동일 기능으로 쓰고, YOLO 폴더 브라우저는 **`/data/datasets/detector`** 부터 열리게 한다. VLM export는 **불러온 JSON과 같은 폴더**에 **파일명만 지정**해 저장한다.

## 비목표

- Polygon / Landmark / OCR 웹 포팅
- ClearML Dataset API 연동
- 인증 통합 (기존 리스크 유지: 네트워크 신뢰 경계 내 운영)
- 예시 레포의 `dataset/` 디렉터리를 실제 마운트로 강제하지 않음 — 개념 구조만 참조

## 참조 데이터 구조 (예시)

운영 경로의 허용 루트는 `/data/datasets`이며, 개념적으로 다음을 가정한다.

```text
/data/datasets/
  detector/                 # YOLO 작업 폴더들
  vlm/
    <task>/
      images/
        Negative/…
        Positive/…
      json/
        <name>.json
```

VLM JSON(배열) 항목 예:

- `index`: `"0000000"`
- `image`: `Negative/….jpg` (`images/` 기준 상대 경로)
- `conversations`: human / gpt 턴

## 아키텍처

Approach: **웹 브리지 확장** (VlmWorkspace 본문은 유지).

```
브라우저
  ├─ YOLO 탭 → openFolderDialog 시작: /data/datasets/detector
  └─ VLM 탭  → openJsonFileDialog 시작: /data/datasets/vlm
         │
         ├─ read/write JSON (원본 경로 덮어쓰기)
         ├─ export (dirname(jsonPath) + 사용자 파일명)
         └─ media: mediaBase(/…/images) + 상대 image
              → GET /data-studio/api/fs/file?path=…
```

Electron `yolo://workspace/…` 대신 HTTP 파일 API로 이미지를 제공한다.

## 컴포넌트

### 1. 서버 (`assertWritableLabelPath` 등)

- 쓰기 허용 확장자: `.txt`, **`.json`**
- 경로 샌드박스(`pathGuard`) 규칙 유지

### 2. `webFsBridge`

| API | 웹 동작 |
|-----|---------|
| `openFolderDialog` | 서버 폴더 피커. 호출 맥락에 따라 시작 경로: YOLO=`…/detector`, VLM media=`…` (피커 initialPath) |
| `openJsonFileDialog` | 서버 피커, 시작 `/data/datasets/vlm`, `.json` 파일만 선택 |
| `saveJsonFileDialog(defaultPath)` | 디렉터리 = `dirname(defaultPath)` 고정, 파일명만 입력 모달 |
| `readJsonFile` / `writeJsonFile` | GET/PUT `/data-studio/api/fs/file` |
| `setMediaBaseRoot` / `getMediaBaseRoot` | 브리지 메모리에 보관 |
| 미디어 URL | 상대 경로를 `mediaBase`와 join 후 `/data-studio/api/fs/file?path=` |
| `showItemInFolder` | no-op |

`normalizeVlmMediaLocalSrc` / `yolo://` 변환은 웹에서 HTTP URL을 그대로 쓰거나, 브리지가 이미 HTTP `imageUrl`/`mediaSrc`를 공급하도록 맞춘다. Electron 전용 프로토콜에 의존하지 않는다.

### 3. `ServerFolderPicker`

모드 확장:

- `dir` — 기존 (YOLO/media base), `initialPath` 지원
- `label` — 기존 `.txt`
- `json` — `.json`만
- `save-name` — 고정 디렉터리 + 파일명 입력 (존재 시 덮어쓰기 확인)

시작 경로가 없으면 `/data/datasets`로 fallback.

### 4. App

- 웹에서도 **VLM 검수** 탭 표시 (YOLO + VLM)
- Polygon / Landmark / OCR은 웹에서 계속 숨김

### 5. VlmWorkspace (최소 변경)

- media base 자동: JSON 경로의 형제 디렉터리 `images/`가 존재하면 설정
- export/리포트 저장은 기존 `saveJsonFileDialog` 호출 유지 → 웹에서 파일명 모달로 충족
- 가능하면 UI 분기는 브리지에 가두고 워크스페이스 로직 복제 금지

### 6. YOLO

- 폴더 열기 시 피커 `initialPath` = `/data/datasets/detector` (없으면 허용 루트)

## 데이터 흐름

1. VLM 탭 → JSON 선택 (`vlm/…/json/*.json`)
2. `images/` 자동 media base (없으면 사용자가 폴더 지정)
3. 항목 이동·검수·임시저장/제출 → 원본 JSON overwrite
4. Export → 같은 폴더 + 파일명 → PUT `.json`
5. 브리프 리포트 → 동일 save 규칙 (기존 Electron이 쓰는 확장자/포맷 유지)

## 에러 처리

| 상황 | 동작 |
|------|------|
| 이미지 없음 / media base 미설정 | 패널에 로드 실패 메시지 |
| JSON 읽기/쓰기 실패 | 상태 메시지, 이동·저장 중단 |
| export 파일명 빈 값 | 저장 거부 |
| 동일 파일명 | 확인 후 덮어쓰기 |
| 허용 루트 밖 | 400 |

## 테스트 계획

- [ ] 웹에서 VLM 탭 노출
- [ ] `/data/datasets/vlm`에서 JSON 열고 이미지 표시
- [ ] 검수 저장 후 원본 JSON 반영
- [ ] export가 JSON과 같은 디렉터리에 생성
- [ ] YOLO 피커가 `detector`부터 시작 (없으면 fallback)
- [ ] `.json` 쓰기·루트 밖 거부

## 구현 순서 (요약)

1. 서버 `.json` 쓰기 허용 + 테스트
2. ServerFolderPicker 모드/`initialPath`/`save-name`
3. webFsBridge VLM API + mediaBase URL
4. App VLM 탭 + YOLO/VLM 시작 경로 연결
5. VlmWorkspace media base 자동 탐지(필요 시)
6. E2E 스모크
