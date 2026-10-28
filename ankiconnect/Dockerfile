FROM python:3.13-slim-bookworm
WORKDIR /app
# requirements.txt is compiled from requirements.in with hashes:
#   uv pip compile requirements.in --universal --python-version 3.13 --generate-hashes --no-header -o requirements.txt
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY server.py .
# The same unprivileged uid as the host image, so both can share one owner of
# their bind-mounted folders.
RUN useradd --uid 1000 --no-create-home --shell /usr/sbin/nologin anki && mkdir /data && chown anki:anki /data
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ANKI_COLLECTION=/data/collection.anki2
USER anki
EXPOSE 8765
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s CMD python -c "import os,urllib.request;bind=os.environ.get('ANKICONNECT_BIND','127.0.0.1');host='127.0.0.1' if bind=='0.0.0.0' else bind;urllib.request.urlopen(f'http://{host}:{os.environ.get(\"ANKICONNECT_PORT\",\"8765\")}/health',timeout=4)"
CMD ["python", "server.py"]
