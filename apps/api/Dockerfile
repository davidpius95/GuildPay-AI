# Build context is the REPO ROOT (see docker-compose.prod.yml).
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @guildpay/shared build \
 && pnpm --filter @guildpay/api build

FROM node:20-slim
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
