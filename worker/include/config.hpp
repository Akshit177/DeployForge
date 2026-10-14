#pragma once

#include <string>
#include <cstdlib>
#include <unistd.h>
#include <sys/types.h>

namespace deployforge {

struct Config {
    std::string redis_host = "127.0.0.1";
    int redis_port = 6379;
    std::string redis_stream = "stream:deployments";
    std::string redis_group = "deployforge_workers";
    std::string redis_events_stream = "stream:deployment_events";

    std::string docker_sock = "/var/run/docker.sock";
    std::string docker_mode = "simulator"; // "real" or "simulator"

    std::string workspace_base_path = "/var/lib/deployforge/workspaces";
    std::string app_network = "deployforge-apps";
    std::string worker_id = "worker-cpp-" + std::to_string(getpid());
    int poll_block_ms = 1500;

    static Config loadFromEnv() {
        Config cfg;

        if (const char* v = std::getenv("REDIS_HOST")) cfg.redis_host = v;
        if (const char* v = std::getenv("REDIS_PORT")) cfg.redis_port = std::stoi(v);
        if (const char* v = std::getenv("REDIS_STREAM")) cfg.redis_stream = v;
        if (const char* v = std::getenv("REDIS_GROUP")) cfg.redis_group = v;
        if (const char* v = std::getenv("REDIS_EVENTS_STREAM")) cfg.redis_events_stream = v;

        if (const char* v = std::getenv("DOCKER_HOST")) {
            std::string host = v;
            if (host.rfind("unix://", 0) == 0) {
                cfg.docker_sock = host.substr(7);
            }
        } else if (const char* v = std::getenv("DOCKER_SOCK")) {
            cfg.docker_sock = v;
        }

        if (const char* v = std::getenv("DOCKER_MODE")) cfg.docker_mode = v;
        if (const char* v = std::getenv("WORKSPACE_BASE_PATH")) cfg.workspace_base_path = v;
        if (const char* v = std::getenv("APP_NETWORK")) cfg.app_network = v;
        if (const char* v = std::getenv("WORKER_ID")) cfg.worker_id = v;
        if (const char* v = std::getenv("POLL_BLOCK_MS")) cfg.poll_block_ms = std::stoi(v);

        return cfg;
    }
};

} // namespace deployforge
