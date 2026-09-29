#!/usr/bin/env bash
# Video Studio AI 프롬프트용 Ollama 모델 다운로드 (최초 1회)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${PROMPT_LLM_MODEL:-llama3.2:3b}"
CONTAINER="${OLLAMA_CONTAINER:-clearml-ollama}"

cd "$ROOT"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Ollama 컨테이너가 없습니다. 먼저: ./compose.sh up -d ollama" >&2
  exit 1
fi

echo "Pulling Ollama model: $MODEL"
docker exec "$CONTAINER" ollama pull "$MODEL"
docker exec "$CONTAINER" ollama list
echo "Done. seoul-studio 재시작: ./compose.sh up -d --force-recreate seoul-studio"
