# Build context: repo root  (so tools/crawlers manifests are accessible)
# Usage: docker build -f app/api/Dockerfile -t fortigraph-backend .

# ── Stage 1: Build frontend ───────────────────────────────────────────────────
# Layout mirrors the repo root (app/ui/ + tools/crawlers/ as siblings) because
# CrawlersPage.jsx discovers crawler wizards via a repo-root-relative
# import.meta.glob('../../../../tools/crawlers/*/ConfigWizard.jsx') — vite build
# resolves that glob against the filesystem, so tools/crawlers must be present
# four levels up from src/components at build time, not just at dev-server time.
# node_modules is installed at /build (not app/ui/node_modules) so Node's
# ancestor-walk module resolution can find "react" etc. from files under
# tools/crawlers/ too — they aren't descendants of app/ui.
# Base images are pinned by digest (SEC-2026-09 M-14) so a rebuild can't silently
# pick up a different image behind the same tag. The tag is kept in the comment
# for readability; refresh both together when bumping.
# node:24-slim
FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS frontend-build
WORKDIR /build
COPY app/ui/package*.json ./
RUN npm ci
COPY app/ui/ ./app/ui/
COPY tools/crawlers ./tools/crawlers
RUN npm --prefix app/ui run build

# ── Stage 2: Backend runtime ──────────────────────────────────────────────────
# node:24-slim (same digest as the build stage)
FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime

# Bake the module version into the image so /api/version returns the full
# version string (e.g. 5.0.20260414.0900) without needing the .psd1 file.
# Passed as a build arg by docker-publish.yml and docker-compose.yml.
ARG MODULE_VERSION=""
ENV MODULE_VERSION=$MODULE_VERSION

WORKDIR /app/backend
COPY app/api/package*.json ./
RUN npm ci --omit=dev
COPY app/api/src ./src
# Copy crawler manifests so the API can auto-discover valid job types and their
# config schemas at startup. PS1 scripts are removed — the web container is
# Node.js only; scripts belong in the worker image.
COPY tools/crawlers /app/crawlers
RUN find /app/crawlers -name "*.ps1" -delete
ENV CRAWLER_MANIFESTS_DIR=/app/crawlers
# Copy the compiled frontend so Express can serve it as static files
COPY --from=frontend-build /build/app/ui/dist ../frontend/dist

EXPOSE 3001
# Create the uploads and key directories with node ownership BEFORE switching
# user. The job_data volume mounts on /data/uploads (shared with the worker);
# the web-only key volume mounts on /data/keys and holds the vault master key
# (IDENTITY_ATLAS_KEY_DIR, see secrets/masterKeyStore.js). Docker initialises an
# empty named volume from the image's mount-point, so the ownership and the 0700
# mode set here carry over to a freshly created volume.
RUN mkdir -p /data/uploads /data/keys && chown -R node:node /data && chmod 0700 /data/keys
USER node

# Container health: the API is up once /api/version (public, unauthenticated)
# answers 200. Uses node directly — the slim base image ships no curl/wget — and
# honours $PORT. Orchestrators / compose can then gate dependents on readiness
# via `depends_on: { condition: service_healthy }`.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/version',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

CMD ["node", "src/index.js"]
