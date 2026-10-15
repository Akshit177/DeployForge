# ==============================================================================
# Stage 1: Build Frontend Single Page Application
# ==============================================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ==============================================================================
# Stage 2: Production DeployForge Control Plane API
# ==============================================================================
FROM node:20-alpine

WORKDIR /app

# Install git and docker-cli for repository management and container control
RUN apk add --no-cache git docker-cli

COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY --from=frontend-builder /build/frontend/dist /app/public

ENV PORT=3000
ENV NODE_ENV=production
ENV PUBLIC_DIR=/app/public

EXPOSE 3000

CMD ["node", "server.js"]
