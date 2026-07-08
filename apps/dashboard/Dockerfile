# Build context is the REPO ROOT (see docker-compose.prod.yml).
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @guildpay/shared build \
 && pnpm --filter @guildpay/dashboard build

FROM node:20-slim
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
CMD ["pnpm", "--filter", "@guildpay/dashboard", "start"]
