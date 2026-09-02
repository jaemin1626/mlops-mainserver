# ClearML 스택 오프라인 이관 가이드

다른 서버로 ClearML + 모니터링 + Data Studio 스택을 통째로 옮기는 절차.

---

## 1. 왜 `docker save` 만으로는 안 되는가

`docker save` 는 **이미지 안의 파일 시스템만** 저장한다. 그런데 이 스택의 커스터마이징은
대부분 이미지 바깥에 있다. 그래서 이미지만 옮기면 순정 ClearML 이 뜬다.

이번에 실제로 확인된 원인은 두 가지다.

### 원인 A — `latest` 태그가 실행 중인 이미지를 더 이상 가리키지 않음

| | 이미지 ID | 버전 |
|---|---|---|
| 실제 실행 중인 apiserver/webserver/fileserver/async_delete | `2d8835ff0137` (태그 없음) | ClearML **2.3.0** (build 705) |
| 로컬의 `clearml/server:latest` 태그 | `f71fdc72e0e5` | ClearML **2.4.0** (build 722) |

언젠가 `docker pull` 이 돌면서 `latest` 태그가 새 이미지로 옮겨갔고, 원래 이미지는
태그를 잃고 dangling 상태로 남았다. 컨테이너는 이미 뜬 상태라 계속 2.3.0 으로 돌지만,
`docker save clearml/server:latest` 는 **한 번도 써본 적 없는 2.4.0** 을 저장한다.

### 원인 B — 브랜딩이 이미지가 아니라 bind mount 이고, 파일명에 빌드 해시가 박혀 있음

`docker-compose.yml` 의 webserver 는 `/opt/clearml/branding/` 의 파일 14개를
컨테이너 안 nginx 문서 루트에 덮어쓴다. 이 중 5개는 파일명에 Angular 빌드 해시가 들어 있다.

```
main-MY7YNF44.js      chunk-XWAPV62X.js     chunk-JY2UDATB.js
chunk-TIXM7K2O.js     c-logomark-FR6YLILN.svg
```

이 해시는 **ClearML 2.3.0 빌드에만 존재**한다. 2.4.0 이미지의 파일명은 완전히 다르다
(`chunk-22REGJEW.js`, `chunk-2B4T66EI.js`, …).

bind mount 는 대상 파일이 없어도 에러 없이 새 파일을 만들어 버린다. 그래서 2.4.0 위에
2.3.0 브랜딩을 마운트하면 **아무 에러 없이, 아무도 참조하지 않는 파일 5개가 생길 뿐**이고
UI 는 순정 ClearML 로 보인다. "기존 clearml 만 남았다" 는 증상의 정체가 이것이다.

### 커스터마이징이 실제로 어디에 있는가

| 커스터마이징 | 위치 | `docker save` 에 포함? |
|---|---|---|
| ClearML UI 브랜딩 (로고·index.html·JS 청크) | `/opt/clearml/branding/` bind mount | ✗ |
| Data Studio 리버스 프록시 설정 | `/opt/clearml/nginx/default.d/` bind mount | ✗ |
| Data Studio 앱 | `/opt/data_studio` **build context** | △ 이미지는 되지만 이름이 어긋나면 재빌드됨 |
| Model Eval Console | `/opt/clearml/model_eval_console` build context | △ 동일 |
| ClearML Prometheus Exporter | `monitoring/clearml-exporter/exporter.py` build context | △ 동일 |
| Grafana 대시보드 정의 | `monitoring/config/grafana/dashboards/` bind mount | ✗ |
| Grafana UI 에서 수정한 대시보드·계정 | `monitoring/data/grafana/` (SQLite) | ✗ |
| Prometheus 스크레이프 설정 | `monitoring/config/prometheus/` bind mount | ✗ |
| API 키·서버 주소 | `/opt/clearml/.env` (통합) | ✗ |
| 프로젝트·태스크·사용자 | MongoDB (`/opt/clearml/data/mongo_4`) | ✗ |
| 실험 지표·로그 | Elasticsearch (`/opt/clearml/data/elastic_7`) | ✗ |
| 아티팩트·모델 파일 (444GB) | `/opt/clearml/data/fileserver` | ✗ |

### 원인 C — build 서비스의 이미지 이름은 compose 프로젝트 이름에서 나온다

`data-studio`, `model-eval-console`, `clearml-exporter` 는 `image:` 없이 `build:` 만 있다.
Compose 는 이미지 이름을 `<프로젝트명>-<서비스명>` 으로 자동 생성하는데, 프로젝트명은
**compose 파일이 있는 디렉터리 이름**이다.

- `/opt/clearml` → 프로젝트 `clearml` → `clearml-data-studio`
- `/opt/clearml/monitoring` → 프로젝트 `monitoring-deploy` → `monitoring-deploy-clearml-exporter`

대상 서버에서 디렉터리 위치가 조금만 달라도 이름이 어긋나고, compose 는 저장해 간 이미지를
무시한 채 **조용히 재빌드**한다. 오프라인 서버면 그대로 실패한다.

---

## 2. 해결 방식

`packaging/pack.sh` 가 다음 세 가지를 하나의 번들로 묶는다.

