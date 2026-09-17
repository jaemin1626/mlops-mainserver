FROM python:3.12-slim-bookworm
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    SEOUL_STUDIO_HOST=0.0.0.0 \
    SEOUL_STUDIO_PORT=7860 \
    SEOUL_STUDIO_BASE_PATH=/seoul-studio \
    SEOUL_STUDIO_OUTPUT_DIR=/data/output \
    SEOUL_STUDIO_DATASETS_DIR=/data/datasets \
    SEOUL_STUDIO_CONFIG=/data/config/config.json \
    SEOUL_STUDIO_WORKFLOW_DIR=/app/workflows

COPY requirements.txt .
ENV SEOUL_STUDIO_YOLOV7_DIR=/app/yolov7

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r requirements.txt \
    && git clone --depth 1 https://github.com/WongKinYiu/yolov7.git /app/yolov7 \
    && rm -rf /app/yolov7/.git \
    && pip install --no-cache-dir seaborn

COPY src ./src
COPY workflows ./workflows

RUN mkdir -p /data/output /data/config /data/datasets

EXPOSE 7860
CMD ["python", "-m", "seoul_studio"]
