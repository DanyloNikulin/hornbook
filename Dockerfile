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
ENV NODE_ENV=production \
    HORNBOOK_HOST=0.0.0.0 \
    HORNBOOK_PORT=8787 \
    HORNBOOK_JOURNAL=/journal
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src/lib ./src/lib
COPY --from=build /app/journal ./journal
COPY --from=build /app/tsconfig.json /app/tsconfig.scripts.json ./
VOLUME ["/journal"]
EXPOSE 8787
CMD ["node", "--import", "tsx", "server/cli.ts", "--no-open"]
