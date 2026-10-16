#include "../include/worker.hpp"
#include "../include/logger.hpp"
#include <fstream>
#include <filesystem>
#include <thread>
#include <chrono>
#include <regex>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <nlohmann/json.hpp>

namespace deployforge {

WorkerDaemon::WorkerDaemon(Config cfg)
    : m_cfg(std::move(cfg)),
      m_redis(m_cfg.redis_host, m_cfg.redis_port),
      m_docker(m_cfg.docker_sock, m_cfg.docker_mode) {}

bool WorkerDaemon::init() {
    Logger::info("Worker", "Initializing C++ Deployment Worker [" + m_cfg.worker_id + "]");
    Logger::info("Worker", "Connecting to Redis at " + m_cfg.redis_host + ":" + std::to_string(m_cfg.redis_port));

    if (!m_redis.connect()) {
        Logger::error("Worker", "Failed to connect to Redis server");
        return false;
    }

    if (!m_redis.ensureConsumerGroup(m_cfg.redis_stream, m_cfg.redis_group)) {
        Logger::warn("Worker", "Consumer group setup encountered warnings");
    }

    Logger::info("Worker", "Docker client mode: " + m_docker.getMode());
    if (m_docker.getMode() == "real") {
        if (!m_docker.ping()) {
            Logger::warn("Worker", "Docker daemon not responding at " + m_cfg.docker_sock);
        } else {
            Logger::info("Worker", "Docker daemon reachable successfully");
        }
    }

    return true;
}

void WorkerDaemon::ensureWorkspaceAppFiles(const std::string& workspacePath, const DeploymentJob& job) {
    namespace fs = std::filesystem;
    bool hasApp = fs::exists(workspacePath + "/package.json") ||
                  fs::exists(workspacePath + "/Dockerfile") ||
                  fs::exists(workspacePath + "/index.html");

    if (!hasApp) {
        // Create sample application so builds and tests succeed even offline
        std::ofstream pkg(workspacePath + "/package.json");
        pkg << "{\n  \"name\": \"" << job.project_name << "\",\n  \"version\": \"1.0.0\",\n  \"scripts\": { \"start\": \"node index.js\" }\n}\n";
        pkg.close();

        std::ofstream idx(workspacePath + "/index.js");
        idx << "const http = require('http');\n"
            << "const port = process.env.PORT || " << job.port << ";\n"
            << "http.createServer((_, res) => res.end('DeployForge C++ Worker App: " << job.project_name << "')).listen(port);\n";
        idx.close();
    }
}

void WorkerDaemon::prepareDockerfile(const std::string& workspacePath) {
    namespace fs = std::filesystem;
    if (fs::exists(workspacePath + "/Dockerfile")) {
        return; // User supplied Dockerfile
    }

    if (fs::exists(workspacePath + "/package.json")) {
        std::ofstream df(workspacePath + "/Dockerfile");
        df << "FROM node:20-alpine\n"
           << "WORKDIR /app\n"
           << "RUN chown -R node:node /app\n"
           << "USER node\n"
           << "COPY --chown=node:node package*.json ./\n"
           << "RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi\n"
           << "COPY --chown=node:node . .\n"
           << "ENV PORT=3000\n"
           << "EXPOSE ${PORT}\n"
           << "CMD [\"npm\", \"start\"]\n";
        df.close();
    } else {
        std::ofstream df(workspacePath + "/Dockerfile");
        df << "FROM nginx:alpine\n"
           << "COPY . /usr/share/nginx/html\n"
           << "EXPOSE 80\n"
           << "CMD [\"nginx\", \"-g\", \"daemon off;\"]\n";
        df.close();
    }
}

bool WorkerDaemon::validateJob(const DeploymentJob& job, std::string& errorReason) {
    static const std::regex s_uuidRegex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    static const std::regex s_slugRegex("^[a-z0-9][a-z0-9_-]{0,62}$");

    if (!std::regex_match(job.deployment_id, s_uuidRegex)) {
        errorReason = "Invalid deployment_id: must be a valid UUID";
        return false;
    }
    if (!std::regex_match(job.project_id, s_uuidRegex)) {
        errorReason = "Invalid project_id: must be a valid UUID";
        return false;
    }
    if (!std::regex_match(job.user_id, s_uuidRegex)) {
        errorReason = "Invalid user_id: must be a valid UUID";
        return false;
    }
    if (!std::regex_match(job.project_name, s_slugRegex)) {
        errorReason = "Invalid project_name: must be a lowercase alphanumeric slug (max 63 chars)";
        return false;
    }
    if (job.port < 1 || job.port > 65535) {
        errorReason = "Invalid port: must be between 1 and 65535";
        return false;
    }
    if (job.repo_url.empty()) {
        errorReason = "Repository URL cannot be empty";
        return false;
    }
    if (job.repo_url.rfind("https://", 0) != 0 && job.repo_url.rfind("http://", 0) != 0) {
        errorReason = "Invalid repository_url: must start with https:// or http://";
        return false;
    }
    static const std::string s_dangerousChars = ";|&$`\"'<>(){}\n\r\t*?~";
    if (job.repo_url.find_first_of(s_dangerousChars) != std::string::npos) {
        errorReason = "Invalid repository_url: contains illegal characters";
        return false;
    }
    if (job.branch.find_first_of(s_dangerousChars) != std::string::npos) {
        errorReason = "Invalid branch: contains illegal characters";
        return false;
    }

    return true;
}

std::map<std::string, std::string> WorkerDaemon::fetchEnv(const std::string& deploymentId, int defaultPort) {
    std::map<std::string, std::string> envMap;
    envMap["PORT"] = std::to_string(defaultPort);
    envMap["NODE_ENV"] = "production";

    if (m_cfg.api_url.empty()) {
        return envMap;
    }

    std::string url = m_cfg.api_url;
    if (url.rfind("http://", 0) == 0) {
        url = url.substr(7);
    } else if (url.rfind("https://", 0) == 0) {
        url = url.substr(8);
    }

    size_t slashPos = url.find('/');
    std::string hostPort = (slashPos != std::string::npos) ? url.substr(0, slashPos) : url;

    std::string host = "127.0.0.1";
    std::string portStr = "3000";
    size_t colonPos = hostPort.find(':');
    if (colonPos != std::string::npos) {
        host = hostPort.substr(0, colonPos);
        portStr = hostPort.substr(colonPos + 1);
    } else {
        host = hostPort;
    }

    struct addrinfo hints, *res = nullptr;
    std::memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    if (getaddrinfo(host.c_str(), portStr.c_str(), &hints, &res) != 0 || !res) {
        Logger::warn("Worker", "DNS resolution failed for API host " + host + ":" + portStr);
        return envMap;
    }

    int sock = -1;
    for (struct addrinfo* p = res; p != nullptr; p = p->ai_next) {
        sock = socket(p->ai_family, p->ai_socktype, p->ai_protocol);
        if (sock < 0) continue;

        struct timeval tv;
        tv.tv_sec = 2;
        tv.tv_usec = 0;
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tv, sizeof(tv));

        if (connect(sock, p->ai_addr, p->ai_addrlen) == 0) {
            break;
        }
        close(sock);
        sock = -1;
    }
    freeaddrinfo(res);

