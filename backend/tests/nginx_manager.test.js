const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  syncNginxConfig,
  getSyncStats,
  resetSyncStats,
  ensureNginxStructure,
  UPSTREAMS_CONF_FILE,
  INGRESS_CONF_FILE,
  BASE_CONF_FILE,
  CONF_D_DIR,
} = require("../services/nginxManager.js");

const {
  registerUpstreamRoute,
  unregisterUpstreamRoute,
  generateNginxConfig,
} = require("../services/proxyRouter.js");

test.describe("R-01: Nginx Config Manager Hardening and Debouncing", () => {
  test("Test 1: Debounced burst coalescing: firing 50 concurrent syncNginxConfig calls results in <= 3 actual writes/reloads, all 50 resolve { synced: true }", async () => {
    resetSyncStats();

    const promises = Array.from({ length: 50 }, () => syncNginxConfig());
    const results = await Promise.all(promises);

    assert.equal(results.length, 50, "All 50 promises should resolve");
    for (const r of results) {
      assert.equal(r.synced, true, "Each call should resolve with synced: true");
      assert.equal(r.valid, true, "Each call should resolve with valid: true");
    }

    const stats = getSyncStats();
    assert.ok(stats.totalSyncCalls >= 50, `totalSyncCalls (${stats.totalSyncCalls}) should be >= 50`);
    assert.ok(
      stats.actualWriteCount <= 3,
      `actualWriteCount (${stats.actualWriteCount}) should be <= 3`
    );
    assert.ok(
      stats.actualReloadCount <= 3,
      `actualReloadCount (${stats.actualReloadCount}) should be <= 3`
    );
    assert.ok(stats.actualWriteCount >= 1, "actualWriteCount should be at least 1");
    assert.ok(stats.actualReloadCount >= 1, "actualReloadCount should be at least 1");
  });

  test("Test 2: Atomic write: temp file is atomically renamed to UPSTREAMS_CONF_FILE without leaving stray .tmp files", async () => {
    const result = await syncNginxConfig();
    assert.equal(result.synced, true);
    assert.ok(fs.existsSync(UPSTREAMS_CONF_FILE), "UPSTREAMS_CONF_FILE must exist after sync");

    const files = fs.readdirSync(CONF_D_DIR);
    const strayTmpFiles = files.filter((f) => f.includes(".tmp"));
    assert.deepEqual(
      strayTmpFiles,
      [],
      `No stray .tmp files should exist in conf.d, found: ${strayTmpFiles.join(", ")}`
    );
  });

  test("Test 3: generateNginxConfig() with DEV_DOMAINS=false omits .localhost and .nip.io hostnames", () => {
    const testDomain = "test-r01-devdomains.app";
    const origDevDomains = process.env.DEV_DOMAINS;
    const origNodeEnv = process.env.NODE_ENV;

    try {
      registerUpstreamRoute(testDomain, {
        projectId: "proj-r01-dev",
        projectName: "r01-service",
        deploymentId: "dep-r01-123",
        port: 8080,
      });

      // When DEV_DOMAINS=false, .localhost and .nip.io hostnames must be omitted
      process.env.DEV_DOMAINS = "false";
      const configDevOff = generateNginxConfig();
      assert.ok(
        configDevOff.includes(`server_name ${testDomain};`),
        "Config must include the primary domain"
      );
      assert.ok(
        !configDevOff.includes("r01-service.localhost;"),
        "Config must omit .localhost hostname when DEV_DOMAINS=false"
      );
      assert.ok(
        !configDevOff.includes("r01-service.127.0.0.1.nip.io;"),
        "Config must omit .nip.io hostname when DEV_DOMAINS=false"
      );

      // When DEV_DOMAINS=true, .localhost and .nip.io hostnames must be included
      process.env.DEV_DOMAINS = "true";
      const configDevOn = generateNginxConfig();
      assert.ok(
        configDevOn.includes(`server_name ${testDomain};`),
        "Config must include primary domain"
      );
      assert.ok(
        configDevOn.includes("server_name r01-service.localhost;"),
        "Config must include .localhost hostname when DEV_DOMAINS=true"
      );
      assert.ok(
        configDevOn.includes("server_name r01-service.127.0.0.1.nip.io;"),
        "Config must include .nip.io hostname when DEV_DOMAINS=true"
      );
    } finally {
      unregisterUpstreamRoute(testDomain);
      if (origDevDomains !== undefined) {
        process.env.DEV_DOMAINS = origDevDomains;
      } else {
        delete process.env.DEV_DOMAINS;
      }
      if (origNodeEnv !== undefined) {
        process.env.NODE_ENV = origNodeEnv;
      } else {
        delete process.env.NODE_ENV;
      }
    }
  });

  test("Test 4: generateNginxConfig() includes proxy_set_header Connection $connection_upgrade; and nginx.conf contains the map directive", () => {
    const testDomain = "test-r01-upgrade.app";

    try {
      registerUpstreamRoute(testDomain, {
        projectId: "proj-r01-upg",
        projectName: "r01-upgrade-service",
        deploymentId: "dep-r01-upg-123",
        port: 5000,
      });

      const config = generateNginxConfig();
      assert.ok(
        config.includes("proxy_set_header Connection $connection_upgrade;"),
        "generateNginxConfig must include proxy_set_header Connection $connection_upgrade;"
      );

      ensureNginxStructure();

      assert.ok(fs.existsSync(BASE_CONF_FILE), "BASE_CONF_FILE (nginx.conf) must exist");
      const baseContent = fs.readFileSync(BASE_CONF_FILE, "utf-8");
      assert.ok(
        baseContent.includes("map $http_upgrade $connection_upgrade"),
        "nginx.conf must contain map $http_upgrade $connection_upgrade directive"
      );
      assert.ok(
        baseContent.includes("default upgrade;"),
        "nginx.conf map directive must define default upgrade;"
      );
      assert.ok(
        baseContent.includes("''      close;"),
        "nginx.conf map directive must define '' close;"
      );

      assert.ok(fs.existsSync(INGRESS_CONF_FILE), "INGRESS_CONF_FILE must exist");
      const ingressContent = fs.readFileSync(INGRESS_CONF_FILE, "utf-8");
      assert.ok(
        ingressContent.includes("proxy_set_header Connection $connection_upgrade;"),
        "deployforge-ingress.conf must include proxy_set_header Connection $connection_upgrade;"
      );
    } finally {
      unregisterUpstreamRoute(testDomain);
    }
  });
});
