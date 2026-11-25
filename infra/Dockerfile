FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tools/check-production-build.mjs ./tools/
RUN pnpm install --frozen-lockfile
# The command-line client too, so `ledger` commands can run from the image against its API (infra/compose.try.yaml).
RUN pnpm --filter @ledger/api... --filter @ledger/workers... --filter @ledger/simulator... --filter @ledger/adapter-host... --filter @ledger/cli... build
# The web app is served from the API's own origin, so it calls the API with relative URLs and needs no API URL; it
# reads the sign-in settings from the API when it starts.
RUN pnpm --filter @ledger/web... build && node tools/check-production-build.mjs

FROM eclipse-mosquitto:2.0.22@sha256:199ea8ef2e35ec2b1b37e59cfd1dbae538ed4dfa4a2251a121a52215a6248a21 AS mqtt

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
# A production start: the API (which also serves the web app) and the workers, nothing else. The emulators and the
# simulator are development tools that start only when asked (LEDGER_EMULATORS=1, SIMULATOR_RUNTIME_MODE). An adapter
# process for a source starts only when LEDGER_ADAPTER names one, or as its own container with the command adapter.
ENV NODE_ENV=production LEDGER_ENV=staging HOST=0.0.0.0 PORT=4000 LEDGER_WEB_DIR=/app/apps/web/dist
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# The pinned Alpine broker runs through its own musl loader, independent of Debian glibc.
COPY --from=mqtt /lib/ /opt/mosquitto/lib/
COPY --from=mqtt /usr/lib/ /opt/mosquitto/usr/lib/
COPY --from=mqtt /usr/sbin/mosquitto /opt/mosquitto/usr/sbin/mosquitto
COPY --from=mqtt /usr/share/licenses/mosquitto /opt/mosquitto/licenses
COPY --chown=node:node infra/scripts/supervise.mjs infra/scripts/mqtt-runtime.mjs infra/scripts/runtime-entrypoint.mjs infra/scripts/runtime-config.mjs infra/scripts/runtime-processes.mjs infra/scripts/runtime-readiness.mjs infra/scripts/verify-mqtt-runtime.mjs /app/infra/scripts/
RUN mkdir -p /app/.local && chown node:node /app/.local
# Only fixed volume initialization runs as root; the entrypoint clears groups and drops to1000.
USER root
EXPOSE 4000
ENTRYPOINT ["node", "infra/scripts/runtime-entrypoint.mjs"]
CMD ["supervise"]
