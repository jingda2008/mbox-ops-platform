FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S mbox && adduser -S -G mbox mbox && mkdir /data && chown mbox:mbox /data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/database ./database
USER mbox
ENV MBOX_JSON_STATE_PATH=/data/state.json
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -q -O - http://127.0.0.1:8787/api/live || exit 1
CMD ["node", "dist-server/server/index.js"]
