# ClearML MLOps 모니터링 시스템 아키텍처

## 1. 전체 시스템 구성도

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          MLOps 모니터링 스택                              │
│                                                                         │
│  ┌──────────────┐     ┌──────────────────┐     ┌────────────────────┐  │
│  │   ClearML    │────▶│ ClearML Exporter │────▶│    Prometheus      │  │
│  │  API Server  │ REST│  (Python)        │HTTP │   (Time Series DB) │  │
│  │  :8008       │     │  :9090           │     │   :9091            │  │
│  └──────────────┘     └──────────────────┘     └────────────────────┘  │
│                                                          │              │
│                                                     PromQL 쿼리         │
│                                                          ▼              │
│                                                ┌────────────────────┐  │
│                                                │      Grafana       │  │
│                                                │   (대시보드 UI)     │  │
│                                                │   :3000            │  │
│                                                └────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 데이터 흐름 상세 다이어그램

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ClearML API Server (:8008)                        │
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  Projects   │  │    Tasks    │  │   Datasets  │  │     Models      │  │
│  │  (45개)     │  │  (92개)     │  │   (12개)    │  │    (748개)      │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘  │
└───────────────────────────┬─────────────────────────────────────────────────┘
                            │ REST API (60초 주기)
                            │ tasks.get_all_ex
                            │ projects.get_all_ex
                            │ models.get_all_ex
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      ClearML Exporter (:9090)                               │
│                      (Python + prometheus_client)                           │
│                                                                             │
│  수집 항목                          생성 메트릭                              │
│  ──────────────────────────────────────────────────────────────────────    │
│  • 프로젝트/태스크 현황          → clearml_projects_total                   │
│                                  → clearml_tasks_total{project, status}    │
│                                  → clearml_running_tasks_total             │
│                                                                             │
│  • 모델별 학습 이력              → clearml_task_last_run_timestamp          │
│    (started, completed)          → clearml_task_last_run_duration          │
│                                  → clearml_task_avg_duration               │
│                                  → clearml_task_training_frequency         │
│                                  → clearml_task_training_count_in_window   │
│                                                                             │
│  • 현재 학습 중 태스크           → clearml_active_task_epoch               │
│    (last_iteration, hyperparams)    {model, version, started_fmt,          │
│                                      total_epochs, sec_per_epoch}          │
│                                                                             │
│  • 모델 성능 지표                → clearml_task_perf_map50                  │
│    (last_metrics)                → clearml_task_perf_map50_95              │
│                                  → clearml_task_perf_precision             │
│                                  → clearml_task_perf_f1                   │
│                                  → clearml_task_perf_accuracy_latest       │
│                                                                             │
│  • 버전별 성능 이력              → clearml_task_perf_accuracy_history       │
│    (unix_ts 레이블)                 {model, task_name, unix_ts}            │
│                                  → clearml_task_perf_detection_history     │
│                                     {model, task_name, metric_type,        │
│                                      unix_ts}                              │
│                                                                             │
│  • 데이터셋 현황                 → clearml_datasets_total                   │
│                                  → clearml_dataset_file_count              │
│                                  → clearml_dataset_size_bytes              │
│                                  → clearml_dataset_status_info             │
└───────────────────────────┬─────────────────────────────────────────────────┘
                            │ HTTP /metrics (Prometheus scrape)
                            │ scrape_interval: 60s
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Prometheus (:9091)                                  │
│                         (Time Series Database)                              │
│                                                                             │
│  • 수집된 메트릭을 시계열 DB에 저장                                          │
│  • PromQL 쿼리 엔진 제공                                                    │
│  • instant query / range query 지원                                         │
│  • 30일치 데이터 보존                                                       │
└───────────────────────────┬─────────────────────────────────────────────────┘
                            │ PromQL (instant query)
                            │ 대시보드 조회 시
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Grafana (:3000)                                   │
│                           (시각화 대시보드)                                  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  ClearML MLOps 대시보드 (clearml-mlops-main)                         │  │
│  │                                                                      │  │
│  │  ① 전체 현황 요약                                                    │  │
│  │     프로젝트 수 / 태스크 수 / 학습중 모델 / 데이터셋 / 등록 모델     │  │
│  │                                                                      │  │
│  │  ② 현재 학습 중인 모델 (실시간)                        [NEW]         │  │
│  │     모델명 / 버전 / 시작시각 / 현재Epoch / 전체Epoch                │  │
│  │     진행률(게이지) / 1Epoch 소요시간                                 │  │
│  │                                                                      │  │
│  │  ③ 모델별 학습 현황                                                  │  │
│  │     마지막 학습 시각 / 평균 소요시간 / YTD 누계                      │  │
│  │     vs 평균 비교 / 소요시간 막대그래프                               │  │
│  │                                                                      │  │
│  │  ④ 모델 성능 지표                                                    │  │
│  │     Detection: mAP@50, mAP@50-95, Precision, F1                     │  │
│  │     Classification: 정확도(Valid mA)                                 │  │
│  │     [클릭] → 버전별 성능 추이 팝업                   [NEW]          │  │
│  │                                                                      │  │
│  │  ⑤ 버전별 성능 추이 (팝업 패널)                       [NEW]         │  │
│  │     X축: 버전명 / Y축: 성능 지표                                    │  │
│  │     학습완료일 순 정렬 (unix_ts 레이블 활용)                         │  │
│  │                                                                      │  │
│  │  ⑥ 데이터셋 구축 현황                                               │  │
│  │     용량 추이 / 파일 수 추이 / 완료 상태                            │  │
│  │                                                                      │  │
│  │  ⑦ 프로젝트별 태스크 분포                                           │  │
│  │     상태별 태스크 수 / 실행 중 태스크 추이                          │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 핵심 메트릭 구조

