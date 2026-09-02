#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# 원격 서버에서 직접 실행하는 설치 스크립트
# 원격 서버에 이 파일과 monitoring-deploy/ 폴더를 복사 후 실행
#
# 사용법:
#   1. scp -r clearml-monitoring/ user@<서버>:/opt/clearml/
#      (또는 git clone mlops-mainserver → /opt/clearml)
#   2. ssh user@<서버>
#   3. cd /opt/clearml/clearml-monitoring/monitoring-deploy && ./remote-install.sh
#
# 서버 주소는 /opt/clearml/servers.conf 한 곳에서 관리한다.
# ──────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

SERVERS_CONF="${SERVERS_CONF:-/opt/clearml/servers.conf}"
if [ -f "$SERVERS_CONF" ]; then
  # shellcheck disable=SC1090
  . "$SERVERS_CONF"
else
  echo -e "${YELLOW}[경고]${NC} ${SERVERS_CONF} 없음 → localhost 기준으로 진행합니다."
fi

CLEARML_IP="${CLEARML_SERVER_IP:-localhost}"
MON_IP="${MONITORING_SERVER_IP:-$CLEARML_IP}"
CLEARML_WEB="http://${CLEARML_IP}:${CLEARML_WEB_PORT:-8080}"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}   ClearML 모니터링 스택 설치 (로컬 실행)                   ${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# ── API Key 입력 ───────────────────────────────────────────────
if [ -f ".env" ] && grep -q "CLEARML_ACCESS_KEY=." .env; then
  source .env
  echo -e "${GREEN}[OK]${NC} 기존 .env에서 API Key를 읽었습니다."
else
  cp .env.example .env
  echo ""
  echo -e "  ClearML 웹: ${BLUE}${CLEARML_WEB}${NC}"
  echo -e "  프로필 → Settings → Workspace → Create new credentials"
  echo ""
  read -r -p "  Access Key : " INPUT_ACCESS_KEY
  echo -n "  Secret Key : "
  read -rs INPUT_SECRET_KEY
  echo ""

  # 검증
  echo -e "${YELLOW}[INFO]${NC} API Key 유효성 확인..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X GET "${CLEARML_WEB}/auth.login" \
    -u "${INPUT_ACCESS_KEY}:${INPUT_SECRET_KEY}" 2>/dev/null)

  if [ "$HTTP_CODE" != "200" ]; then
    echo -e "${RED}[ERROR]${NC} API Key 인증 실패 (HTTP ${HTTP_CODE})"
    exit 1
  fi
  echo -e "${GREEN}[OK]${NC} 인증 성공"

  sed -i "s|^CLEARML_ACCESS_KEY=.*|CLEARML_ACCESS_KEY=${INPUT_ACCESS_KEY}|" .env
  sed -i "s|^CLEARML_SECRET_KEY=.*|CLEARML_SECRET_KEY=${INPUT_SECRET_KEY}|" .env
fi

# ── 데이터 디렉터리 권한 ───────────────────────────────────────
echo -e "${YELLOW}[INFO]${NC} 데이터 디렉터리 권한 설정..."
mkdir -p data/prometheus data/grafana
sudo chown -R 65534:65534 data/prometheus 2>/dev/null || chmod -R 777 data/prometheus
sudo chown -R 472:472 data/grafana 2>/dev/null || chmod -R 777 data/grafana
echo -e "${GREEN}[OK]${NC} 권한 설정 완료"

# ── 빌드 + 시작 ───────────────────────────────────────────────
echo -e "${YELLOW}[INFO]${NC} 이미지 빌드 중..."
docker compose build clearml-exporter

echo -e "${YELLOW}[INFO]${NC} 서비스 시작..."
docker compose up -d

echo -e "${YELLOW}[INFO]${NC} 기동 대기 (30초)..."
sleep 30

# ── 결과 ──────────────────────────────────────────────────────
echo ""
GRAFANA_OK=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${GRAFANA_PORT:-3000}/api/health" 2>/dev/null)
PROM_OK=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PROMETHEUS_PORT:-9091}/-/ready" 2>/dev/null)
EXP_OK=$(curl -s "http://localhost:${EXPORTER_PORT:-9090}/metrics" 2>/dev/null | grep "^clearml_projects_total" | head -1)

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN} 설치 완료!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Grafana   : ${BLUE}http://${MON_IP}:${GRAFANA_PORT:-3000}${NC}  ($([ "$GRAFANA_OK" = "200" ] && echo "✅ OK" || echo "기동 중"))"
echo -e "  계정      : ${GRAFANA_ADMIN_USER:-admin} / ${GRAFANA_ADMIN_PASSWORD:-clearml123!}"
echo -e "  대시보드  : ${BLUE}http://${MON_IP}:${GRAFANA_PORT:-3000}/d/clearml-mlops-main${NC}"
echo -e "  Prometheus: ${BLUE}http://${MON_IP}:${PROMETHEUS_PORT:-9091}${NC}  ($([ "$PROM_OK" = "200" ] && echo "✅ OK" || echo "기동 중"))"
echo ""
[ -n "$EXP_OK" ] && echo -e "  메트릭 수집: ${GREEN}$EXP_OK${NC}" || echo -e "  메트릭: 60초 후 수집 시작"
echo ""
echo -e "  방화벽에서 열어야 할 포트: ${YELLOW}${GRAFANA_PORT:-3000}, ${EXPORTER_PORT:-9090}, ${PROMETHEUS_PORT:-9091}${NC}"
echo ""
docker compose ps
