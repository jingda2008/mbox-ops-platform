# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
ARG APP_COMMIT_SHA=development
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=mbox-normalized-build-npm,target=/root/.npm npm ci
COPY . .
RUN APP_COMMIT_SHA="${APP_COMMIT_SHA}" npm run build:normalized

FROM node:24-alpine AS runtime
# Channel posters render Chinese text through libvips/librsvg. The base Node
# image has no CJK fonts; installing these avoids blank/tofu production posters.
RUN apk add --no-cache font-noto-cjk && fc-cache -f
ARG APP_COMMIT_SHA=development
ARG APP_RELEASE_VERSION=development
LABEL org.opencontainers.image.revision="${APP_COMMIT_SHA}"
LABEL org.opencontainers.image.version="${APP_RELEASE_VERSION}"
LABEL com.mbox.schema-flavor="normalized-core-v1"

ENV NODE_ENV=production \
  PORT=8787 \
  XDG_CACHE_HOME=/tmp/mbox-cache \
  MBOX_STATIC_DIR=/app/dist
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,id=mbox-normalized-runtime-npm,target=/root/.npm \
  npm ci --omit=dev --ignore-scripts

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-normalized ./dist-normalized
COPY --from=build --chown=node:node /app/database/normalized-migrations ./dist-normalized/database/normalized-migrations
COPY --from=build --chown=node:node /app/scripts/filter-sls-events.mjs ./scripts/filter-sls-events.mjs

USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=4s --start-period=25s --retries=4 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/api/ready" >/dev/null || exit 1
CMD ["node", "dist-normalized/server/normalized-server.js"]
