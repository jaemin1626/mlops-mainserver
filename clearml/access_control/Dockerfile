FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir bcrypt==4.2.1 pymongo==4.10.1
COPY app.py manage.py /app/
RUN useradd -r -u 1000 access
USER access
EXPOSE 8095
CMD ["python", "/app/app.py"]
