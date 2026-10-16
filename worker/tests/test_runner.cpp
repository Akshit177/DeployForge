#include "../include/config.hpp"
#include "../include/logger.hpp"
#include "../include/process_runner.hpp"
#include "../include/docker_client.hpp"
#include "../include/redis_client.hpp"
#include "../include/worker.hpp"
#include <iostream>
#include <cassert>
#include <filesystem>
#include <thread>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <nlohmann/json.hpp>

using namespace deployforge;

int g_passed = 0;
int g_total = 0;

#define TEST_ASSERT(cond, msg) \
    do { \
        g_total++; \
        if (!(cond)) { \
            std::cerr << "  ❌ FAILED: " << msg << " (" << __FILE__ << ":" << __LINE__ << ")" << std::endl; \
            exit(1); \
        } else { \
            g_passed++; \
            std::cout << "  ✓ " << msg << std::endl; \
        } \
    } while (0)

void testConfig() {
    std::cout << "\n[Suite 1] Config Loading" << std::endl;
    Config cfg;
    TEST_ASSERT(cfg.redis_host == "127.0.0.1", "Default Redis host is 127.0.0.1");
    TEST_ASSERT(cfg.redis_port == 6379, "Default Redis port is 6379");
    TEST_ASSERT(cfg.redis_stream == "stream:deployments", "Default stream is stream:deployments");
    TEST_ASSERT(cfg.redis_group == "deployforge_workers", "Default group is deployforge_workers");
    TEST_ASSERT(cfg.api_url == "http://127.0.0.1:3000", "Default API URL is http://127.0.0.1:3000");
    TEST_ASSERT(cfg.internal_token == "deployforge-internal-dev-token", "Default internal token is set");
}

void testProcessRunner() {
    std::cout << "\n[Suite 2] Process Runner & Path Traversal Defense" << std::endl;
    TEST_ASSERT(ProcessRunner::isValidDeploymentId("123e4567-e89b-12d3-a456-426614174000"), "UUID deploymentId is valid");
    TEST_ASSERT(ProcessRunner::isValidDeploymentId("dep_123_abc"), "Alphanumeric deploymentId is valid");

    TEST_ASSERT(!ProcessRunner::isValidDeploymentId("../etc/passwd"), "Path traversal rejected");
    TEST_ASSERT(!ProcessRunner::isValidDeploymentId("dep/123"), "Slash rejected");
    TEST_ASSERT(!ProcessRunner::isValidDeploymentId(""), "Empty ID rejected");

    std::string testDepId = "test-cpp-ws-001";
    std::string ws = ProcessRunner::getWorkspacePath("/tmp/df_test_ws", testDepId);
    TEST_ASSERT(std::filesystem::exists(ws), "Workspace directory created");
    TEST_ASSERT(ws.find(testDepId) != std::string::npos, "Workspace path contains deployment ID");

    auto cmdRes = ProcessRunner::executeCommand("echo", {"hello", "deployforge"});
    TEST_ASSERT(cmdRes.success(), "Subprocess executed successfully");
    TEST_ASSERT(cmdRes.output.find("hello deployforge") != std::string::npos, "Subprocess captured stdout");

    bool cleaned = ProcessRunner::cleanupWorkspace(ws);
    TEST_ASSERT(cleaned, "Workspace directory cleaned up");
    TEST_ASSERT(!std::filesystem::exists(ws), "Workspace path deleted");

    // F-13: Test that cloneRepository rejects invalid branch without fallback to main/default
    std::string testRepo = "/tmp/df_test_git_repo";
    std::filesystem::remove_all(testRepo);
    std::filesystem::create_directories(testRepo);
    ProcessRunner::executeCommand("git", {"init"}, testRepo);
    ProcessRunner::executeCommand("git", {"config", "user.name", "TestUser"}, testRepo);
    ProcessRunner::executeCommand("git", {"config", "user.email", "test@test.com"}, testRepo);
    ProcessRunner::executeCommand("sh", {"-c", "echo hello > file.txt"}, testRepo);
    ProcessRunner::executeCommand("git", {"add", "."}, testRepo);
    ProcessRunner::executeCommand("git", {"commit", "-m", "initial commit"}, testRepo);

    std::string cloneDst = "/tmp/df_test_clone_dst";
    std::filesystem::remove_all(cloneDst);
    auto badBranchRes = ProcessRunner::cloneRepository(testRepo, "nonexistent-branch-xyz", cloneDst);
    TEST_ASSERT(!badBranchRes.success(), "cloneRepository rejects nonexistent branch and does not fallback to default");
    TEST_ASSERT(!std::filesystem::exists(cloneDst) || std::filesystem::is_empty(cloneDst), "clone destination not populated after failed branch clone");

    std::filesystem::remove_all(cloneDst);
    auto goodBranchRes = ProcessRunner::cloneRepository(testRepo, "master", cloneDst);
    if (!goodBranchRes.success()) {
        goodBranchRes = ProcessRunner::cloneRepository(testRepo, "main", cloneDst);
    }
    TEST_ASSERT(goodBranchRes.success(), "cloneRepository succeeds for valid branch");

    std::filesystem::remove_all(testRepo);
    std::filesystem::remove_all(cloneDst);
}

