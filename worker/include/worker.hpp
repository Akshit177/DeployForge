#pragma once

#include "config.hpp"
#include "redis_client.hpp"
#include "docker_client.hpp"
#include "process_runner.hpp"
#include <atomic>

namespace deployforge {

class WorkerDaemon {
public:
    explicit WorkerDaemon(Config cfg);
    ~WorkerDaemon() = default;

    bool init();
    void run();
    void stop();
    bool processSingleJob(const DeploymentJob& job);

private:
    Config m_cfg;
    RedisClient m_redis;
    DockerClient m_docker;
    std::atomic<bool> m_running{false};

    void ensureWorkspaceAppFiles(const std::string& workspacePath, const DeploymentJob& job);
    void prepareDockerfile(const std::string& workspacePath);
};

} // namespace deployforge
