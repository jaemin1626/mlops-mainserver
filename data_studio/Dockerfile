FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
COPY CHANGELOG.md ./CHANGELOG.md
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_STUDIO_PORT=8091 \
    DATA_STUDIO_ALLOWED_ROOTS=/data/datasets \
    DATA_STUDIO_VIDEO_CACHE=/tmp/data-studio-video-cache
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY --from=build /app/dist ./dist
EXPOSE 8091
CMD ["node", "server/index.js"]