void testDockerClientSimulator() {
    std::cout << "\n[Suite 3] Docker Client Simulator" << std::endl;
    DockerClient docker("/var/run/docker.sock", "simulator");
    TEST_ASSERT(docker.ping(), "Docker ping returns true in simulator");

    // Test image name validation
    TEST_ASSERT(DockerClient::isValidImageName("df-test-img:latest"), "Valid image name accepted");
    TEST_ASSERT(DockerClient::isValidImageName("my-app:1.0"), "Image with numbers and dots accepted");
    TEST_ASSERT(!DockerClient::isValidImageName("bad;name"), "Image name with semicolon rejected");
    TEST_ASSERT(!DockerClient::isValidImageName("Uppercase:1.0"), "Image name with uppercase rejected");
    TEST_ASSERT(!DockerClient::isValidImageName(""), "Empty image name rejected");

    bool buildThrew = false;
    try {
        docker.buildImage("/tmp", "bad;name:latest");
    } catch (const std::invalid_argument&) {
        buildThrew = true;
    }
    TEST_ASSERT(buildThrew, "buildImage throws invalid_argument on invalid image name");

    // Test HTTP response parsing
    auto [code200, b200] = DockerClient::parseHttpResponse("HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\n{\"status\":\"ok\"}");
    TEST_ASSERT(code200 == 200 && b200 == "{\"status\":\"ok\"}", "parseHttpResponse parses 200 OK");

    auto [code204, b204] = DockerClient::parseHttpResponse("HTTP/1.1 204 No Content\r\n\r\n");
    TEST_ASSERT(code204 == 204 && b204.empty(), "parseHttpResponse parses 204 No Content");

    auto [codeChunked, bChunked] = DockerClient::parseHttpResponse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n");
    TEST_ASSERT(codeChunked == 200 && bChunked == "Wikipedia", "parseHttpResponse decodes chunked transfer encoding");

    auto [code400, b400] = DockerClient::parseHttpResponse("HTTP/1.1 400 Bad Request\r\nContent-Length: 26\r\n\r\n{\"message\":\"bad parameter\"}");
    TEST_ASSERT(code400 == 400 && b400.find("bad parameter") != std::string::npos, "parseHttpResponse parses 400 Bad Request");

    auto [code500, b500] = DockerClient::parseHttpResponse("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 28\r\n\r\n{\"message\":\"container crash\"}");
    TEST_ASSERT(code500 == 500 && b500.find("container crash") != std::string::npos, "parseHttpResponse parses 500 Internal Server Error");

    std::string img = docker.buildImage("/tmp", "df-test-img:latest");
    TEST_ASSERT(!img.empty(), "Image built in simulator");

    CreateContainerParams params;
    params.image_name = img;
    params.container_name = "df-test-container";
    params.container_port = 3000;
    params.limits.memory_mb = 512;
    params.limits.cpu_shares = 256;
    params.limits.pids_limit = 100;

    std::string cid = docker.createContainer(params);
    TEST_ASSERT(cid.rfind("sim_c_", 0) == 0, "Container ID formatted properly in simulator");

    TEST_ASSERT(docker.startContainer(cid), "Container started");
    TEST_ASSERT(!docker.startContainer("fail_sim_container"), "startContainer returns false on failure");

    // F-14: Test readiness probe and container logs
    TEST_ASSERT(docker.probeReadiness("df-normal-app", 3000), "probeReadiness returns true for healthy container");
    TEST_ASSERT(!docker.probeReadiness("df-crash-app", 3000), "probeReadiness returns false for crash container");
    TEST_ASSERT(!docker.getContainerLogs("c_normal_123", 50).empty(), "getContainerLogs returns output");
    TEST_ASSERT(docker.getContainerLogs("c_crash_123", 50).find("Cannot find module") != std::string::npos, "getContainerLogs returns error logs for crash container");

    auto info = docker.inspectContainer(cid);
    TEST_ASSERT(info.running, "Container inspect reports running");
    TEST_ASSERT(info.ip_address == "172.20.0.42", "Container IP assigned");

    TEST_ASSERT(docker.stopContainer(cid), "Container stopped");
    TEST_ASSERT(docker.removeContainer(cid), "Container removed");
}

