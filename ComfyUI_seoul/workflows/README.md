# LTX-2.3 fire 워크플로 (I2V)

앱은 Save (API Format) 그래프만 제출한다. 소스: `i2v_api.json`.

GUI가 치환하는 노드 (`mapping.json`):

- 121 긍정 프롬프트, 110 부정(비우지 않으면 그래프 값 유지)
- 167 LoadImage 파일명 (I2V)
- 290 I2V 스위치 (항상 false = image-to-video)
- 292/293/291 가로, 세로, 길이(초)
- 285 FPS
- 114, 115 시드

365 NLWorkflowFrameRange 는 빠진 커스텀 노드를 피하려고 API 복사본에서 제거했다.

Linux ComfyUI에 아래 커스텀 노드와 REQUIRED.txt 모델을 넣은 뒤 이 JSON으로 한 장 성공시키면 된다.
