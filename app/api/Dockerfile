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
