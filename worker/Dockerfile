FROM alpine:3.20 AS builder

RUN apk add --no-cache g++ make hiredis-dev git nlohmann-json

WORKDIR /build
COPY . .
RUN make clean && make worker

FROM alpine:3.20

RUN apk add --no-cache hiredis libstdc++ git docker-cli curl && \
    (getent group docker || addgroup -S docker) && \
    addgroup -S deployforge && \
    adduser -S deployforge -G deployforge && \
    addgroup deployforge docker && \
    mkdir -p /var/lib/deployforge/workspaces /app && \
    chown -R deployforge:deployforge /var/lib/deployforge /app

WORKDIR /app
COPY --chown=deployforge:deployforge --from=builder /build/bin/deployforge-worker /app/deployforge-worker

ENV REDIS_HOST=redis
ENV REDIS_PORT=6379
ENV WORKSPACE_BASE_PATH=/var/lib/deployforge/workspaces
ENV DOCKER_SOCK=/var/run/docker.sock
ENV DOCKER_MODE=real

USER deployforge

CMD ["/app/deployforge-worker"]
