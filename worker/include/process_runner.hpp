#pragma once

#include <string>
#include <vector>
#include <regex>
#include <filesystem>
#include <chrono>
#include <thread>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <signal.h>
#include "logger.hpp"

namespace deployforge {

struct CommandResult {
    int exit_code = -1;
    std::string output;
    bool timed_out = false;
    bool success() const { return exit_code == 0 && !timed_out; }
};

class ProcessRunner {
public:
    static bool isValidDeploymentId(const std::string& id) {
        if (id.empty()) return false;
        static const std::regex s_idPattern("^[a-zA-Z0-9_-]+$");
        return std::regex_match(id, s_idPattern);
    }

    static std::string getWorkspacePath(const std::string& basePath, const std::string& deploymentId) {
        if (!isValidDeploymentId(deploymentId)) {
            throw std::runtime_error("Invalid deploymentId: path traversal attempted or malformed ID");
        }

        std::filesystem::path base(basePath);
        std::error_code ec;

        if (!std::filesystem::exists(base, ec)) {
            if (!std::filesystem::create_directories(base, ec)) {
                // Fallback to home directory if base path cannot be created (e.g. /var/lib without root permissions)
                const char* home = std::getenv("HOME");
                std::string fallback = (home ? std::string(home) : "/tmp") + "/.deployforge/workspaces";
                base = std::filesystem::path(fallback);
                std::filesystem::create_directories(base, ec);
            }
        }

        std::filesystem::path ws = base / deploymentId;
        std::filesystem::create_directories(ws, ec);
        return ws.string();
    }

    static bool cleanupWorkspace(const std::string& workspacePath) {
        std::error_code ec;
        if (std::filesystem::exists(workspacePath, ec)) {
            std::filesystem::remove_all(workspacePath, ec);
            return !ec;
        }
        return false;
    }

    static CommandResult executeCommand(
        const std::string& cmd,
        const std::vector<std::string>& args,
        const std::string& workingDir = "",
        int timeoutSeconds = 60
    ) {
        CommandResult result;

        int pipefd[2];
        if (pipe(pipefd) == -1) {
            result.output = "Failed to create pipe";
            return result;
        }

        pid_t pid = fork();
        if (pid == -1) {
            close(pipefd[0]);
            close(pipefd[1]);
            result.output = "Failed to fork process";
            return result;
        }

        if (pid == 0) {
            // Child process
            close(pipefd[0]); // Close read end
            dup2(pipefd[1], STDOUT_FILENO);
            dup2(pipefd[1], STDERR_FILENO);
            close(pipefd[1]);

            if (!workingDir.empty()) {
                if (chdir(workingDir.c_str()) != 0) {
                    _exit(127);
                }
            }

            setenv("GIT_TERMINAL_PROMPT", "0", 1);

            std::vector<char*> argv;
            argv.push_back(const_cast<char*>(cmd.c_str()));
            for (const auto& arg : args) {
                argv.push_back(const_cast<char*>(arg.c_str()));
            }
            argv.push_back(nullptr);

            execvp(cmd.c_str(), argv.data());
            _exit(127);
        }

        // Parent process
        close(pipefd[1]); // Close write end

        // Set non-blocking on pipe read end
        int flags = fcntl(pipefd[0], F_GETFL, 0);
        fcntl(pipefd[0], F_SETFL, flags | O_NONBLOCK);

        auto startTime = std::chrono::steady_clock::now();
        bool finished = false;
        char buffer[4096];

        while (!finished) {
            ssize_t bytesRead = read(pipefd[0], buffer, sizeof(buffer) - 1);
            if (bytesRead > 0) {
                buffer[bytesRead] = '\0';
                result.output.append(buffer, bytesRead);
            }

            int status = 0;
            pid_t waitRes = waitpid(pid, &status, WNOHANG);

            if (waitRes == pid) {
                finished = true;
                if (WIFEXITED(status)) {
                    result.exit_code = WEXITSTATUS(status);
                } else if (WIFSIGNALED(status)) {
                    result.exit_code = 128 + WTERMSIG(status);
                }
            } else if (waitRes == -1) {
                finished = true;
                result.exit_code = -1;
            } else {
                auto now = std::chrono::steady_clock::now();
                auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - startTime).count();
                if (elapsed >= timeoutSeconds) {
                    result.timed_out = true;
                    kill(pid, SIGKILL);
                    waitpid(pid, nullptr, 0);
                    finished = true;
                } else {
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
                }
            }
        }

        // Read any remaining output
        ssize_t bytesRead;
        while ((bytesRead = read(pipefd[0], buffer, sizeof(buffer) - 1)) > 0) {
            buffer[bytesRead] = '\0';
            result.output.append(buffer, bytesRead);
        }

        close(pipefd[0]);
        return result;
    }

    static std::string trim(const std::string& str) {
        size_t first = str.find_first_not_of(" \t\n\r");
        if (first == std::string::npos) return "";
        size_t last = str.find_last_not_of(" \t\n\r");
        return str.substr(first, (last - first + 1));
    }

    static CommandResult cloneRepository(
        const std::string& repoUrl,
        const std::string& branch,
        const std::string& targetDir,
        int timeoutSeconds = 60
    ) {
        std::vector<std::string> args = {
            "clone",
            "--depth", "1",
            "-b", branch.empty() ? "main" : branch,
            "--",
            repoUrl,
            targetDir
        };
        return executeCommand("git", args, "", timeoutSeconds);
    }
};

} // namespace deployforge