void testRedisClient() {
    std::cout << "\n[Suite 4] Redis Streams & Hot State Operations" << std::endl;
    RedisClient redis("127.0.0.1", 6379);

    if (!redis.connect()) {
        std::cout << "  ⚠️ Redis server not reachable on 127.0.0.1:6379, skipping live Redis test" << std::endl;
        return;
    }
    TEST_ASSERT(redis.isConnected(), "Connected to Redis server");

    bool groupOk = redis.ensureConsumerGroup("stream:test_cpp_deployments", "cpp_workers");
    TEST_ASSERT(groupOk, "Consumer group ensured on Redis stream");

    std::string testDepId = "dep-cpp-test-999";
    bool hotOk = redis.setHotState(
        testDepId, "proj-123", "RUNNING", "running", 100,
        "c_test_cid_123", 3000, "cpp-test.deployforge.app", "https://cpp-test.deployforge.app"
    );
    TEST_ASSERT(hotOk, "Deployment hot state written via HSET");

    bool evOk = redis.publishEvent(
        "stream:test_cpp_events", "DEPLOYMENT_COMPLETED",
        testDepId, "proj-123", "usr-123", "RUNNING", "running", "c_test_cid_123", "", 15,
        "df-test-cid", "cpp-test.deployforge.app", 3000, "cpp-sample"
    );
    TEST_ASSERT(evOk, "Deployment event published to stream via XADD");

    // Verify envelope and payload contract
    auto* reply = static_cast<redisReply*>(
        redisCommand(redis.getContext(), "XREVRANGE stream:test_cpp_events + - COUNT 1")
    );
    std::string eventType, aggregateId, payloadStr, createdAt;
    if (reply && reply->type == REDIS_REPLY_ARRAY && reply->elements > 0) {
        auto* msg = reply->element[0];
        if (msg->type == REDIS_REPLY_ARRAY && msg->elements >= 2) {
            auto* fields = msg->element[1];
            if (fields->type == REDIS_REPLY_ARRAY) {
                for (size_t i = 0; i + 1 < fields->elements; i += 2) {
                    std::string key = fields->element[i]->str ? fields->element[i]->str : "";
                    std::string val = fields->element[i + 1]->str ? fields->element[i + 1]->str : "";
                    if (key == "event_type") eventType = val;
                    else if (key == "aggregate_id") aggregateId = val;
                    else if (key == "payload") payloadStr = val;
                    else if (key == "created_at") createdAt = val;
                }
            }
        }
        freeReplyObject(reply);
    }

    TEST_ASSERT(eventType == "DEPLOYMENT_COMPLETED", "Event envelope has event_type DEPLOYMENT_COMPLETED");
    TEST_ASSERT(aggregateId == testDepId, "Event envelope has aggregate_id matching deployment ID");
    TEST_ASSERT(!createdAt.empty(), "Event envelope has created_at timestamp");
    TEST_ASSERT(!payloadStr.empty(), "Event envelope contains payload JSON string");

    nlohmann::json parsedPayload = nlohmann::json::parse(payloadStr);
    TEST_ASSERT(parsedPayload["deployment_id"] == testDepId, "Payload JSON contains matching deployment_id");
    TEST_ASSERT(parsedPayload["project_id"] == "proj-123", "Payload JSON contains matching project_id");
    TEST_ASSERT(parsedPayload["user_id"] == "usr-123", "Payload JSON contains matching user_id");
    TEST_ASSERT(parsedPayload["status"] == "RUNNING", "Payload JSON contains status RUNNING");
    TEST_ASSERT(parsedPayload["container_id"] == "c_test_cid_123", "Payload JSON contains container_id");
    TEST_ASSERT(parsedPayload["duration_seconds"] == 15, "Payload JSON contains duration_seconds");
    TEST_ASSERT(parsedPayload["container_name"] == "df-test-cid", "Payload JSON contains container_name");
    TEST_ASSERT(parsedPayload["domain"] == "cpp-test.deployforge.app", "Payload JSON contains domain");
    TEST_ASSERT(parsedPayload["port"] == 3000, "Payload JSON contains port");
    TEST_ASSERT(parsedPayload["project_name"] == "cpp-sample", "Payload JSON contains project_name");

    // Test publishLog emits LOG_EMITTED event envelope
    bool logPub = redis.publishLog(
        "stream:test_cpp_events",
        testDepId,
        "proj-123",
        "usr-123",
        "INFO",
        "build",
        "Running npm install in workspace"
    );
    TEST_ASSERT(logPub, "publishLog succeeded");

    auto* logReply = static_cast<redisReply*>(
        redisCommand(redis.getContext(), "XREVRANGE stream:test_cpp_events + - COUNT 1")
    );
    std::string logEventType;
    std::string logAggregateId;
    std::string logPayloadStr;
    if (logReply && logReply->type == REDIS_REPLY_ARRAY && logReply->elements > 0) {
        auto* msg = logReply->element[0];
        if (msg->type == REDIS_REPLY_ARRAY && msg->elements >= 2) {
            auto* fields = msg->element[1];
            if (fields->type == REDIS_REPLY_ARRAY) {
                for (size_t i = 0; i + 1 < fields->elements; i += 2) {
                    std::string key = fields->element[i]->str ? fields->element[i]->str : "";
                    std::string val = fields->element[i + 1]->str ? fields->element[i + 1]->str : "";
                    if (key == "event_type") logEventType = val;
                    else if (key == "aggregate_id") logAggregateId = val;
                    else if (key == "payload") logPayloadStr = val;
                }
            }
        }
        freeReplyObject(logReply);
    }

    TEST_ASSERT(logEventType == "LOG_EMITTED", "Log event envelope has event_type LOG_EMITTED");
    TEST_ASSERT(logAggregateId == testDepId, "Log event envelope has aggregate_id matching deployment ID");
    TEST_ASSERT(!logPayloadStr.empty(), "Log event envelope contains payload JSON string");

    nlohmann::json parsedLogPayload = nlohmann::json::parse(logPayloadStr);
    TEST_ASSERT(parsedLogPayload["message"] == "Running npm install in workspace", "Log payload contains message");
    TEST_ASSERT(parsedLogPayload["level"] == "INFO", "Log payload contains level INFO");
    TEST_ASSERT(parsedLogPayload["source"] == "build", "Log payload contains source build");
}

