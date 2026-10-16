#include "../include/redis_client.hpp"
#include "../include/logger.hpp"
#include <chrono>
#include <iomanip>
#include <sstream>
#include <nlohmann/json.hpp>

namespace deployforge {

RedisClient::RedisClient(std::string host, int port)
    : m_host(std::move(host)), m_port(port) {}

RedisClient::~RedisClient() {
    disconnect();
}

bool RedisClient::connect() {
    if (m_ctx) {
        redisFree(m_ctx);
        m_ctx = nullptr;
    }

    struct timeval timeout = { 2, 0 }; // 2.0 seconds timeout
    m_ctx = redisConnectWithTimeout(m_host.c_str(), m_port, timeout);

    if (m_ctx == nullptr || m_ctx->err) {
        if (m_ctx) {
            Logger::error("RedisClient", "Connection error: " + std::string(m_ctx->errstr));
            redisFree(m_ctx);
            m_ctx = nullptr;
        } else {
            Logger::error("RedisClient", "Cannot allocate redis context");
        }
        return false;
    }
    return true;
}

void RedisClient::disconnect() {
    if (m_ctx) {
        redisFree(m_ctx);
        m_ctx = nullptr;
    }
}

void RedisClient::reconnectIfBroken() {
    if (!isConnected()) {
        connect();
    }
}

std::string RedisClient::currentTimestampIso() {
    auto now = std::chrono::system_clock::now();
    auto in_time_t = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << std::put_time(std::gmtime(&in_time_t), "%Y-%m-%dT%H:%M:%SZ");
    return ss.str();
}

bool RedisClient::ensureConsumerGroup(const std::string& stream, const std::string& group) {
    reconnectIfBroken();
    if (!isConnected()) return false;

    // XGROUP CREATE stream group $ MKSTREAM
    auto* reply = static_cast<redisReply*>(
        redisCommand(m_ctx, "XGROUP CREATE %s %s $ MKSTREAM", stream.c_str(), group.c_str())
    );

    if (!reply) {
        disconnect();
        return false;
    }

    bool ok = true;
    if (reply->type == REDIS_REPLY_ERROR) {
        std::string errStr = reply->str ? reply->str : "";
        if (errStr.find("BUSYGROUP") == std::string::npos) {
            Logger::warn("RedisClient", "XGROUP CREATE warning: " + errStr);
            ok = false;
        }
    }

    freeReplyObject(reply);
    return ok;
}

std::optional<DeploymentJob> RedisClient::readNextJob(
    const std::string& stream,
    const std::string& group,
    const std::string& consumerName,
    int blockMs
) {
    reconnectIfBroken();
    if (!isConnected()) return std::nullopt;

    auto* reply = static_cast<redisReply*>(
        redisCommand(
            m_ctx,
            "XREADGROUP GROUP %s %s COUNT 1 BLOCK %d STREAMS %s >",
            group.c_str(),
            consumerName.c_str(),
            blockMs,
            stream.c_str()
        )
    );

    if (!reply) {
        disconnect();
        return std::nullopt;
    }

    std::optional<DeploymentJob> result = std::nullopt;

    // Expected response format for XREADGROUP:
    // Array of streams -> [ [stream_name, [ [msg_id, [field1, val1, field2, val2, ...]] ] ] ]
    if (reply->type == REDIS_REPLY_ARRAY && reply->elements > 0) {
        auto* streamEntry = reply->element[0];
        if (streamEntry->type == REDIS_REPLY_ARRAY && streamEntry->elements >= 2) {
            auto* messagesList = streamEntry->element[1];
            if (messagesList->type == REDIS_REPLY_ARRAY && messagesList->elements > 0) {
                auto* msg = messagesList->element[0];
                if (msg->type == REDIS_REPLY_ARRAY && msg->elements >= 2) {
                    DeploymentJob job;
                    job.message_id = msg->element[0]->str ? msg->element[0]->str : "";

                    auto* fields = msg->element[1];
                    if (fields->type == REDIS_REPLY_ARRAY) {
                        for (size_t i = 0; i + 1 < fields->elements; i += 2) {
                            std::string key = fields->element[i]->str ? fields->element[i]->str : "";
                            std::string val = fields->element[i + 1]->str ? fields->element[i + 1]->str : "";

                            if (key == "deployment_id") job.deployment_id = val;
                            else if (key == "project_id") job.project_id = val;
                            else if (key == "user_id") job.user_id = val;
                            else if (key == "repo_url") job.repo_url = val;
                            else if (key == "branch") job.branch = val;
                            else if (key == "commit_hash") job.commit_hash = val;
                            else if (key == "commit_message") job.commit_message = val;
                            else if (key == "runtime") job.runtime = val;
                            else if (key == "port") {
                                try { job.port = std::stoi(val); } catch (...) { job.port = 3000; }
                            }
                            else if (key == "domain") job.domain = val;
                            else if (key == "project_name") job.project_name = val;
                        }
                        result = job;
                    }
                }
            }
        }
    }

    freeReplyObject(reply);
    return result;
}

bool RedisClient::setHotState(
    const std::string& deploymentId,
    const std::string& projectId,
    const std::string& status,
    const std::string& stage,
    int progressPct,
    const std::string& containerId,
    int port,
    const std::string& domain,
    const std::string& publicUrl,
    const std::string& errorMessage
) {
    reconnectIfBroken();
    if (!isConnected()) return false;

    std::string key = "deployment:" + deploymentId + ":state";
    std::string nowIso = currentTimestampIso();

    std::vector<const char*> argv = {
        "HSET", key.c_str(),
        "deployment_id", deploymentId.c_str(),
        "project_id", projectId.c_str(),
        "status", status.c_str(),
        "stage", stage.c_str()
    };

    std::string pctStr = std::to_string(progressPct);
    argv.push_back("progress_pct");
    argv.push_back(pctStr.c_str());

    std::string portStr = std::to_string(port);
    argv.push_back("port");
    argv.push_back(portStr.c_str());

    if (!containerId.empty()) {
        argv.push_back("container_id");
        argv.push_back(containerId.c_str());
    }
    if (!domain.empty()) {
        argv.push_back("domain");
        argv.push_back(domain.c_str());
    }
    if (!publicUrl.empty()) {
        argv.push_back("public_url");
        argv.push_back(publicUrl.c_str());
    }
    if (!errorMessage.empty()) {
        argv.push_back("error_message");
        argv.push_back(errorMessage.c_str());
    }

    argv.push_back("updated_at");
    argv.push_back(nowIso.c_str());

    auto* reply = static_cast<redisReply*>(
        redisCommandArgv(m_ctx, static_cast<int>(argv.size()), argv.data(), nullptr)
    );

    if (!reply) {
        disconnect();
        return false;
    }
    freeReplyObject(reply);

    // Set 24h TTL (86400s)
    auto* expReply = static_cast<redisReply*>(
        redisCommand(m_ctx, "EXPIRE %s 86400", key.c_str())
    );
    if (expReply) {
        freeReplyObject(expReply);
    }

    return true;
}

bool RedisClient::publishEvent(
    const std::string& eventsStream,
    const std::string& eventType,
    const std::string& deploymentId,
    const std::string& projectId,
    const std::string& userId,
    const std::string& status,
    const std::string& stage,
    const std::string& containerId,
    const std::string& errorMessage,
    int durationSeconds,
    const std::string& containerName,
    const std::string& domain,
    int port,
    const std::string& projectName,
    const std::string& commitHash,
    const std::string& commitMessage
) {
    reconnectIfBroken();
    if (!isConnected()) return false;

    std::string nowIso = currentTimestampIso();

    nlohmann::json payload;
    payload["deployment_id"] = deploymentId;
    payload["project_id"] = projectId;
    payload["user_id"] = userId;
    payload["status"] = status;
    payload["stage"] = stage;
    if (!containerId.empty()) {
        payload["container_id"] = containerId;
    }
    if (!containerName.empty()) {
        payload["container_name"] = containerName;
    }
    if (!domain.empty()) {
        payload["domain"] = domain;
    }
    if (port > 0) {
        payload["port"] = port;
    }
    if (!projectName.empty()) {
        payload["project_name"] = projectName;
    }
    if (!errorMessage.empty()) {
        payload["error_message"] = errorMessage;
    }
    if (!commitHash.empty()) {
        payload["commit_hash"] = commitHash;
    }
    if (!commitMessage.empty()) {
        payload["commit_message"] = commitMessage;
    }
    payload["duration_seconds"] = durationSeconds;
    payload["timestamp"] = nowIso;

    std::string payloadStr = payload.dump();

    std::vector<const char*> argv = {
        "XADD", eventsStream.c_str(), "*",
        "event_type", eventType.c_str(),
        "aggregate_id", deploymentId.c_str(),
        "payload", payloadStr.c_str(),
        "created_at", nowIso.c_str()
    };

    auto* reply = static_cast<redisReply*>(
        redisCommandArgv(m_ctx, static_cast<int>(argv.size()), argv.data(), nullptr)
    );

    if (!reply) {
        disconnect();
        return false;
    }
    freeReplyObject(reply);
    return true;
}

bool RedisClient::acknowledgeJob(
    const std::string& stream,
    const std::string& group,
    const std::string& messageId
) {
    reconnectIfBroken();
    if (!isConnected()) return false;

    auto* reply = static_cast<redisReply*>(
        redisCommand(m_ctx, "XACK %s %s %s", stream.c_str(), group.c_str(), messageId.c_str())
    );

    if (!reply) {
        disconnect();
        return false;
    }
    freeReplyObject(reply);
    return true;
}

} // namespace deployforge
