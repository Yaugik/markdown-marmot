FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/vitest.config.ts ./vitest.config.ts
COPY --from=build /app/eslint.config.mjs ./eslint.config.mjs
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data /workspace-repos
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "run", "start"]
