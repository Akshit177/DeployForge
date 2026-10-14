const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  isValidDeploymentId,
  getWorkspacePath,
  cleanupWorkspace,
  detectRuntime,
  prepareWorkspaceDockerfile,
} = require("../services/runtimeDetector.js");

describe("Runtime Detector & Workspace Manager", () => {
  const testWorkspaceBase = path.join(os.tmpdir(), "df-detector-test-" + Date.now());

  before(() => {
    process.env.WORKSPACE_BASE_PATH = testWorkspaceBase;
  });

  after(() => {
    cleanupWorkspace(testWorkspaceBase);
  });

  it("validates deployment IDs and prevents path traversal", () => {
    assert.equal(isValidDeploymentId("123e4567-e89b-12d3-a456-426614174000"), true);
    assert.equal(isValidDeploymentId("dep_123_abc"), true);

    // Malicious or invalid inputs
    assert.equal(isValidDeploymentId("../etc/passwd"), false);
    assert.equal(isValidDeploymentId("dep/123"), false);
    assert.equal(isValidDeploymentId("dep\\123"), false);
    assert.equal(isValidDeploymentId(""), false);
    assert.equal(isValidDeploymentId(null), false);

    assert.throws(() => {
      getWorkspacePath("../traversal-attempt");
    }, /Invalid deploymentId/);
  });

  it("creates and resolves isolated workspace directory", () => {
    const depId = "test-dep-001";
    const wsPath = getWorkspacePath(depId);
    assert.ok(fs.existsSync(wsPath));
    assert.ok(wsPath.includes(depId));
    cleanupWorkspace(wsPath);
  });

  it("detects root Dockerfile in workspace", () => {
    const depId = "test-custom-dockerfile";
    const wsPath = getWorkspacePath(depId);
    fs.writeFileSync(path.join(wsPath, "Dockerfile"), "FROM alpine:latest\nCMD echo hello");

    const info = detectRuntime(wsPath);
    assert.equal(info.runtime, "dockerfile");
    assert.equal(info.hasCustomDockerfile, true);

    const readyDockerfile = prepareWorkspaceDockerfile(wsPath, info);
    assert.equal(readyDockerfile, path.join(wsPath, "Dockerfile"));
    const content = fs.readFileSync(readyDockerfile, "utf-8");
    assert.ok(content.includes("FROM alpine:latest"));

    cleanupWorkspace(wsPath);
  });

  it("strictly throws when repository has package.json but no Dockerfile", () => {
    const depId = "test-node-no-dockerfile";
    const wsPath = getWorkspacePath(depId);
    fs.writeFileSync(
      path.join(wsPath, "package.json"),
      JSON.stringify({
        name: "my-node-app",
        scripts: { start: "node index.js" },
      })
    );

    assert.throws(() => {
      detectRuntime(wsPath);
    }, /No root Dockerfile found in repository/);

    cleanupWorkspace(wsPath);
  });

  it("strictly throws when repository has index.html but no Dockerfile", () => {
    const depId = "test-static-no-dockerfile";
    const wsPath = getWorkspacePath(depId);
    fs.writeFileSync(path.join(wsPath, "index.html"), "<h1>DeployForge Static Test</h1>");

    assert.throws(() => {
      detectRuntime(wsPath);
    }, /No root Dockerfile found in repository/);

    cleanupWorkspace(wsPath);
  });

  it("throws error when repository directory has no Dockerfile", () => {
    const depId = "test-empty-repo";
    const wsPath = getWorkspacePath(depId);
    // empty directory
    assert.throws(() => {
      detectRuntime(wsPath);
    }, /No root Dockerfile found in repository/);

    cleanupWorkspace(wsPath);
  });

  it("prepareWorkspaceDockerfile throws if Dockerfile is missing on disk", () => {
    const depId = "test-missing-file";
    const wsPath = getWorkspacePath(depId);

    assert.throws(() => {
      prepareWorkspaceDockerfile(wsPath, { hasCustomDockerfile: true });
    }, /Expected root Dockerfile at/);

    cleanupWorkspace(wsPath);
  });
});
