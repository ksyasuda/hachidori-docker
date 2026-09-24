FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY scripts/fetch-upstream.py scripts/fetch-upstream.py
RUN python3 scripts/fetch-upstream.py

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 util-linux ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/ /app/
COPY src/ src/
COPY public/ public/
COPY scripts/import.mjs scripts/import.mjs
COPY LICENSE NOTICE README.md ./
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data LISTEN_ADDRESS=0.0.0.0 RELAY_NETWORK=true IMPORT_DIR=/imports
USER node
EXPOSE 8771 8780 19633
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s CMD node -e "const bind=process.env.LISTEN_ADDRESS;const host=!bind||bind==='0.0.0.0'?'127.0.0.1':bind;fetch('http://'+host+':'+(process.env.ADMIN_PORT||8780)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["flock", "--no-fork", "--nonblock", "/data/host.lock", "node", "src/server.mjs"]
