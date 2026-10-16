#pragma once

#include <string>
#include <vector>
#include <optional>
#include <hiredis/hiredis.h>

namespace deployforge {

struct DeploymentJob {
    std::string message_id;
    std::string deployment_id;
    std::string project_id;
    std::string user_id;
    std::string repo_url;
    std::string branch = "main";
    std::string commit_hash = "HEAD";
    std::string commit_message = "";
    std::string runtime = "node";
    int port = 3000;
    std::string domain;
    std::string project_name = "app";
};

class RedisClient {
public:
    RedisClient(std::string host = "127.0.0.1", int port = 6379);
    ~RedisClient();

    bool connect();
    void disconnect();
    bool isConnected() const { return m_ctx != nullptr && m_ctx->err == 0; }

    bool ensureConsumerGroup(const std::string& stream, const std::string& group);
    std::optional<DeploymentJob> readNextJob(
        const std::string& stream,
        const std::string& group,
        const std::string& consumerName,
        int blockMs = 1500
    );

    bool setHotState(
        const std::string& deploymentId,
        const std::string& projectId,
        const std::string& status,
        const std::string& stage,
        int progressPct,
        const std::string& containerId = "",
        int port = 3000,
        const std::string& domain = "",
        const std::string& publicUrl = "",
        const std::string& errorMessage = ""
    );

    bool publishEvent(
        const std::string& eventsStream,
        const std::string& eventType,
        const std::string& deploymentId,
        const std::string& projectId,
        const std::string& userId,
        const std::string& status,
        const std::string& stage = "",
        const std::string& containerId = "",
        const std::string& errorMessage = "",
        int durationSeconds = 0,
        const std::string& containerName = "",
        const std::string& domain = "",
        int port = 0,
        const std::string& projectName = "",
        const std::string& commitHash = "",
        const std::string& commitMessage = ""
    );

    bool acknowledgeJob(
        const std::string& stream,
        const std::string& group,
        const std::string& messageId
    );

    redisContext* getContext() const { return m_ctx; }

private:
    std::string m_host;
    int m_port;
    redisContext* m_ctx = nullptr;

    void reconnectIfBroken();
    std::string currentTimestampIso();
};

} // namespace deployforge
