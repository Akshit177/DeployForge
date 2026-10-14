FROM alpine:3.20 AS builder

RUN apk add --no-cache g++ make hiredis-dev git

WORKDIR /build
COPY . .
RUN make clean && make all

FROM alpine:3.20

RUN apk add --no-cache hiredis libstdc++ git docker-cli curl

WORKDIR /app
COPY --from=builder /build/bin/deployforge-worker /app/deployforge-worker

ENV REDIS_HOST=redis
ENV REDIS_PORT=6379
ENV WORKSPACE_BASE_PATH=/var/lib/deployforge/workspaces
ENV DOCKER_SOCK=/var/run/docker.sock
ENV DOCKER_MODE=real

CMD ["/app/deployforge-worker"]
