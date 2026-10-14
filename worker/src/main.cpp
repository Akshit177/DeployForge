#include "../include/config.hpp"
#include "../include/worker.hpp"
#include "../include/logger.hpp"
#include <csignal>
#include <memory>

static std::unique_ptr<deployforge::WorkerDaemon> g_worker;

void handleSignal(int signum) {
    deployforge::Logger::info("Main", "Caught signal " + std::to_string(signum) + ", stopping worker daemon...");
    if (g_worker) {
        g_worker->stop();
    }
}

int main(int argc, char** argv) {
    (void)argc;
    (void)argv;

    std::signal(SIGINT, handleSignal);
    std::signal(SIGTERM, handleSignal);

    deployforge::Logger::info("Main", "==================================================");
    deployforge::Logger::info("Main", "  DeployForge C++ High-Performance Worker Engine  ");
    deployforge::Logger::info("Main", "==================================================");

    auto cfg = deployforge::Config::loadFromEnv();
    g_worker = std::make_unique<deployforge::WorkerDaemon>(cfg);

    if (!g_worker->init()) {
        deployforge::Logger::error("Main", "Failed to initialize worker daemon");
        return 1;
    }

    g_worker->run();
    return 0;
}
