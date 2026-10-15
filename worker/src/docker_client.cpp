#include "../include/docker_client.hpp"
#include "../include/process_runner.hpp"
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
#include <regex>
#include <algorithm>

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

bool DockerClient::isValidImageName(const std::string& name) {
    if (name.empty()) return false;
    static const std::regex s_imgPattern("^[a-z0-9][a-z0-9_.-]{0,127}(:[A-Za-z0-9_.-]{1,128})?$");
    return std::regex_match(name, s_imgPattern);
}

static std::string decodeChunked(const std::string& in) {
    std::string out;
    size_t pos = 0;
    while (pos < in.size()) {
        auto lineEnd = in.find("\r\n", pos);
        if (lineEnd == std::string::npos) break;
        std::string sizeLine = in.substr(pos, lineEnd - pos);
        auto semi = sizeLine.find(';');
        if (semi != std::string::npos) {
            sizeLine = sizeLine.substr(0, semi);
        }
        while (!sizeLine.empty() && (sizeLine.back() == ' ' || sizeLine.back() == '\t')) sizeLine.pop_back();
        if (sizeLine.empty()) {
            pos = lineEnd + 2;
            continue;
        }
        size_t chunkSize = 0;
        try {
            chunkSize = std::stoul(sizeLine, nullptr, 16);
        } catch (...) {
            break;
        }
        if (chunkSize == 0) {
            break; // Terminal chunk
        }
        size_t dataStart = lineEnd + 2;
        if (dataStart + chunkSize > in.size()) {
            out.append(in.substr(dataStart));
            break;
        }
        out.append(in.substr(dataStart, chunkSize));
        pos = dataStart + chunkSize + 2; // skip data + \r\n
    }
    return out;
}

std::pair<int, std::string> DockerClient::parseHttpResponse(const std::string& rawResponse) {
    if (rawResponse.empty()) {
        throw std::runtime_error("Empty HTTP response from Docker socket");
    }

    int statusCode = 0;
    auto statusLineEnd = rawResponse.find("\r\n");
    if (statusLineEnd != std::string::npos) {
        std::string statusLine = rawResponse.substr(0, statusLineEnd);
        auto firstSpace = statusLine.find(' ');
        if (firstSpace != std::string::npos && firstSpace + 4 <= statusLine.size()) {
            try {
                statusCode = std::stoi(statusLine.substr(firstSpace + 1, 3));
            } catch (...) {
                statusCode = 0;
            }
        }
    }

    std::string headers;
    std::string body;
    auto headerEnd = rawResponse.find("\r\n\r\n");
    if (headerEnd != std::string::npos) {
        headers = rawResponse.substr(0, headerEnd);
        body = rawResponse.substr(headerEnd + 4);
    } else {
        headers = rawResponse;
    }

    // Check for chunked transfer-encoding (case-insensitive)
    std::string lowerHeaders = headers;
    std::transform(lowerHeaders.begin(), lowerHeaders.end(), lowerHeaders.begin(), ::tolower);
    if (lowerHeaders.find("transfer-encoding: chunked") != std::string::npos ||
        lowerHeaders.find("transfer-encoding:\tchunked") != std::string::npos ||
        (lowerHeaders.find("transfer-encoding:") != std::string::npos && lowerHeaders.find("chunked") != std::string::npos)) {
        body = decodeChunked(body);
    }

    return {statusCode, body};
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

    auto [statusCode, parsedBody] = parseHttpResponse(response);
    if (statusCode < 200 || statusCode >= 300) {
        throw std::runtime_error("Docker API error (" + std::to_string(statusCode) + "): " + parsedBody);
    }
    return parsedBody;
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
    if (!isValidImageName(imageName)) {
        throw std::invalid_argument("Invalid Docker image name: " + imageName);
    }

    if (m_mode == "simulator") {
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        static std::mt19937_64 rng(1337);
        std::stringstream ss;
        ss << "sim_img_" << std::hex << rng();
        return ss.str();
    }

    // In real mode, use ProcessRunner to execute docker build safely without shell
    std::vector<std::string> args = {"build", "-t", imageName, contextDir};
    auto res = ProcessRunner::executeCommand("docker", args, "", 300);
    if (!res.success()) {
        throw std::runtime_error("Docker build failed (exit " + std::to_string(res.exit_code) + "): " + res.output);
    }

    return imageName;
}

std::string DockerClient::createContainer(const CreateContainerParams& params) {
    if (m_mode == "simulator") {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        if (params.container_name.find("fail") != std::string::npos || params.image_name.find("fail") != std::string::npos) {
            return "fail_sim_c_12345";
        }
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
        if (containerId.rfind("fail_", 0) == 0) {
            Logger::error("DockerClient", "Simulator forced failure to start container " + containerId);
            return false;
        }
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
