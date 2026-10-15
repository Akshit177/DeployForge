CXX ?= clang++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -O2

# Detect Homebrew include and lib paths on macOS
BREW_PREFIX := $(shell brew --prefix 2>/dev/null || echo /opt/homebrew)
INCLUDES := -Iinclude -I$(BREW_PREFIX)/include -I/usr/local/include
LDFLAGS := -L$(BREW_PREFIX)/lib -L/usr/local/lib -lhiredis

SRC_DIR := src
INC_DIR := include
OBJ_DIR := obj
BIN_DIR := bin

SRCS := $(wildcard $(SRC_DIR)/*.cpp)
OBJS := $(patsubst $(SRC_DIR)/%.cpp, $(OBJ_DIR)/%.o, $(SRCS))

# Exclude main.o for test runner linking
LIB_OBJS := $(filter-out $(OBJ_DIR)/main.o, $(OBJS))

TARGET := $(BIN_DIR)/deployforge-worker
TEST_TARGET := $(BIN_DIR)/test-worker

.PHONY: all worker clean test

all: $(TARGET) $(TEST_TARGET)

worker: $(TARGET)

$(OBJ_DIR):
	mkdir -p $(OBJ_DIR)

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

$(OBJ_DIR)/%.o: $(SRC_DIR)/%.cpp | $(OBJ_DIR)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c $< -o $@

$(TARGET): $(OBJS) | $(BIN_DIR)
	$(CXX) $(CXXFLAGS) $(OBJS) $(LDFLAGS) -o $@

$(TEST_TARGET): $(LIB_OBJS) tests/test_runner.cpp | $(BIN_DIR)
	$(CXX) $(CXXFLAGS) $(INCLUDES) $(LIB_OBJS) tests/test_runner.cpp $(LDFLAGS) -o $@

test: $(TEST_TARGET)
	./$(TEST_TARGET)

clean:
	rm -rf $(OBJ_DIR) $(BIN_DIR)
