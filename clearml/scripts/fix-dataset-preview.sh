#!/usr/bin/env bash
# Restore dataset preview paths after Detector/VLM/Dataset rename.
# Preview thumbnails in ClearML Datasets UI read from fileserver paths stored in ES.
set -euo pipefail

FS="${CLEARML_FILESERVER_ROOT:-/opt/clearml/data/fileserver}"

echo "▶ Legacy fileserver symlinks under ${FS}"

if [ ! -e "${FS}/Intellivix-Datasets" ]; then
  ln -s Dataset "${FS}/Intellivix-Datasets"
  echo "  Intellivix-Datasets -> Dataset"
fi

if [ ! -e "${FS}/Dataset/.datasets/detector-dataset" ]; then
  ln -sf Detector "${FS}/Dataset/.datasets/detector-dataset"
  echo "  Dataset/.datasets/detector-dataset -> Detector"
fi

if [ ! -e "${FS}/Dataset/.datasets/vlm-dataset" ]; then
  ln -sf VLM "${FS}/Dataset/.datasets/vlm-dataset"
  echo "  Dataset/.datasets/vlm-dataset -> VLM"
fi

echo "▶ Reload nginx (legacy /files/ rewrite)"
docker exec clearml-webserver nginx -t
docker exec clearml-webserver nginx -s reload

echo "Done. Refresh the Datasets page in ClearML."
