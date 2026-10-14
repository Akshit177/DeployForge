#include "../include/config.hpp"
#include "../include/logger.hpp"
#include "../include/process_runner.hpp"
#include "../include/docker_client.hpp"
#include "../include/redis_client.hpp"
#include "../include/worker.hpp"
#include <iostream>
#include <cassert>
#include <filesystem>

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
        testDepId, "proj-123", "usr-123", "RUNNING", "running", "c_test_cid_123"
    );
    TEST_ASSERT(evOk, "Deployment event published to stream via XADD");
}

void testWorkerLifecycle() {
    std::cout << "\n[Suite 5] End-to-End Worker Single Job Execution" << std::endl;
    Config cfg;
    cfg.docker_mode = "simulator";
    cfg.workspace_base_path = "/tmp/df_test_workspaces";

    WorkerDaemon worker(cfg);
    if (!worker.init()) {
        std::cout << "  ⚠️ Worker init failed (Redis might be offline), skipping job test" << std::endl;
        return;
    }

    DeploymentJob job;
    job.message_id = "test-msg-001";
    job.deployment_id = "cpp-dep-lifecycle-001";
    job.project_id = "cpp-proj-001";
    job.user_id = "cpp-user-001";
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

int main() {
    std::cout << "==================================================" << std::endl;
    std::cout << "  DeployForge C++ Worker Engine Test Suite       " << std::endl;
    std::cout << "==================================================" << std::endl;

    testConfig();
    testProcessRunner();
    testDockerClientSimulator();
    testRedisClient();
    testWorkerLifecycle();

    std::cout << "\n==================================================" << std::endl;
    std::cout << "  All C++ Worker tests passed! (" << g_passed << "/" << g_total << ")" << std::endl;
    std::cout << "==================================================" << std::endl;

    return 0;
}