void testWorkerLifecycle() {
    std::cout << "\n[Suite 5] End-to-End Worker Single Job Execution" << std::endl;
    Config cfg;
    cfg.docker_mode = "simulator";
    cfg.workspace_base_path = "/tmp/df_test_workspaces";
    cfg.redis_stream = "stream:test_cpp_deployments";
    cfg.redis_events_stream = "stream:test_cpp_events";
    cfg.redis_group = "cpp_workers";

    WorkerDaemon worker(cfg);
    if (!worker.init()) {
        std::cout << "  ⚠️ Worker init failed (Redis might be offline), skipping job test" << std::endl;
        return;
    }

    DeploymentJob job;
    job.message_id = "test-msg-001";
    job.deployment_id = "11111111-1111-1111-1111-111111111111";
    job.project_id = "22222222-2222-2222-2222-222222222222";
    job.user_id = "33333333-3333-3333-3333-333333333333";
    job.repo_url = "https://github.com/deployforge/sample-node";
    job.branch = "main";
    job.commit_hash = "abcdef123456";
    job.runtime = "node";
    job.port = 3000;
    job.domain = "cpp-test.deployforge.app";
    job.project_name = "cpp-sample-app";

    bool success = worker.processSingleJob(job);
    TEST_ASSERT(success, "Worker processed job through CLONING -> BUILDING -> STARTING -> RUNNING");

    // Verify emitted event in events stream has container_name
    auto* reply = static_cast<redisReply*>(
        redisCommand(worker.getRedisClient().getContext(), "XREVRANGE stream:test_cpp_events + - COUNT 10")
    );
    std::string payloadStr;
    if (reply && reply->type == REDIS_REPLY_ARRAY && reply->elements > 0) {
        for (size_t m = 0; m < reply->elements; ++m) {
            auto* msg = reply->element[m];
            if (msg->type == REDIS_REPLY_ARRAY && msg->elements >= 2) {
                auto* fields = msg->element[1];
                if (fields->type == REDIS_REPLY_ARRAY) {
                    std::string evType;
                    std::string pStr;
                    for (size_t i = 0; i + 1 < fields->elements; i += 2) {
                        std::string key = fields->element[i]->str ? fields->element[i]->str : "";
                        std::string val = fields->element[i + 1]->str ? fields->element[i + 1]->str : "";
                        if (key == "event_type") evType = val;
                        if (key == "payload") pStr = val;
                    }
                    if (evType == "DEPLOYMENT_COMPLETED") {
                        payloadStr = pStr;
                        break;
                    }
                }
            }
        }
        freeReplyObject(reply);
    }
    TEST_ASSERT(!payloadStr.empty(), "Worker emitted completion event payload");
    nlohmann::json parsed = nlohmann::json::parse(payloadStr);
    TEST_ASSERT(parsed["container_name"] == "df-111111111111", "Worker emitted container_name df-111111111111");
    TEST_ASSERT(parsed["domain"] == "cpp-test.deployforge.app", "Worker emitted domain in payload");
    TEST_ASSERT(parsed["commit_hash"] == "abcdef123456", "Worker emitted commit_hash in payload");
}

