#pragma once

#include <string>
#include <iostream>
#include <chrono>
#include <iomanip>
#include <sstream>
#include <mutex>

namespace deployforge {

enum class LogLevel {
    INFO,
    STEP,
    WARN,
    ERR
};

class Logger {
public:
    static void log(LogLevel level, const std::string& source, const std::string& message) {
        static std::mutex s_mutex;
        std::lock_guard<std::mutex> lock(s_mutex);

        auto now = std::chrono::system_clock::now();
        auto in_time_t = std::chrono::system_clock::to_time_t(now);
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()) % 1000;

        std::stringstream ss;
        ss << std::put_time(std::localtime(&in_time_t), "%H:%M:%S")
           << '.' << std::setfill('0') << std::setw(3) << ms.count();

        const char* levelStr = "INFO";
        switch (level) {
            case LogLevel::INFO: levelStr = "INFO"; break;
            case LogLevel::STEP: levelStr = "STEP"; break;
            case LogLevel::WARN: levelStr = "WARN"; break;
            case LogLevel::ERR:  levelStr = "ERROR"; break;
        }

        std::cout << "[" << ss.str() << "] [" << levelStr << "] [" << source << "] " << message << std::endl;
    }

    static void info(const std::string& source, const std::string& message) {
        log(LogLevel::INFO, source, message);
    }

    static void step(const std::string& source, const std::string& message) {
        log(LogLevel::STEP, source, message);
    }

    static void warn(const std::string& source, const std::string& message) {
        log(LogLevel::WARN, source, message);
    }

    static void error(const std::string& source, const std::string& message) {
        log(LogLevel::ERR, source, message);
    }
};

} // namespace deployforge
