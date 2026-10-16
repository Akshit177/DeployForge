const test = require("node:test");
const assert = require("node:assert/strict");

const ENV_KEYS = ["PUBLIC_BASE_DOMAIN", "PUBLIC_SCHEME", "PUBLIC_PORT", "INGRESS_PORT", "DEV_DOMAINS"];

function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const { buildPublicUrl, slugFromDomain } = require("../utils/publicUrl.js");

test.describe("Public URL builder", () => {
  test("defaults to http://<slug>.localhost with no port", () => {
    withEnv({}, () => {
      assert.equal(buildPublicUrl({ domain: "my-app.deployforge.app", name: "my-app" }), "http://my-app.localhost");
    });
  });

  test("never returns the unresolvable *.deployforge.app logical domain", () => {
    withEnv({}, () => {
      assert.ok(!buildPublicUrl({ domain: "shop-2.deployforge.app", name: "shop" }).includes("deployforge.app"));
    });
  });

  test("non-default ingress port is appended (INGRESS_PORT=8080)", () => {
    withEnv({ INGRESS_PORT: "8080" }, () => {
      assert.equal(buildPublicUrl({ domain: "a.deployforge.app" }), "http://a.localhost:8080");
    });
  });

  test("VM deployment via nip.io", () => {
    withEnv({ PUBLIC_BASE_DOMAIN: "203.0.113.10.nip.io" }, () => {
      assert.equal(buildPublicUrl({ domain: "blog.deployforge.app" }), "http://blog.203.0.113.10.nip.io");
    });
  });

  test("https drops :443 but keeps custom ports; scheme/base tolerate sloppy input", () => {
    withEnv({ PUBLIC_BASE_DOMAIN: "https://Apps.Example.com/", PUBLIC_SCHEME: "https", PUBLIC_PORT: "443" }, () => {
      assert.equal(buildPublicUrl({ domain: "x.deployforge.app" }), "https://x.apps.example.com");
    });
    withEnv({ PUBLIC_BASE_DOMAIN: "apps.example.com", PUBLIC_SCHEME: "https", PUBLIC_PORT: "8443" }, () => {
      assert.equal(buildPublicUrl({ domain: "x.deployforge.app" }), "https://x.apps.example.com:8443");
    });
  });

  test("falls back to project name when domain is missing; slug rule matches nginx slug rule", () => {
    assert.equal(slugFromDomain("", "My App!"), "my-app");
    assert.equal(slugFromDomain("under_score-1.deployforge.app"), "under_score-1");
  });
});

test.describe("Nginx ingress hostnames honour PUBLIC_BASE_DOMAIN", () => {
  test("server_name includes slug.<PUBLIC_BASE_DOMAIN> and resolveDomain() matches it", () => {
    withEnv({ PUBLIC_BASE_DOMAIN: "203.0.113.10.nip.io", DEV_DOMAINS: "false" }, () => {
      const { registerUpstreamRoute, unregisterUpstreamRoute, generateNginxConfig, resolveDomain } = require("../services/proxyRouter.js");
      const domain = "pu01-blog.deployforge.app";
      registerUpstreamRoute(domain, {
        projectId: "pu01proj",
        projectName: "pu01-blog",
        deploymentId: "11111111-2222-3333-4444-555555555555",
        containerName: "df-111111112222",
        port: 3000,
      });
      try {
        const cfg = generateNginxConfig();
        assert.ok(cfg.includes("server_name pu01-blog.203.0.113.10.nip.io;"), "public host must be served by nginx");
        assert.ok(resolveDomain("pu01-blog.203.0.113.10.nip.io:80"), "API-side resolver must match the public host");
      } finally {
        unregisterUpstreamRoute(domain);
      }
    });
  });

  test("default base domain adds no extra server_name when DEV_DOMAINS=false", () => {
    withEnv({ DEV_DOMAINS: "false" }, () => {
      const { registerUpstreamRoute, unregisterUpstreamRoute, generateNginxConfig } = require("../services/proxyRouter.js");
      const domain = "pu02-site.deployforge.app";
      registerUpstreamRoute(domain, { projectId: "pu02proj", projectName: "pu02-site", deploymentId: "99999999-2222-3333-4444-555555555555", port: 3000 });
      try {
        assert.ok(!generateNginxConfig().includes("pu02-site.localhost"));
      } finally {
        unregisterUpstreamRoute(domain);
      }
    });
  });
});