1. **이미지** — 태그가 아니라 *실행 중인 컨테이너의 실제 이미지 ID* 를 읽어서
   `clearml/server:2.3.0-705` 처럼 버전이 박힌 태그로 다시 붙인 뒤 저장한다.
   `latest` drift가 원천적으로 재발하지 않는다.
2. **고정된 compose 파일** — 모든 서비스에 명시적 `image:` 를 박아 넣는다.
   build 전용 서비스에도 `image:` 를 추가해서 프로젝트 이름에 의존하지 않게 만든다.
3. **호스트 설정·소스·데이터** — bind mount 대상 디렉터리 전체와 DB 덤프.
   컨테이너 UID 소유라 일반 계정으로 못 읽는 디렉터리는 root 헬퍼 컨테이너로 읽는다
   (대상 서버에서도 `sudo` 없이 복원된다).

여기에 더해 **브랜딩 마운트 검증**을 pack 단계와 install 단계 양쪽에서 돌린다.
해시가 박힌 파일이 이미지 안에 없으면 배포를 중단시킨다. 원인 B 가 다시는 조용히
지나가지 않는다.

서버 주소는 여러 파일에 흩어져 있어서 이관할 때마다 한둘씩 빠뜨리게 된다.
`/opt/clearml/servers.conf` 를 단일 원본으로 두고 `packaging/apply-servers.sh` 가
나머지에 뿌린다. 자세한 내용은 [6장의 서버 주소 절](#설치-후-반드시-손봐야-할-것--서버-주소).

---

## 3. 두 가지 시나리오

무엇을 옮길지부터 정해야 명령이 달라진다.

### 시나리오 A — 신규 서버 (커스터마이징만, 데이터는 새로 시작)

브랜딩·Data Studio·Grafana 대시보드·exporter 등 **내가 만든 것만** 그대로 가져가고,
프로젝트·실험·아티팩트는 새 서버에서 처음부터 쌓는 경우.

- 번들 크기 약 6GB, 파일서버 444GB 전송 불필요
- Grafana 대시보드는 `config/grafana/dashboards/` 프로비저닝으로 자동 복원된다
- 대상 서버에서 ClearML 첫 사용자와 API 키를 새로 만들어야 한다

### 시나리오 B — 서버 이전 (데이터까지 그대로)

기존 프로젝트·실험 기록을 유지하는 경우.

> **주의:** Mongo/Elasticsearch 만 복원하고 파일서버(444GB)를 안 옮기면, UI 에는 기존
> 실험이 보이는데 아티팩트·모델 다운로드가 전부 404 가 된다. 데이터를 가져올 거면
> 파일서버도 같이 가져와야 의미가 있다.

---

## 4. 원본 서버에서 번들 만들기

스택이 **떠 있는 상태**에서 실행해야 한다. 실행 중인 컨테이너에서 이미지 ID를 읽기 때문이다.

```bash
cd /opt/clearml/packaging

# 시나리오 A — 신규 서버
./pack.sh

# 시나리오 B — 데이터까지. --stop 은 정합성을 위해 잠시 스택을 내린다
./pack.sh --with-data --stop

# 시나리오 B + Prometheus 지표 이력(약 8GB)
./pack.sh --with-data --stop --with-prometheus
```

| 옵션 | 설명 |
|---|---|
| `--with-data` | mongo 덤프 + elasticsearch/redis/datasets/grafana 데이터 포함 |
| `--stop` | 백업 중 스택을 정지 → Elasticsearch 데이터 정합성 보장 (권장) |
| `--with-prometheus` | Prometheus TSDB 포함 (약 8GB, 지표 이력이 필요할 때만) |
| `--images-only` | 이미지만 |
| `--no-images` | 이미지 저장 건너뛰기 (설정만 다시 말아 올릴 때) |
| `--out DIR` | 출력 위치 (기본 `/opt/clearml-bundle`) |
| `--id ID` | 번들 ID (기본 오늘 날짜) |

결과물:

```
/opt/clearml-bundle/clearml-bundle-<ID>/
├── MANIFEST.txt                       # 번들 정보 + 고정된 이미지 목록과 ID
├── SHA256SUMS
├── install.sh                         # 대상 서버용 설치 스크립트
├── lib/
├── images/
│   ├── images-<ID>.tar.gz             # 고정 태그로 저장된 전체 이미지
│   └── image-map.txt                  # 태그 ↔ 이미지 ID (설치 시 검증용)
├── compose/
│   ├── clearml/docker-compose.yml     # 이미지 고정본
│   └── monitoring/docker-compose.yml
├── config/
│   ├── opt-clearml.tar.gz             # branding, nginx, config, model_eval_console, 스크립트
│   ├── opt-clearml-monitoring.tar.gz  # grafana 대시보드, prometheus 설정, exporter 소스, .env
│   └── opt-data_studio.tar.gz         # Data Studio 빌드 컨텍스트
└── data/                              # --with-data 일 때만
    ├── mongo-dump.archive.gz
    ├── elastic_7.tar.gz
    ├── redis.tar.gz
    ├── datasets.tar.gz
    ├── grafana.tar.gz
    └── prometheus.tar.gz              # --with-prometheus 일 때만
```

### 자격증명 취급

`monitoring-deploy/.env` 에는 ClearML API 키, Grafana 관리자 비밀번호, GitLab 토큰이 평문으로
들어 있다. `pack.sh` 는 **실행 중인 원본을 절대 건드리지 않고**, 스테이징 폴더로 복사한 뒤
거기서만 `GITLAB_TOKEN` 을 비워서 번들에 담는다.

- 번들의 `.env` : `GITLAB_TOKEN=` (빈 값)
- 원본 그대로의 사본 : `<출력경로>/secrets-backup-<ID>/monitoring.env` (권한 600, **번들 바깥**)
- 실행 중인 `/opt/clearml/.env` : 변경 없음 (모니터링도 동일 파일 사용)

`GITLAB_TOKEN` 은 exporter 에서 커밋 현황 지표에만 쓰인다.

```1022:1023:/opt/clearml/monitoring/clearml-exporter/exporter.py
    # ── GitLab 커밋 현황 ─────────────────────────────────────
    if GITLAB_URL and GITLAB_TOKEN:
```

비어 있으면 블록 전체를 건너뛰므로 exporter 는 정상 동작하고, `gitlab_commit_count`,
`gitlab_project_commit_total`, `gitlab_lines_added`, `gitlab_lines_deleted`, `gitlab_tag_info`
5개 지표만 안 나온다. 대시보드에서 해당 패널만 비고 나머지 ClearML 지표는 그대로다.

> `CLEARML_ACCESS_KEY` / `CLEARML_SECRET_KEY` 는 여전히 번들에 들어가지만 **원본 서버 전용이라
> 대상 서버에서 동작하지 않는다.** 어차피 새로 발급받아 교체해야 한다.
> Grafana 관리자 비밀번호도 함께 들어가므로 전송 경로와 보관 위치는 관리 대상으로 다룰 것.

---

## 5. 전송

```bash
rsync -aHAX --info=progress2 /opt/clearml-bundle/clearml-bundle-<ID> user@대상서버:/opt/
```

시나리오 B 라면 파일서버도 같이 옮긴다. 444GB 라 오래 걸리니 번들 생성과 병행하는 게 좋다.

```bash
sudo rsync -aHAX --info=progress2 \
    /opt/clearml/data/fileserver/ user@대상서버:/opt/clearml/data/fileserver/
```

`-a` 대신 `-aHAX` 를 쓰는 이유는 소유권·하드링크·확장 속성 보존 때문이다. 소유권이 깨지면
Prometheus(65534)·Grafana(472)·Elasticsearch(1000) 가 자기 데이터 디렉터리를 못 읽는다.

---

## 6. 대상 서버에서 설치

사전 조건은 Docker Engine + Compose v2, 그리고 `python3-yaml` 뿐이다.

```bash
cd /opt/clearml-bundle-<ID>

./install.sh                  # 시나리오 A — 빈 ClearML 로 시작
./install.sh --with-data      # 시나리오 B — 데이터까지 복원
./install.sh --verify-only    # 아무것도 바꾸지 않고 검증만
./install.sh --no-start       # 복원만 하고 기동은 수동
```

`install.sh` 가 하는 일:

1. SHA256 체크섬 검증
2. 이미지 로드 후 `image-map.txt` 의 ID 와 **하나씩 대조** (원인 A 재발 방지)
3. `config/*.tar.gz` 복원 + 고정된 compose 파일 배치 (기존 파일은 `.orig` 로 보관)
4. **브랜딩 마운트 검증** — 해시 파일이 이미지에 없으면 여기서 중단 (원인 B 재발 방지)
5. 데이터 디렉터리 생성 및 소유권 설정 — Elasticsearch/Mongo/Redis/fileserver 는 1000:1000,
   Prometheus 는 65534, Grafana 는 472. 없는 디렉터리만 만들고 기존 데이터는 건드리지 않는다
6. 데이터 복원 (`--with-data` 일 때만), mongo 는 `mongorestore --drop`
7. `docker compose -p <원본과 동일한 프로젝트명> up -d --no-build` 로 기동

5번이 신규 서버에서 특히 중요하다. bind mount 대상 디렉터리가 없으면 도커가 **root 소유로**
만들어 버려서 Elasticsearch 가 `AccessDeniedException` 으로 죽고, ClearML 전체가 안 뜬다.

`--no-build` 도 핵심이다. 이미지가 없으면 조용히 재빌드하는 대신 실패시킨다 (원인 C 재발 방지).

### 시나리오 A 일 때 설치 후 마무리

빈 ClearML 이므로 계정과 키를 새로 만들어야 한다. `install.sh` 가 마지막에 안내해 준다.

1. `http://<대상서버>:8080` 접속 → 첫 사용자 생성
2. 프로필 → Settings → Workspace → Create new credentials
3. 발급한 키를 `/opt/clearml/.env` 의 `CLEARML_ACCESS_KEY` / `CLEARML_SECRET_KEY` 에 넣고 exporter 재시작

```bash
cd /opt/clearml
./monitoring-compose.sh up -d --no-build clearml-exporter
```

### 설치 후 반드시 손봐야 할 것 — 서버 주소

주소는 `/opt/clearml/servers.conf` **한 파일**에만 적는다. 고친 뒤 반영 스크립트를 돌리면
나머지 설정 파일이 전부 따라온다.

```bash
vi /opt/clearml/servers.conf                       # CLEARML_SERVER_IP 등 수정
/opt/clearml/packaging/apply-servers.sh --restart  # 반영 + 재기동
```

`servers.conf` 에 들어가는 값은 이게 전부다.

| 키 | 뜻 |
|---|---|
| `CLEARML_SERVER_IP` | ClearML 스택이 도는 서버 |
| `CLEARML_WEB_PORT` / `CLEARML_API_PORT` / `CLEARML_FILES_PORT` | 8080 / 8008 / 8081 |
| `MONITORING_SERVER_IP` | 모니터링 서버. ClearML 과 같으면 같은 값 |
| `GRAFANA_PORT` / `PROMETHEUS_PORT` / `EXPORTER_PORT` | 3000 / 9091 / 9090 |
| `TRAINING_SERVER_IP` / `TRAINING_SERVER_USER` | 데이터셋 등록 스크립트 배포 대상 |
| `TAGGING_TOOL_URL` / `GITLAB_URL` / `GITLAB_PROJECT_IDS` | exporter 부가 지표. 비워도 동작 |

`apply-servers.sh` 가 값을 뿌리는 곳과, 실행 시점에 `servers.conf` 를 직접 읽는 곳은 다음과 같다.

| 파일 | 방식 | 반영되는 항목 |
|---|---|---|
| `/opt/clearml/.env` | `apply-env.sh` | `CLEARML_HOST_IP`, `CLEARML_WEB_HOST`, `CLEARML_FILES_HOST`, `CLEARML_API_HOST`, `SERVER_HOST`, 포트 등 |
| `monitoring/remote-install.sh` | 직접 읽음 | 안내 출력에 쓰는 Grafana·Prometheus 주소 |

`.env` 한 파일에 주소·자격증명을 모두 두고, `apply-env.sh` 가 **파생 URL만** 갱신한다.
`CLEARML_ACCESS_KEY`, `GRAFANA_ADMIN_PASSWORD`, `GITLAB_TOKEN` 같은 자격증명은 건드리지 않는다.

바꾸기 전에 지금 값을 보고 싶으면:

```bash
/opt/clearml/packaging/apply-servers.sh --check   # 아무것도 안 바꾸고 현재 값만 출력
```

ClearML API 키는 서버마다 다르므로 이건 `servers.conf` 로 해결되지 않는다. 대상 서버의
ClearML UI(`프로필 → Settings → Workspace → Create new credentials`)에서 새로 발급받아
모니터링 `.env` 의 `CLEARML_ACCESS_KEY` / `CLEARML_SECRET_KEY` 를 교체해야 exporter 가
지표를 수집한다.

---

## 7. 검증 체크리스트

```bash
docker compose -p clearml ps              # 10개 서비스 Up
docker compose -p monitoring-deploy ps    # 3개 서비스 Up

# ClearML 버전이 원본과 같은지
docker exec clearml-apiserver printenv CLEARML_SERVER_VERSION   # 2.3.0

# 브랜딩이 실제로 먹었는지 (순정이면 파일 크기가 다르다)
curl -s http://<대상서버>:8080/ | grep -o 'INTELLIVIX' | head -1

# Data Studio 프록시
curl -s -o /dev/null -w '%{http_code}\n' http://<대상서버>:8080/data-studio/   # 200

# Exporter 지표
curl -s http://<대상서버>:9090/metrics | grep ^clearml_projects_total

# Grafana 대시보드
curl -s http://<대상서버>:3000/api/health
```

브라우저에서 `Ctrl+Shift+R` 로 강제 새로고침해야 한다. 브랜딩 JS 는 파일명이 같아서
브라우저 캐시가 옛날 것을 계속 쓸 수 있다.

---

## 8. 트러블슈팅

**설치 중에 `Unable to find image 'clearml/server:latest' locally` 하며 Docker Hub 에서 받아온다**

오프라인 번들인데 인터넷에서 이미지를 받는다면, 그 서비스만 고정이 안 된 것이다. 뒤이어
브랜딩 검증이 이렇게 실패한다.

```
  [실패] 빌드 해시가 박힌 파일이 clearml/server:latest 안에 없습니다:
         - /usr/share/nginx/html/main-MY7YNF44.js
```

당연하다. 방금 받아온 건 오늘자 최신 ClearML 이고, 브랜딩 파일은 원본 서버의 2.3.0 에서
뽑은 것이라 빌드 해시가 다르다.

원인은 대상 서버가 아니라 **번들을 만들 때** 있다. `pack.sh` 는 `docker ps` 로 실행 중인
컨테이너를 훑어서 이미지를 고정하므로, 그 순간 꺼져 있던 서비스는 고정 목록에서 통째로
빠진다. 확인은 번들 안의 매핑 파일로 한다.

```bash
cat compose/clearml/image-pin.map          # webserver 줄이 있는지
grep -n 'image:' compose/clearml/docker-compose.yml | grep latest
```

제대로 고치려면 원본 서버에서 스택을 전부 띄우고 다시 묶는다.

```bash
docker compose -p clearml ps -a            # 꺼진 게 있으면
docker compose -p clearml up -d
/opt/clearml/packaging/pack.sh
```

이미 이미지까지 전송을 마쳤다면 compose 한 줄만 고쳐도 된다. 필요한 이미지는 이미
번들 안에 있다(`images/image-map.txt` 확인). 파일을 고치면 체크섬이 어긋나므로 같이 다시
계산한다. 전송 무결성은 직전 실행의 `체크섬 검증` 단계에서 이미 확인된 상태다.

```bash
cd /opt/clearml-bundle-<날짜>
sed -i 's|clearml/server:latest|clearml/server:2.3.0-705|' compose/clearml/docker-compose.yml
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
docker rmi clearml/server:latest
./install.sh
```

이제 `pack.sh` 는 compose 가 참조하는 이미지가 하나라도 번들 목록에 없으면 거기서 멈추고,
`install.sh` 도 Docker Hub 로 나가기 전에 막는다. 같은 일이 조용히 지나갈 수는 없다.

**UI 상단 헤더와 왼쪽 사이드바가 안 그려진다 (내용 영역만 보임)**
브라우저에 남은 예전 세션 쿠키 때문이다. apiserver 로그에 이렇게 찍힌다.

```
400 for users.get_current_user   msg=Invalid user (failed loading user)
400 for users.get_preferences    msg=Invalid user id: id=..., company=...
401 for projects.get_all_ex      msg=Unauthorized (missing credentials)
```

쿠키는 호스트 단위라 같은 주소에 예전에 접속한 적이 있으면 토큰이 남는다. 그 뒤 Mongo 를
새로 만들면 사용자만 사라져서 토큰이 붕 뜬다. 이관이나 브랜딩 문제가 아니다.

핵심은 **400 과 401 의 차이**다. 낡은 토큰이 서명 검증은 통과하고 그 안의 사용자 ID 만
DB 에 없어서 401 이 아니라 400 이 나온다. ClearML UI 의 인증 가드는 401 일 때만 로그인
화면으로 보내므로, 400 은 "그냥 실패한 API 호출" 로 흘려보내고 대시보드를 그리러 간다.
사용자 객체가 없으니 헤더와 사이드바만 안 그려진 껍데기가 남는다.

시크릿 창(`Ctrl+Shift+N`)에서 멀쩡한 이유도 같다. 쿠키가 비어 있어 토큰을 아예 안 보내고,
그러면 401 이 떨어져서 UI 가 정상적으로 로그인 화면으로 넘긴다.

당장 고치려면 DevTools → Application → Storage → Clear site data 후 새로고침한다.
주소창 왼쪽 자물쇠(또는 `주의 요함`) → 쿠키 및 사이트 데이터 → 사이트 데이터 삭제도 같다.

근본 원인은 [10장](#10-서버-고유-서명-키)에서 없앤다. 서명 키를 서버마다 다르게 두면
낡은 토큰이 401 로 떨어져서 이 증상 자체가 안 생긴다.

**UI 가 순정 ClearML 로 보인다**

서버 문제인지 브라우저 문제인지부터 가른다. 두 서버가 실제로 뭘 내보내는지 비교하면 끝난다.

```bash
for h in <원본> <대상>; do
  echo "--- $h ---"
  echo -n "  index.html : "; curl -s http://$h:8080/ | wc -c
  echo -n "  main.js    : "; curl -s http://$h:8080/main-MY7YNF44.js | wc -c
  echo -n "  INTELLIVIX : "; curl -s http://$h:8080/main-MY7YNF44.js | grep -c -io intellivix
done
```

숫자가 **같으면 브라우저 캐시**다. 브랜딩 파일은 순정과 파일명이 똑같은데 내용만 다르다.
파일명에 박힌 해시는 "이 이름이면 내용이 같다" 는 약속인데 브랜딩이 그 약속을 깨고 있고,
브라우저는 약속을 믿고 캐시를 쓴다. 그 서버에 예전에 순정 ClearML 이 돌았던 적이 있으면
그때 받은 파일이 계속 나온다. DevTools → Application → Storage → Clear site data 후
`Ctrl+Shift+R`. 쿠키도 같이 지워야 하므로 `Ctrl+Shift+R` 만으로는 부족할 수 있다.

숫자가 **다르면 서버 문제**다. 마운트가 엉뚱한 파일명에 붙었거나 이미지 버전이 어긋난 것이다.

```bash
docker inspect clearml-webserver --format '{{.Config.Image}}'   # 고정 태그여야 한다
docker inspect clearml-webserver --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
docker exec clearml-webserver ls -la /usr/share/nginx/html/index.html
./install.sh --verify-only
```

`index.html` 이 순정(약 1KB)이 아니라 커스텀 크기(68514 bytes)인지 본다.
`branding/configuration.json` 이 2바이트(`{}`)인 것은 정상이다. webserver 가 기동할 때
이 파일을 덮어쓰므로 원본 서버도 똑같다.

**ClearML 은 뜨는데 프로젝트가 하나도 없다**
시나리오 A 라면 정상이다. 데이터를 가져오려던 거라면 Mongo/Elasticsearch 가 안 넘어간 것이니
`--with-data` 로 다시 번들을 만들거나 `data/mongo-dump.archive.gz` 만 따로 복원한다.

```bash
docker exec -i clearml-mongo mongorestore --archive --gzip --drop < mongo-dump.archive.gz
docker restart clearml-apiserver
```

**Elasticsearch 가 `AccessDeniedException` / `failed to obtain node locks` 로 죽는다**
`/opt/clearml/data/elastic_7` 이 root 소유다. bind mount 대상이 없을 때 도커가 root 로
만들어 버린 경우다. 신규 서버에서 가장 흔하다.

```bash
sudo chown -R 1000:1000 /opt/clearml
docker compose -p clearml restart elasticsearch apiserver
```

**Grafana 대시보드가 비어 있다 / Prometheus 가 안 뜬다**
데이터 디렉터리 소유권 문제다.

```bash
sudo chown -R 472:472   /opt/clearml/monitoring/data/grafana
sudo chown -R 65534:65534 /opt/clearml/monitoring/data/prometheus
```

**설치 중 `ID 불일치` 로 전부 실패한다**
이미지 ID(= config JSON 의 sha256)는 `docker save` / `docker load` 를 거치면서 재계산될 수
있다. 원본과 대상의 Docker 버전이 다르거나, 한쪽만 containerd 이미지 스토어를 쓰면 config 가
다른 형식으로 다시 직렬화되기 때문이다. **레이어 내용은 동일하므로 실제 문제는 아니다.**

그래서 검증 기준은 ID 가 아니라 RootFS 레이어 다이제스트다. 구버전 번들이라 `image-map.txt`
가 2열이면 원본 서버에서 지문을 포함해 다시 만든다 (이미지 tar 는 재사용된다).

```bash
cd /opt/clearml/packaging && ./pack.sh --no-images
```

직접 비교해 보려면:

```bash
docker image inspect <이미지> --format '{{range .RootFS.Layers}}{{println .}}{{end}}'
```

**`docker compose up` 이 이미지를 빌드하려 한다**
고정본 compose 가 아니라 원본이 쓰이고 있다. `docker-compose.yml` 에
`image: clearml-data-studio:pin-<ID>` 같은 줄이 있는지 확인한다.

**태스크에서 아티팩트·모델 다운로드가 404**
`/opt/clearml/data/fileserver` rsync 가 안 끝났거나 소유권이 깨졌다.

---

## 9. 재발 방지 규칙

1. **`:latest` 를 compose 에 쓰지 않는다.** 번들이 만들어 주는 고정본 compose 를 원본으로
   삼는다. 업그레이드할 때만 의도적으로 태그를 올린다.
2. **브랜딩을 바꿀 때는 반드시 현재 실행 중인 이미지에서 파일을 추출한다.**
   ClearML 을 업그레이드하면 해시 파일명이 전부 바뀌므로 브랜딩도 다시 만들어야 한다.

```bash
IMG=$(docker inspect clearml-webserver --format '{{.Image}}')
docker run --rm --entrypoint sh "$IMG" -c 'ls /usr/share/nginx/html | grep -E "^(main|chunk)-"'
```

3. **build 서비스에는 항상 `image:` 를 같이 적는다.** 프로젝트 이름에 이미지 이름이
   끌려다니지 않게 한다.
4. **IP 주소를 스크립트나 `.env` 에 직접 쓰지 않는다.** `servers.conf` 에 키를 추가하고
   스크립트에서는 변수로 참조한다. 새 키를 `.env` 에 넣어야 하면 `apply-servers.sh` 의
   `set_env.py` 호출 인자에 한 줄 추가한다. 새 IP 가 어딘가에 남아 있으면
   `apply-servers.sh` 가 마지막에 경고로 알려준다.
5. **이관 후에는 `install.sh --verify-only` 를 한 번 돌린다.**
6. **`docker system prune` 을 주의한다.** 태그를 잃은 이미지(원인 A 의 `2d8835ff0137`)가
   지워지면 지금 돌고 있는 버전을 다시 만들 방법이 없다.
   실행 중인 이미지에는 지금 바로 버전 태그를 붙여 두는 것이 안전하다.

```bash
docker tag 2d8835ff0137 clearml/server:2.3.0-705
```

7. **서버를 새로 세울 때마다 `gen-secrets.sh` 를 돌린다.** `install.sh` 가 자동으로 하지만,
   손으로 세운 서버라면 잊기 쉽다. `.env` 는 번들에 안 들어가므로 서버마다 키가 달라진다.
8. **브랜딩 파일을 고쳤으면 `rehash-branding.sh` 를 돌린다.** 안 그러면 이미 접속한 적 있는
   브라우저는 예전 파일을 계속 쓴다. 11장 참고.

---

## 11. 브랜딩 파일 해시 다시 매기기

ClearML 웹 자산은 `main-MY7YNF44.js` 처럼 파일명에 내용 해시가 박혀 있다. **"이름이 같으면
내용도 같다"** 는 약속이고, 브라우저는 이걸 믿고 캐시를 오래 쓴다.

브랜딩은 순정 파일 위에 다른 내용을 덮어쓰면서 이름은 그대로 둔다. 약속이 깨진 상태라,
그 주소에서 순정 ClearML 을 본 적 있는 브라우저는 캐시를 지우기 전까지 계속 순정 화면을
보여준다. 서버는 멀쩡한 파일을 내보내고 있는데도 그렇다.

페이지 안에 강제 새로고침 코드를 넣는 방법은 통하지 않는다. 코드를 넣을 자리가
`main-MY7YNF44.js` 인데, **그 파일이 바로 캐시에서 순정 버전으로 로드된 파일**이라
우리 코드가 애초에 실행되지 않는다. `location.reload(true)` 로 캐시를 건너뛰는 방법도
2018년경부터 Chrome·Firefox 모두 인자를 무시해서 더는 동작하지 않는다.

고칠 자리는 서버가 보내는 헤더와 파일명이다. 사용자한테 새로고침을 시키는 건 해결이 아니다.

### 먼저: 캐시 정책을 서버가 지시하게 한다

이 서버는 원래 `Cache-Control` 을 **아무것도 안 보내고 있었다.**

```bash
curl -sI http://<서버>:8080/ | grep -i -E 'cache-control|etag|last-modified'
#   Last-Modified: Tue, 18 Aug 2026 05:20:30 GMT
#   ETag: "6a83eb9e-10ba2"
#   ← Cache-Control 없음
```

지시가 없으면 브라우저가 자기 나름의 추측으로 캐시 기간을 정한다(RFC 7234 heuristic
freshness). 보통 "마지막 수정 시각으로부터 지난 시간의 10%" 쯤이라, 파일이 오래될수록
캐시 기간이 길어진다. 그 기간에는 요청 자체를 안 보내므로, 서버가 새 파일을 갖고 있어도
전달할 방법이 없다.

`nginx/default.d/cache-control.conf` 한 줄로 지시한다. 이 디렉터리는 이미 webserver 에
마운트돼 있어서 파일만 넣으면 된다.

```nginx
expires -1;
```

**`add_header` 를 쓰면 안 된다.** 여기서 한 번 헛짚었으니 기록해 둔다.

이 파일은 `sites-available/default` 의 `server` 블록 안에서 include 된다. 그런데 nginx 의
`add_header` 에는 특이한 상속 규칙이 있다. **하위 블록에 `add_header` 가 하나라도 있으면
상위 블록의 것을 전부 버린다.** 정적 파일을 내보내는 `location /` 에는 이미 이런 게 있다.

```nginx
location / {
    add_header Strict-Transport-Security "..." always;
    add_header Content-Security-Policy "frame-ancestors 'self'";
    add_header X-XSS-Protection "1; mode=block";
    ...
}
```

그래서 `server` 레벨에 `add_header Cache-Control` 을 걸면 **정적 파일에는 도달하지 못한다.**
`always` 를 붙여도 마찬가지다. `always` 는 에러 응답에도 붙이라는 뜻이지 상속 규칙과는
무관하다. 설정은 문법 검사도 통과하고 reload 도 성공하는데 헤더만 조용히 안 붙는다.

`expires` 는 그 규칙을 안 따르는 평범한 지시자다. 하위 블록이 `expires` 를 다시 정의하지
않으면 그대로 물려받는다. `location /` 에는 `expires` 가 없으므로 적용된다. 음수 값은
`Cache-Control: no-cache` 를 뜻한다.

`no-cache` 는 `no-store` 가 아니다. **받아두되 쓰기 전에 항상 물어보라**는 뜻이라
매번 다시 받지 않는다. 내용이 그대로면 ETag 로 304 가 떨어지고 본문은 안 온다.
이 서버는 이미 모든 응답에 ETag 를 붙이고 있어서 추가 비용이 거의 없다.

`/api` 와 `/files` 프록시도 함께 물려받는다. API 응답은 원래 캐시 대상이 아니라 무해하고,
아티팩트 다운로드는 재검증이 한 번 추가되는 정도다.

적용은 reload 로 충분하다. 컨테이너를 다시 만들 필요가 없다.

```bash
docker exec clearml-webserver nginx -t && docker exec clearml-webserver nginx -s reload
```

확인은 헤더가 실제로 붙는지, 그리고 재검증이 304 로 끝나는지 둘 다 본다.

```bash
curl -sI http://<서버>:8080/main-MY7YNF44.js | grep -i -E 'cache-control|etag'
#   ETag: "6a0168e8-2d998"
#   Cache-Control: no-cache

ETAG=$(curl -sI http://<서버>:8080/main-MY7YNF44.js | sed -n 's/^ETag: //Ip' | tr -d '\r')
curl -sI -H "If-None-Match: $ETAG" http://<서버>:8080/main-MY7YNF44.js | head -1
#   HTTP/1.1 304 Not Modified
```

컨테이너를 다시 만들어야 한다면 `--no-deps` 를 꼭 붙인다. 빼면 apiserver 까지 다시
만들어져서 전원 로그아웃된다.

이미 캐시를 가진 브라우저도 추측한 기간이 지나면 재확인하러 오고, 그때 이 헤더를 받아간다.
그 뒤로는 항상 최신이다. 즉 시간이 지나면 저절로 낫는다. 당장 급하면 그 브라우저만
사이트 데이터를 한 번 지우면 된다.

### 그다음: 파일명을 내용에 맞춘다 (선택)

헤더만으로도 정확성은 확보된다. 다만 모든 자산이 매 로드마다 304 를 한 번씩 주고받는다.
LAN 에서는 무시할 수준이지만, 원래 구조대로 돌리고 싶으면 파일명을 고친다.

```bash
./rehash-branding.sh --dry-run   # 뭘 바꿀지만 확인
./rehash-branding.sh             # 백업 후 적용
./rehash-branding.sh --verify    # 참조가 깨진 데 없는지 검사
```

하는 일은 네 가지다.

1. `branding/` 안에서 `-[A-Z0-9]{8}.(js|css|svg)` 패턴의 파일을 찾는다.
2. 실제 내용의 sha256 으로 새 8자 해시를 만들어 이름을 바꾼다.
3. 참조하는 곳(`index.html`, 다른 브랜딩 js, `docker-compose.yml` 마운트 경로)을 같이 고친다.
4. `branding/rehash.map` 에 `새 이름 → 순정 원본 이름` 을 기록한다.

내용이 안 바뀌었으면 같은 해시가 나오므로 여러 번 돌려도 안전하다. 적용 후 webserver 를
다시 만들어야 새 마운트가 붙는다.

```bash
cd /opt/clearml && docker compose -p clearml up -d --no-build --force-recreate webserver
curl -s http://localhost:8080/ | grep -o 'main-[A-Z0-9]*\.js'
```

### rehash.map 이 왜 필요한가

`check_mounts.sh` 는 "해시가 박힌 파일이 이미지 안에 없으면 버전 불일치" 로 판정해서 배포를
막는다. 이름을 바꾸면 새 이름은 당연히 순정 이미지에 없으므로, 이 검사가 항상 실패하게 된다.

그래서 `check_mounts.sh` 가 `rehash.map` 을 읽어 새 이름을 순정 원본 이름으로 되돌린 뒤
이미지를 조회한다. 버전 불일치를 잡아내는 능력은 그대로 유지된다.

### 이름을 못 바꾸는 파일

`assets/logo.svg`, `assets/small-logo-white.svg`, `favicon.ico` 처럼 해시가 없는 고정 이름
자산은 그대로 둔다. 앱 코드 여기저기서 이 경로를 박아 쓰는데, 우리가 마운트하지 않은 순정
chunk 도 참조할 수 있어서 이름을 바꾸면 404 가 난다.

그래서 로고 이미지 하나는 캐시에 남을 수 있다. UI 전체가 순정으로 보이는 큰 증상은
`main-*.js` 가 원인이라 이걸로 해결되고, 로고까지 확실히 하려면 그 서버 첫 접속 때
한 번만 사이트 데이터를 지우면 된다.

---

## 10. 서버 고유 서명 키

ClearML 은 JWT 서명 키가 기본 설정에 박혀 있고, **그 값은 GitHub 에 공개돼 있다.**

```
apiserver/config/default/secure.conf
  auth.token_secret: "Rq8FW84sSqVgq7WvBB_4EzNl9y8z8IGiDXX3C345_a5AZfcwZcwCIA"
```

그대로 두면 두 가지가 걸린다.

1. **낡은 토큰이 살아 있다.** 서명 키가 Mongo 가 아니라 설정에 있으니, DB 를 새로 만들어도
   예전 토큰의 서명은 그대로 통과한다. 사용자 ID 만 없어서 401 이 아니라 400 이 나오고,
   UI 가 로그인 화면으로 못 넘어간다. 8장의 "헤더·사이드바가 안 그려진다" 가 이것이다.
2. **누구나 관리자 토큰을 위조할 수 있다.** 공개된 키로 서명하면 apiserver 가 받아들인다.
   `:8008` 에 닿을 수 있으면 끝이다. ClearML 도 배포 시 반드시 바꾸라고 명시한다.

### 어떻게 넣는가

`packaging/gen-secrets.sh` 가 `/opt/clearml/.env` 에 56자 난수를 만들어 넣고,
compose 가 그 값을 apiserver 와 fileserver 에 환경변수로 넘긴다.

```yaml
CLEARML__secure__auth__token_secret: ${CLEARML_TOKEN_SECRET:?...}
CLEARML__secure__http__session_secret__apiserver: ${CLEARML_SESSION_SECRET:?...}
```

`:?` 를 붙여서 값이 없으면 compose 가 아예 기동을 거부한다. 빈 문자열로 조용히 서명하는
것보다 멈추는 쪽이 안전하다.

```bash
./gen-secrets.sh            # 없을 때만 생성 (있으면 유지)
./gen-secrets.sh --show     # 현재 상태만 확인
./gen-secrets.sh --rotate   # 키 교체 — 전원 재로그인 필요
```

### 번들에 안 들어간다

`pack.sh` 는 `/opt/clearml/.env` 를 tar 에서 제외한다. 서명 키가 서버 밖으로 나가지 않고,
대상 서버는 `install.sh` 4단계에서 자기 키를 새로 만든다. 주소 값은 그 뒤
`apply-servers.sh` 가 같은 `.env` 에 채운다. 두 스크립트 모두 지정한 키만 건드린다.

### 적용하면 무엇이 끊기나

이미 발급된 로그인 세션이 전부 무효가 된다. 브라우저에서 다시 로그인하면 끝이다.
SDK·agent 의 `access_key`/`secret_key` 는 Mongo 에 있는 값이라 영향이 없다.
이 키들로 토큰을 다시 발급받을 뿐이다.
