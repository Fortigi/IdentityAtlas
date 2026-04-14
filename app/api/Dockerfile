# Build context: ./app  (contains api/ and ui/)
# Usage: docker build -f api/Dockerfile -t fortigraph-backend .

# ── Stage 1: Build frontend ───────────────────────────────────────────────────
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY ui/package*.json ./
RUN npm ci
COPY ui/ .
RUN npm run build

# ── Stage 2: Backend runtime ──────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Bake the module version into the image so /api/version returns the full
# version string (e.g. 5.0.20260414.0900) without needing the .psd1 file.
# Passed as a build arg by docker-publish.yml and docker-compose.yml.
ARG MODULE_VERSION=""
ENV MODULE_VERSION=$MODULE_VERSION

WORKDIR /app/backend
COPY api/package*.json ./
RUN npm ci --omit=dev
COPY api/src ./src
# Copy the compiled frontend so Express can serve it as static files
COPY --from=frontend-build /app/frontend/dist ../frontend/dist

EXPOSE 3001
# Create the uploads directory with node ownership BEFORE switching user.
# The job_data volume mounts here; Docker creates the mount-point as root
# if it doesn't exist, and the node user can't write to it.
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
CMD ["node", "src/index.js"]
