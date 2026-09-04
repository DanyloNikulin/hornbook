# Hornbook, hosted: the same server, listening on all interfaces, with the
# journal on a volume. Put a password on it (HORNBOOK_PASSWORD) or an access
# proxy in front — it is one owner's journal, not a multi-user service.
#
#   docker build -t hornbook .
#   docker run -p 8787:8787 -v hornbook-journal:/journal -e HORNBOOK_PASSWORD=change-me hornbook
#
# Local models from inside the container: point OLLAMA_HOST at the host
# (http://host.docker.internal:11434) in Settings; whisper.cpp needs its
# binary and model on the volume or in a derived image.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/DanyloNikulin/hornbook
ENV NODE_ENV=production \
    HORNBOOK_HOST=0.0.0.0 \
    HORNBOOK_PORT=8787 \
    HORNBOOK_JOURNAL=/journal
LABEL org.opencontainers.image.title="Hornbook" \
      org.opencontainers.image.description="Local-first conspect journal for one-to-one language lessons" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.source="$SOURCE" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/journal ./journal
RUN mkdir -p /journal && chown node:node /journal
USER node
VOLUME ["/journal"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const net=require('node:net');const socket=net.connect(8787,'127.0.0.1',()=>{socket.end();process.exit(0)});socket.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000).unref()"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/node/server/cli.js", "serve"]