void testJobValidationAndStartFailure() {
    std::cout << "\n[Suite 6] S-07 Job Validation & Container Start Resilience" << std::endl;
    std::string errReason;

    DeploymentJob validJob;
    validJob.message_id = "msg-valid-001";
    validJob.deployment_id = "11111111-1111-1111-1111-111111111111";
    validJob.project_id = "22222222-2222-2222-2222-222222222222";
    validJob.user_id = "33333333-3333-3333-3333-333333333333";
    validJob.project_name = "valid-slug";
    validJob.port = 3000;
    validJob.repo_url = "https://github.com/deployforge/sample-node";
    validJob.branch = "main";
    TEST_ASSERT(WorkerDaemon::validateJob(validJob, errReason), "Valid job passes validation");

    // Hostile project name (S-07 injection attempt)
    DeploymentJob hostileProject = validJob;
    hostileProject.project_name = "app;rm -rf /";
    TEST_ASSERT(!WorkerDaemon::validateJob(hostileProject, errReason), "Hostile project_name with shell injection rejected");
    TEST_ASSERT(errReason.find("project_name") != std::string::npos, "Error specifies project_name");

    // Hostile repository URL
    DeploymentJob hostileRepo = validJob;
    hostileRepo.repo_url = "https://github.com/foo/bar;curl evil.com";
    TEST_ASSERT(!WorkerDaemon::validateJob(hostileRepo, errReason), "Hostile repository_url with shell injection rejected");
    TEST_ASSERT(errReason.find("repository_url") != std::string::npos, "Error specifies repository_url");

    // Hostile branch
    DeploymentJob hostileBranch = validJob;
    hostileBranch.branch = "main;whoami";
    TEST_ASSERT(!WorkerDaemon::validateJob(hostileBranch, errReason), "Hostile branch with shell injection rejected");

    // Path traversal in deployment ID
    DeploymentJob badDepId = validJob;
    badDepId.deployment_id = "../../etc/passwd";
    TEST_ASSERT(!WorkerDaemon::validateJob(badDepId, errReason), "Path traversal deployment_id rejected by UUID check");

    // Invalid port
    DeploymentJob badPort = validJob;
    badPort.port = 70000;
    TEST_ASSERT(!WorkerDaemon::validateJob(badPort, errReason), "Out-of-range port rejected");

    // Non-HTTP URL
    DeploymentJob badScheme = validJob;
    badScheme.repo_url = "file:///etc/passwd";
    TEST_ASSERT(!WorkerDaemon::validateJob(badScheme, errReason), "Non-HTTP repository_url rejected");

    // S-08: Internal host SSRF rejection
    DeploymentJob ssrfJob = validJob;
    ssrfJob.repo_url = "http://169.254.169.254/latest/meta-data/";
    TEST_ASSERT(!WorkerDaemon::validateJob(ssrfJob, errReason), "Internal metadata IP repository_url rejected");

    DeploymentJob redisSsrfJob = validJob;
    redisSsrfJob.repo_url = "http://redis:6379/x.git";
    TEST_ASSERT(!WorkerDaemon::validateJob(redisSsrfJob, errReason), "Internal redis hostname repository_url rejected");

    // S-08: Hostile branch names
    DeploymentJob leadingDashBranch = validJob;
    leadingDashBranch.branch = "--upload-pack=evil";
    TEST_ASSERT(!WorkerDaemon::validateJob(leadingDashBranch, errReason), "Leading dash branch name rejected");

    DeploymentJob traversalBranch = validJob;
    traversalBranch.branch = "../../etc/passwd";
    TEST_ASSERT(!WorkerDaemon::validateJob(traversalBranch, errReason), "Path traversal branch name rejected");

    // S-08: Hostile commit hash
    DeploymentJob hostileCommit = validJob;
    hostileCommit.commit_hash = "$(id)";
    TEST_ASSERT(!WorkerDaemon::validateJob(hostileCommit, errReason), "Hostile command injection commit_hash rejected");

    DeploymentJob validCommit = validJob;
    validCommit.commit_hash = "0123456789abcdef0123456789abcdef01234567";
    TEST_ASSERT(WorkerDaemon::validateJob(validCommit, errReason), "Valid 40-char commit_hash accepted");

    // Test processSingleJob rejects hostile job immediately without spawning
    Config cfg;
    cfg.docker_mode = "simulator";
    cfg.workspace_base_path = "/tmp/df_test_workspaces";
    cfg.redis_stream = "stream:test_cpp_deployments";
    cfg.redis_events_stream = "stream:test_cpp_events";
    cfg.redis_group = "cpp_workers";

    WorkerDaemon worker(cfg);
    if (!worker.init()) {
        std::cout << "  ⚠️ Worker init failed (Redis might be offline), skipping job test" << std::endl;
        return;
    }

    bool hostileResult = worker.processSingleJob(hostileProject);
    TEST_ASSERT(!hostileResult, "processSingleJob returns false on hostile job validation failure");

    // Test startContainer failure triggers DEPLOYMENT_FAILED
    DeploymentJob startFailJob = validJob;
    startFailJob.message_id = "msg-fail-002";
    startFailJob.deployment_id = "44444444-4444-4444-4444-444444444444";
    startFailJob.project_name = "fail-app"; // triggers containerName with "fail" in simulator
    bool failResult = worker.processSingleJob(startFailJob);
    TEST_ASSERT(!failResult, "processSingleJob fails cleanly when container start fails");

    // F-14: Test readiness probe timeout triggers DEPLOYMENT_FAILED with container logs
    DeploymentJob crashJob = validJob;
    crashJob.message_id = "msg-crash-003";
    crashJob.deployment_id = "55555555-5555-5555-5555-555555555555";
    crashJob.project_name = "crash-app";
    bool crashResult = worker.processSingleJob(crashJob);
    TEST_ASSERT(!crashResult, "processSingleJob fails cleanly when readiness probe fails");

    auto* crashReply = static_cast<redisReply*>(
        redisCommand(worker.getRedisClient().getContext(), "XREVRANGE stream:test_cpp_events + - COUNT 10")
    );
    std::string crashPayloadStr;
    if (crashReply && crashReply->type == REDIS_REPLY_ARRAY && crashReply->elements > 0) {
        for (size_t m = 0; m < crashReply->elements; ++m) {
            auto* msg = crashReply->element[m];
            if (msg->type == REDIS_REPLY_ARRAY && msg->elements >= 2) {
                auto* fields = msg->element[1];
                if (fields->type == REDIS_REPLY_ARRAY) {
                    std::string evType;
                    std::string pStr;
                    for (size_t i = 0; i + 1 < fields->elements; i += 2) {
                        std::string key = fields->element[i]->str ? fields->element[i]->str : "";
                        std::string val = fields->element[i + 1]->str ? fields->element[i + 1]->str : "";
                        if (key == "event_type") evType = val;
                        if (key == "payload") pStr = val;
                    }
                    if (evType == "DEPLOYMENT_FAILED") {
                        crashPayloadStr = pStr;
                        break;
                    }
                }
            }
        }
        freeReplyObject(crashReply);
    }
    TEST_ASSERT(!crashPayloadStr.empty(), "Worker emitted failure event payload on probe timeout");
    nlohmann::json crashParsed = nlohmann::json::parse(crashPayloadStr);
    TEST_ASSERT(crashParsed["status"] == "FAILED", "Emitted failure event has status FAILED");
    std::string errMsg = crashParsed["error_message"].get<std::string>();
    TEST_ASSERT(errMsg.find("Readiness probe timed out") != std::string::npos, "Error message specifies readiness probe timeout");
    TEST_ASSERT(errMsg.find("Cannot find module") != std::string::npos, "Error message contains container logs");
}

