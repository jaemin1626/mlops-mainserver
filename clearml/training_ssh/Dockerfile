FROM python:3.12-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client sshpass \
    && rm -rf /var/lib/apt/lists/*
ARG TRAINING_SSH_UID=1000
ARG TRAINING_SSH_GID=1000
RUN groupadd -g "${TRAINING_SSH_GID}" runner \
    && useradd -m -u "${TRAINING_SSH_UID}" -g runner runner
WORKDIR /app
COPY client.py metrics_poller.py annotation_builder.py transfer_annotations.py annotation_api.py detector.py vlm.py vlm_options.py dataset_registry.py dataset_api.py mlops_dataset_tree.py deploy.py training_cleanup.py /app/
ENTRYPOINT ["python", "/app/client.py"]
CMD ["doctor"]
