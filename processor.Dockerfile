FROM oven/bun:1.4.2
USER root
RUN apt-get update && apt-get install -y --no-install-recommends clamav clamav-freshclam ca-certificates && rm -rf /var/lib/apt/lists/* && chown -R bun:bun /var/lib/clamav /var/log/clamav
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
USER bun
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun src/documents/ ./src/documents/
COPY --chown=bun:bun deploy/processor-entrypoint.sh ./processor-entrypoint.sh
ENV PORT=3030 DOCUMENTS_SCANNER=/usr/bin/clamscan AV_UPDATE_MARKER=/tmp/av-updated
EXPOSE 3030
ENTRYPOINT ["/bin/sh", "/app/processor-entrypoint.sh"]
