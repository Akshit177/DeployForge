#pragma once

#include <string>
#include <vector>
#include <map>
#include <utility>
#include <nlohmann/json.hpp>

namespace deployforge {

struct ContainerLimits {
    int64_t memory_mb = 512;
    int cpu_shares = 256;
    int pids_limit = 100;
};

struct CreateContainerParams {
    std::string image_name;
    std::string container_name;
    int container_port = 3000;
    std::vector<std::string> env;
    std::string network_name = "deployforge-apps";
    ContainerLimits limits;
};

struct ContainerInfo {
    std::string id;
    std::string name;
    bool running = false;
    std::string status;
    std::string ip_address;
};

class DockerClient {
public:
    explicit DockerClient(std::string socketPath = "/var/run/docker.sock", std::string mode = "simulator");
    ~DockerClient() = default;

    bool ping();
    std::string buildImage(const std::string& contextDir, const std::string& imageName);
    std::string createContainer(const CreateContainerParams& params);
    bool startContainer(const std::string& containerId);
    ContainerInfo inspectContainer(const std::string& containerId);
    bool stopContainer(const std::string& containerId, int timeoutSeconds = 10);
    bool removeContainer(const std::string& containerId, bool force = true);

    std::string getMode() const { return m_mode; }
    void setMode(const std::string& mode) { m_mode = mode; }

    static bool isValidImageName(const std::string& name);
    static std::pair<int, std::string> parseHttpResponse(const std::string& rawResponse);
    std::string sendHttpRequest(const std::string& method, const std::string& path, const std::string& body = "");

private:
    std::string m_socketPath;
    std::string m_mode;

    std::string resolveSocketPath(const std::string& preferred);
};

} // namespace deployforge
