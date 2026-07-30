# syntax=docker/dockerfile:1

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
# The worker and signer are plain Node programs; compile them separately from Next.
# `src/lib` imports its own modules through the `@/*` tsconfig alias, which tsc leaves
# untouched at emit time, so `tsc-alias` rewrites those to relative paths. Passing
# `-f` (resolve-full-paths) also appends the `.js` extension Node's ESM loader requires
# on every relative specifier it touches -- without it, imports that were already
# relative in the source (e.g. `../src/lib/db/client`) are emitted extension-less and
# fail at runtime with ERR_MODULE_NOT_FOUND, even though the `@/` aliases resolve fine.
RUN pnpm run build:server

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app

COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/migrations ./migrations
COPY --from=deps   --chown=app:app /app/node_modules ./node_modules

USER app
EXPOSE 3000
CMD ["node", "server.js"]
