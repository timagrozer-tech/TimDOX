FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DATA_DIR=/data UPLOAD_DIR=/data/uploads

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static
COPY scripts ./scripts

RUN useradd --create-home krug && mkdir -p /data/uploads && chown -R krug /data
USER krug

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"8000\")}/api/health')"
# Один процесс: события реального времени хранятся в памяти (см. README, «Масштабирование»)
# PORT задаёт хостинг (Render, Railway и др.), по умолчанию 8000
CMD ["sh", "-c", "python -m scripts.bootstrap && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips '*' --timeout-graceful-shutdown 5"]
