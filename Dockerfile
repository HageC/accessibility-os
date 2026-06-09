FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY .env.example ./.env
RUN corepack pnpm install --frozen-lockfile && corepack pnpm --filter @aos/database exec prisma generate

FROM base AS web
RUN corepack pnpm --filter @aos/web build
CMD ["corepack", "pnpm", "--filter", "@aos/web", "start"]

FROM base AS api
CMD ["corepack", "pnpm", "--filter", "@aos/api", "start"]

FROM base AS worker
RUN corepack pnpm --filter @aos/scanner exec playwright install --with-deps chromium
CMD ["corepack", "pnpm", "--filter", "@aos/worker", "start"]

FROM base AS migrate
CMD ["sh", "-c", "corepack pnpm db:migrate && corepack pnpm db:seed"]