void testInternalEnvFetch() {
    std::cout << "\n[Suite 7] S-06 Worker fetchEnv & Vault Integration" << std::endl;

    // 1. Unreachable API host falls back cleanly to default PORT and NODE_ENV
    Config cfg;
    cfg.api_url = "http://127.0.0.1:49999";
    WorkerDaemon worker(cfg);
    auto fallbackEnv = worker.fetchEnv("00000000-0000-0000-0000-000000000000", 4000);
    TEST_ASSERT(fallbackEnv["PORT"] == "4000", "fetchEnv fallback sets default port 4000");
    TEST_ASSERT(fallbackEnv["NODE_ENV"] == "production", "fetchEnv fallback sets default NODE_ENV");

    // 2. Real TCP HTTP round-trip against mock internal endpoint
    int serverSock = socket(AF_INET, SOCK_STREAM, 0);
    TEST_ASSERT(serverSock >= 0, "Created test socket for mock API server");

    int opt = 1;
    setsockopt(serverSock, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in servAddr;
    std::memset(&servAddr, 0, sizeof(servAddr));
    servAddr.sin_family = AF_INET;
    servAddr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    servAddr.sin_port = 0; // OS assigns available ephemeral port

    int bRes = bind(serverSock, (struct sockaddr*)&servAddr, sizeof(servAddr));
    TEST_ASSERT(bRes == 0, "Bound mock API server socket");

    socklen_t addrLen = sizeof(servAddr);
    getsockname(serverSock, (struct sockaddr*)&servAddr, &addrLen);
    int assignedPort = ntohs(servAddr.sin_port);
    listen(serverSock, 1);

    std::string capturedRequest;
    std::thread mockApiServer([serverSock, &capturedRequest]() {
        int clientSock = accept(serverSock, nullptr, nullptr);
        if (clientSock >= 0) {
            char buf[4096];
            ssize_t n = read(clientSock, buf, sizeof(buf));
            if (n > 0) {
                capturedRequest.assign(buf, n);
            }
            std::string body = R"({"env":{"DATABASE_URL":"postgres://vault","API_KEY":"secret123","PORT":"8080","CUSTOM_FLAG":"true"}})";
            std::string resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
                               std::to_string(body.length()) + "\r\nConnection: close\r\n\r\n" + body;
            write(clientSock, resp.c_str(), resp.length());
            close(clientSock);
        }
        close(serverSock);
    });

    Config testCfg;
    testCfg.api_url = "http://127.0.0.1:" + std::to_string(assignedPort);
    testCfg.internal_token = "secret-token-s06";
    WorkerDaemon testWorker(testCfg);

    auto parsedEnv = testWorker.fetchEnv("12345678-1234-1234-1234-123456789abc", 3000);
    mockApiServer.join();

    TEST_ASSERT(capturedRequest.find("GET /internal/deployments/12345678-1234-1234-1234-123456789abc/env") != std::string::npos, "fetchEnv sends GET to /internal/deployments/:id/env");
    TEST_ASSERT(capturedRequest.find("X-Internal-Token: secret-token-s06") != std::string::npos, "fetchEnv includes X-Internal-Token header");
    TEST_ASSERT(parsedEnv["DATABASE_URL"] == "postgres://vault", "fetchEnv decodes DATABASE_URL from API payload");
    TEST_ASSERT(parsedEnv["API_KEY"] == "secret123", "fetchEnv decodes API_KEY from API payload");
    TEST_ASSERT(parsedEnv["PORT"] == "8080", "fetchEnv decodes PORT from API payload");
    TEST_ASSERT(parsedEnv["CUSTOM_FLAG"] == "true", "fetchEnv decodes CUSTOM_FLAG from API payload");
    TEST_ASSERT(parsedEnv["NODE_ENV"] == "production", "fetchEnv ensures default NODE_ENV present");
}

int main() {
    std::cout << "==================================================" << std::endl;
    std::cout << "  DeployForge C++ Worker Engine Test Suite       " << std::endl;
    std::cout << "==================================================" << std::endl;

    testConfig();
    testProcessRunner();
    testDockerClientSimulator();
    testRedisClient();
    testWorkerLifecycle();
    testJobValidationAndStartFailure();
    testInternalEnvFetch();

    std::cout << "\n==================================================" << std::endl;
    std::cout << "  All C++ Worker tests passed! (" << g_passed << "/" << g_total << ")" << std::endl;
    std::cout << "==================================================" << std::endl;

    return 0;
}