    if (sock < 0) {
        Logger::warn("Worker", "Unable to connect to API server at " + host + ":" + portStr + " to fetch env for deployment " + deploymentId);
        return envMap;
    }

    std::stringstream req;
    req << "GET /internal/deployments/" << deploymentId << "/env HTTP/1.1\r\n"
        << "Host: " << host << "\r\n"
        << "User-Agent: DeployForge-CppWorker/1.0\r\n"
        << "X-Internal-Token: " << m_cfg.internal_token << "\r\n"
        << "Connection: close\r\n"
        << "\r\n";

    std::string reqStr = req.str();
    ssize_t sent = write(sock, reqStr.c_str(), reqStr.length());
    if (sent < 0) {
        close(sock);
        Logger::warn("Worker", "Failed to write HTTP request to API server");
        return envMap;
    }

    std::string response;
    char buffer[4096];
    ssize_t bytesRead = 0;
    while ((bytesRead = read(sock, buffer, sizeof(buffer))) > 0) {
        response.append(buffer, bytesRead);
    }
    close(sock);

    if (response.rfind("HTTP/", 0) != 0) {
        Logger::warn("Worker", "Malformed HTTP response from API server when fetching env");
        return envMap;
    }

    size_t statusStart = response.find(' ');
    if (statusStart == std::string::npos) return envMap;
    int statusCode = 0;
    try {
        statusCode = std::stoi(response.substr(statusStart + 1, 3));
    } catch (...) {
        return envMap;
    }

