# Standalone frontend dev container with hot reload.
# Not used by docker-compose.local.yml (backend serves the built frontend there).
# Useful for frontend-only development work.
#
# Usage:
#   docker build -t fortigraph-frontend .
#   docker run -p 5173:5173 -v $(pwd)/src:/app/src fortigraph-frontend

FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

EXPOSE 5173
USER node
CMD ["npm", "run", "dev", "--", "--host", "--port", "5173"]