### 3-1. 현재 학습 중인 태스크 (실시간)
```
clearml_active_task_epoch{
    model        = "OBD_BASE_IR",           ← 프로젝트 단축명
    version      = "5th_train",             ← 태스크명(버전)
    started_fmt  = "2026-03-01 05:58",      ← 학습 시작 시각
    total_epochs = "200",                   ← 전체 epoch 수
    sec_per_epoch= "3181"                   ← 1epoch 평균 소요(초)
} = 112                                     ← 현재 epoch
```

### 3-2. 버전별 성능 이력 (Classification)
```
clearml_task_perf_accuracy_history{
    model     = "02_OBR_PERSON_ATTR",
    task_name = "[배포]v1.0.6",
    unix_ts   = "1769516533529"             ← 학습완료 epoch ms
} = 0.9348
```

### 3-3. 버전별 성능 이력 (Detection)
```
clearml_task_perf_detection_history{
    model       = "OBD_BASE_IR",
    task_name   = "OBD_BASE_IR_862_TEST",
    metric_type = "map50",                  ← map50 / map50_95 / precision / f1
    unix_ts     = "1770619339575"
} = 0.7014
```

---

## 4. 인프라 구성 (Docker Compose)

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Compose Stack                     │
│                                                             │
│  ┌─────────────────┐   ┌──────────────┐  ┌─────────────┐  │
│  │ clearml-exporter│   │  prometheus  │  │   grafana   │  │
│  │                 │   │              │  │             │  │
│  │ Python 3.11     │   │ v3.10.0      │  │ v12.4.0     │  │
│  │ port: 9090      │   │ port: 9091   │  │ port: 3000  │  │
│  │ interval: 60s   │   │              │  │             │  │
│  └────────┬────────┘   └──────┬───────┘  └──────┬──────┘  │
│           │                   │                  │         │
│           └───────────────────┴──────────────────┘         │
│                         Docker Network                      │
│                                                             │
│  Volume 마운트                                              │
│  • ./config/prometheus  → prometheus 설정                  │
│  • ./config/grafana     → 대시보드 JSON, 프로비저닝 설정   │
│  • ./data/prometheus    → 시계열 데이터 영속화             │
│  • ./data/grafana       → Grafana 플러그인 영속화          │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. 데이터 수집 주기 및 흐름 요약

| 단계 | 컴포넌트 | 동작 | 주기 |
|------|----------|------|------|
| 1 | ClearML Exporter | ClearML API 호출 (tasks, projects, models) | 60초 |
| 2 | ClearML Exporter | Prometheus 메트릭 포맷으로 변환 | 즉시 |
| 3 | Prometheus | Exporter `/metrics` 엔드포인트 스크랩 | 60초 |
| 4 | Prometheus | 시계열 DB에 저장 | 즉시 |
| 5 | Grafana | 대시보드 패널별 PromQL 쿼리 | 조회 시 |
| 6 | Grafana | 자동 새로고침 | 30초 |

---

## 6. 주요 기술적 특징

### 버전별 성능 이력 표시 방법
- **문제**: Prometheus는 과거 타임스탬프 데이터 수집 불가 (3.x 정책)
- **해결**: `unix_ts` 레이블(epoch ms 문자열)에 학습완료 시각 저장  
  → Grafana `barchart` + `organize` 변환으로 버전 순서대로 표시

### 실시간 학습 진행률
- ClearML `last_iteration` = 현재 epoch
- ClearML `hyperparams.General.epochs` = 전체 epoch
- `sec_per_epoch` = 경과시간 / 현재 epoch (exporter에서 계산)

### 프로비저닝 자동화
- Grafana 대시보드 JSON을 파일로 관리 (`config/grafana/dashboards/`)
- 컨테이너 재시작 시 자동 복원
- Exporter가 수집 주기마다 Grafana API로 링크 URL 자동 갱신