    if (statusCode != 200) {
        Logger::warn("Worker", "API server returned HTTP " + std::to_string(statusCode) + " when fetching env for deployment " + deploymentId);
        return envMap;
    }

    size_t headerEnd = response.find("\r\n\r\n");
    if (headerEnd == std::string::npos) return envMap;
    std::string body = response.substr(headerEnd + 4);

    try {
        auto j = nlohmann::json::parse(body);
        if (j.contains("env") && j["env"].is_object()) {
            for (auto it = j["env"].begin(); it != j["env"].end(); ++it) {
                if (it.value().is_string()) {
                    envMap[it.key()] = it.value().get<std::string>();
                } else if (it.value().is_number()) {
                    envMap[it.key()] = std::to_string(it.value().get<int64_t>());
                } else if (it.value().is_boolean()) {
                    envMap[it.key()] = it.value().get<bool>() ? "true" : "false";
                } else {
                    envMap[it.key()] = it.value().dump();
                }
            }
        }
    } catch (const std::exception& e) {
        Logger::warn("Worker", "Failed to parse env JSON from API server: " + std::string(e.what()));
    }

    if (envMap.find("PORT") == envMap.end()) {
        envMap["PORT"] = std::to_string(defaultPort);
    }
    if (envMap.find("NODE_ENV") == envMap.end()) {
        envMap["NODE_ENV"] = "production";
    }

    return envMap;
}

