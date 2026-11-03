FROM oven/bun:1.4.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production

FROM oven/bun:1.4.2-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules node_modules
COPY --chown=bun:bun . .
USER bun
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 5001) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "src/index.ts"]
