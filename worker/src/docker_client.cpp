#include "../include/docker_client.hpp"
#include "../include/logger.hpp"
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <chrono>
#include <random>
#include <filesystem>

namespace deployforge {

DockerClient::DockerClient(std::string socketPath, std::string mode)
    : m_mode(std::move(mode)) {
    m_socketPath = resolveSocketPath(socketPath);
}

std::string DockerClient::resolveSocketPath(const std::string& preferred) {
    if (std::filesystem::exists(preferred)) {
        return preferred;
    }
    const char* home = std::getenv("HOME");
    if (home) {
        std::string macSock = std::string(home) + "/.docker/run/docker.sock";
        if (std::filesystem::exists(macSock)) {
            return macSock;
        }
    }
    return preferred;
}

std::string DockerClient::sendHttpRequest(const std::string& method, const std::string& path, const std::string& body) {
    int sock = socket(AF_UNIX, SOCK_STREAM, 0);
    if (sock < 0) {
        throw std::runtime_error("Failed to create Unix domain socket");
    }

    struct sockaddr_un addr;
    std::memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, m_socketPath.c_str(), sizeof(addr.sun_path) - 1);

    if (connect(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        close(sock);
        throw std::runtime_error("Failed to connect to Docker socket at " + m_socketPath);
    }

    std::stringstream req;
    req << method << " " << path << " HTTP/1.1\r\n"
        << "Host: localhost\r\n"
        << "User-Agent: DeployForge-CppWorker/1.0\r\n"
        << "Connection: close\r\n";

    if (!body.empty()) {
        req << "Content-Type: application/json\r\n"
            << "Content-Length: " << body.length() << "\r\n";
    }
    req << "\r\n";
    if (!body.empty()) {
        req << body;
    }

    std::string reqStr = req.str();
    ssize_t sent = write(sock, reqStr.c_str(), reqStr.length());
    if (sent < 0) {
        close(sock);
        throw std::runtime_error("Failed to write HTTP request to Docker socket");
    }

    std::string response;
    char buffer[4096];
    ssize_t bytes;
    while ((bytes = read(sock, buffer, sizeof(buffer))) > 0) {
        response.append(buffer, bytes);
    }
    close(sock);

    // Extract HTTP response body
    auto headerEnd = response.find("\r\n\r\n");
    if (headerEnd != std::string::npos) {
        return response.substr(headerEnd + 4);
    }
    return response;
}

bool DockerClient::ping() {
    if (m_mode == "simulator") {
        return true;
    }
    try {
        std::string res = sendHttpRequest("GET", "/_ping");
        return res.find("OK") != std::string::npos;
    } catch (...) {
        return false;
    }
}

std::string DockerClient::buildImage(const std::string& contextDir, const std::string& imageName) {
    if (m_mode == "simulator") {
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        static std::mt19937_64 rng(1337);
        std::stringstream ss;
        ss << "sim_img_" << std::hex << rng();
        return ss.str();
    }

    // In real mode, use docker build command via socket or CLI helper
    std::string cmd = "tar -C " + contextDir + " -c . | curl -s --unix-socket " + m_socketPath +
                      " -H 'Content-Type: application/x-tar' -X POST 'http://localhost/build?t=" + imageName + "'";
    FILE* pipe = popen(cmd.c_str(), "r");
    if (!pipe) {
        throw std::runtime_error("Failed to execute image build over Docker socket");
    }

    char buffer[256];
    std::string output;
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
    }
    pclose(pipe);

    return imageName;
}

std::string DockerClient::createContainer(const CreateContainerParams& params) {
    if (m_mode == "simulator") {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        static std::mt19937_64 rng(42);
        std::stringstream ss;
        ss << "sim_c_" << std::hex << (rng() & 0xFFFFFFFFFFFFULL);
        return ss.str();
    }

    nlohmann::json j;
    j["Image"] = params.image_name;
    j["User"] = "1000:1000";

    std::string portKey = std::to_string(params.container_port) + "/tcp";
    j["ExposedPorts"] = nlohmann::json::object();
    j["ExposedPorts"][portKey] = nlohmann::json::object();

    j["HostConfig"] = nlohmann::json::object();
    j["HostConfig"]["Privileged"] = false;
    j["HostConfig"]["ReadonlyRootfs"] = false;
    j["HostConfig"]["Memory"] = params.limits.memory_mb * 1024 * 1024;
    j["HostConfig"]["CpuShares"] = params.limits.cpu_shares;
    j["HostConfig"]["PidsLimit"] = params.limits.pids_limit;

    j["Env"] = params.env;

    if (!params.network_name.empty()) {
        j["NetworkingConfig"]["EndpointsConfig"][params.network_name] = nlohmann::json::object();
    }

    std::string body = j.dump();
    std::string path = "/containers/create?name=" + params.container_name;

    std::string res = sendHttpRequest("POST", path, body);
    try {
        auto parsed = nlohmann::json::parse(res);
        if (parsed.contains("Id")) {
            return parsed["Id"].get<std::string>();
        } else if (parsed.contains("message")) {
            throw std::runtime_error("Docker create container failed: " + parsed["message"].get<std::string>());
        }
    } catch (const nlohmann::json::exception& e) {
        throw std::runtime_error("Failed to parse Docker create response: " + std::string(e.what()));
    }
    return params.container_name;
}

bool DockerClient::startContainer(const std::string& containerId) {
    if (m_mode == "simulator") {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        return true;
    }

    try {
        sendHttpRequest("POST", "/containers/" + containerId + "/start");
        return true;
    } catch (const std::exception& e) {
        Logger::error("DockerClient", "Failed to start container " + containerId + ": " + e.what());
        return false;
    }
}

ContainerInfo DockerClient::inspectContainer(const std::string& containerId) {
    ContainerInfo info;
    info.id = containerId;

    if (m_mode == "simulator") {
        info.running = true;
        info.status = "running";
        info.ip_address = "172.20.0.42";
        return info;
    }

    try {
        std::string res = sendHttpRequest("GET", "/containers/" + containerId + "/json");
        auto parsed = nlohmann::json::parse(res);
        if (parsed.contains("State")) {
            info.running = parsed["State"].value("Running", false);
            info.status = parsed["State"].value("Status", "unknown");
        }
        if (parsed.contains("NetworkSettings") && parsed["NetworkSettings"].contains("Networks")) {
            for (auto& [netName, netObj] : parsed["NetworkSettings"]["Networks"].items()) {
                if (netObj.contains("IPAddress") && !netObj["IPAddress"].get<std::string>().empty()) {
                    info.ip_address = netObj["IPAddress"].get<std::string>();
                    break;
                }
            }
        }
    } catch (...) {
        info.running = false;
        info.status = "error";
    }
    return info;
}

bool DockerClient::stopContainer(const std::string& containerId, int timeoutSeconds) {
    if (m_mode == "simulator") {
        return true;
    }
    try {
        sendHttpRequest("POST", "/containers/" + containerId + "/stop?t=" + std::to_string(timeoutSeconds));
        return true;
    } catch (...) {
        return false;
    }
}

bool DockerClient::removeContainer(const std::string& containerId, bool force) {
    if (m_mode == "simulator") {
        return true;
    }
    try {
        sendHttpRequest("DELETE", "/containers/" + containerId + "?v=true&force=" + (force ? "true" : "false"));
        return true;
    } catch (...) {
        return false;
    }
}

} // namespace deployforge