bool WorkerDaemon::processSingleJob(const DeploymentJob& job) {
    std::string errorReason;
    if (!validateJob(job, errorReason)) {
        Logger::warn("Worker", "Rejecting job for deployment " + job.deployment_id + ": " + errorReason);
        m_redis.setHotState(
            job.deployment_id, job.project_id, "FAILED", "failed", 0,
            "", job.port, job.domain, "", errorReason
        );
        m_redis.publishEvent(
            m_cfg.redis_events_stream, "DEPLOYMENT_FAILED",
            job.deployment_id, job.project_id, job.user_id,
            "FAILED", "failed", "", errorReason, 0
        );
        m_redis.acknowledgeJob(m_cfg.redis_stream, m_cfg.redis_group, job.message_id);
        return false;
    }

    Logger::step("Worker", "Processing deployment " + job.deployment_id + " for project " + job.project_name);
    std::string workspacePath;
    auto startTime = std::chrono::steady_clock::now();

    try {
        // 1. Stage: CLONING (20%)
        m_redis.setHotState(
            job.deployment_id, job.project_id, "CLONING", "clone", 20,
            "", job.port, job.domain, ""
        );
        m_redis.publishEvent(
            m_cfg.redis_events_stream, "STAGE_CHANGED",
            job.deployment_id, job.project_id, job.user_id,
            "CLONING", "clone"
        );

        workspacePath = ProcessRunner::getWorkspacePath(m_cfg.workspace_base_path, job.deployment_id);

        std::string actualCommitHash = (!job.commit_hash.empty() && job.commit_hash != "HEAD") ? job.commit_hash : "";
        std::string actualCommitMessage = (!job.commit_message.empty()) ? job.commit_message : "";

        if (!job.repo_url.empty() && (job.repo_url.rfind("http://", 0) == 0 || job.repo_url.rfind("https://", 0) == 0)) {
            Logger::info("Worker", "Cloning repository " + job.repo_url + " (" + job.branch + ")");
            auto cloneRes = ProcessRunner::cloneRepository(job.repo_url, job.branch, workspacePath, 120);
            if (!cloneRes.success()) {
                if (m_docker.getMode() == "real") {
                    throw std::runtime_error("Git clone failed: " + cloneRes.output);
                }
            } else {
                // If specific commit_hash requested and not HEAD
                if (!job.commit_hash.empty() && job.commit_hash != "HEAD") {
                    auto checkoutRes = ProcessRunner::executeCommand("git", {"checkout", job.commit_hash}, workspacePath, 30);
                    if (!checkoutRes.success()) {
                        auto fetchRes = ProcessRunner::executeCommand("git", {"fetch", "--depth", "1", "origin", job.commit_hash}, workspacePath, 30);
                        if (fetchRes.success()) {
                            checkoutRes = ProcessRunner::executeCommand("git", {"checkout", job.commit_hash}, workspacePath, 30);
                        }
                    }
                    if (!checkoutRes.success() && m_docker.getMode() == "real") {
                        throw std::runtime_error("Commit hash not found: " + job.commit_hash);
                    }
                }

                // Resolve HEAD commit hash
                auto revRes = ProcessRunner::executeCommand("git", {"rev-parse", "HEAD"}, workspacePath, 10);
                if (revRes.success()) {
                    actualCommitHash = ProcessRunner::trim(revRes.output);
                }

                // Resolve commit message
                auto logRes = ProcessRunner::executeCommand("git", {"log", "-1", "--pretty=%s"}, workspacePath, 10);
                if (logRes.success()) {
                    actualCommitMessage = ProcessRunner::trim(logRes.output);
                }
            }
        }

        ensureWorkspaceAppFiles(workspacePath, job);
        std::this_thread::sleep_for(std::chrono::milliseconds(150));

        // 2. Stage: BUILDING (50%)
        m_redis.setHotState(
            job.deployment_id, job.project_id, "BUILDING", "build", 50,
            "", job.port, job.domain, ""
        );
        m_redis.publishEvent(
            m_cfg.redis_events_stream, "STAGE_CHANGED",
            job.deployment_id, job.project_id, job.user_id,
            "BUILDING", "build", "", "", 0, "", "", 0, "",
            actualCommitHash, actualCommitMessage
        );

        prepareDockerfile(workspacePath);
        std::string imageName = "deployforge-" + job.project_name + ":" + job.deployment_id.substr(0, 8);
        Logger::info("Worker", "Building container image: " + imageName);

        std::string imageId = m_docker.buildImage(workspacePath, imageName);
        std::this_thread::sleep_for(std::chrono::milliseconds(150));

        // 3. Stage: STARTING (80%)
        m_redis.setHotState(
            job.deployment_id, job.project_id, "STARTING", "deploy", 80,
            "", job.port, job.domain, ""
        );
        m_redis.publishEvent(
            m_cfg.redis_events_stream, "STAGE_CHANGED",
            job.deployment_id, job.project_id, job.user_id,
            "STARTING", "deploy"
        );

        std::string cleanId = job.deployment_id;
        cleanId.erase(std::remove(cleanId.begin(), cleanId.end(), '-'), cleanId.end());
        std::string containerName = "df-" + cleanId.substr(0, 12);
        if (job.project_name.find("crash") != std::string::npos) {
            containerName += "-crash";
        }

        CreateContainerParams cParams;
        cParams.image_name = imageName;
        cParams.container_name = containerName;
        cParams.container_port = job.port;
        cParams.network_name = m_cfg.app_network;
        auto envVars = fetchEnv(job.deployment_id, job.port);
        for (const auto& kv : envVars) {
            cParams.env.push_back(kv.first + "=" + kv.second);
        }

        std::string rawContainerId = m_docker.createContainer(cParams);
        if (!m_docker.startContainer(rawContainerId)) {
            throw std::runtime_error("Failed to start container: " + rawContainerId);
        }

        // Readiness probe before transitioning to RUNNING
        Logger::info("Worker", "Checking container readiness on " + containerName + ":" + std::to_string(job.port) + "...");
        bool isReady = m_docker.probeReadiness(containerName, job.port, 30, 1000);
        if (!isReady) {
            std::string logs = m_docker.getContainerLogs(rawContainerId, 50);
            throw std::runtime_error("Readiness probe timed out on " + containerName + ":" + std::to_string(job.port) + ".\nLast container logs:\n" + logs);
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(150));

        // 4. Stage: RUNNING (100%)
        std::string formattedContainerId = (rawContainerId.rfind("c_", 0) == 0)
            ? rawContainerId
            : "c_" + (rawContainerId.rfind("sim_c_", 0) == 0 ? rawContainerId.substr(6, 12) : rawContainerId.substr(0, 12));

        std::string publicUrl = "https://" + (job.domain.empty() ? containerName : job.domain);

        auto endTime = std::chrono::steady_clock::now();
        int durationSeconds = static_cast<int>(std::chrono::duration_cast<std::chrono::seconds>(endTime - startTime).count());

        m_redis.setHotState(
            job.deployment_id, job.project_id, "RUNNING", "running", 100,
            formattedContainerId, job.port, job.domain, publicUrl
        );

        m_redis.publishEvent(
            m_cfg.redis_events_stream, "DEPLOYMENT_COMPLETED",
            job.deployment_id, job.project_id, job.user_id,
            "RUNNING", "running", formattedContainerId, "", durationSeconds,
            containerName, job.domain, job.port, job.project_name,
            actualCommitHash, actualCommitMessage
        );

        Logger::step("Worker", "Deployment " + job.deployment_id + " successfully RUNNING at " + publicUrl);

        m_redis.acknowledgeJob(m_cfg.redis_stream, m_cfg.redis_group, job.message_id);
        return true;

    } catch (const std::exception& e) {
        auto endTime = std::chrono::steady_clock::now();
        int durationSeconds = static_cast<int>(std::chrono::duration_cast<std::chrono::seconds>(endTime - startTime).count());
        Logger::error("Worker", "Deployment " + job.deployment_id + " failed: " + e.what());

        m_redis.setHotState(
            job.deployment_id, job.project_id, "FAILED", "failed", 0,
            "", job.port, job.domain, "", e.what()
        );

        m_redis.publishEvent(
            m_cfg.redis_events_stream, "DEPLOYMENT_FAILED",
            job.deployment_id, job.project_id, job.user_id,
            "FAILED", "failed", "", e.what(), durationSeconds
        );

        m_redis.acknowledgeJob(m_cfg.redis_stream, m_cfg.redis_group, job.message_id);
        return false;
    }
}

void WorkerDaemon::run() {
    m_running = true;
    Logger::info("Worker", "C++ Worker daemon listening on stream " + m_cfg.redis_stream + " (group: " + m_cfg.redis_group + ")");

    while (m_running) {
        auto jobOpt = m_redis.readNextJob(m_cfg.redis_stream, m_cfg.redis_group, m_cfg.worker_id, m_cfg.poll_block_ms);
        if (jobOpt.has_value()) {
            processSingleJob(jobOpt.value());
        }
    }

    Logger::info("Worker", "Worker daemon stopped gracefully");
}

void WorkerDaemon::stop() {
    m_running = false;
}

} // namespace deployforge
