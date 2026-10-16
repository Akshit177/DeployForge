const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config();

const { validateEnv } = require("./config/validateEnv.js");
validateEnv();

const authRoutes = require("./routes/auth.js");
const projectRoutes = require("./routes/projects.js");
const deploymentRoutes = require("./routes/deployments.js");
const logRoutes = require("./routes/logs.js");
const settingsRoutes = require("./routes/settings.js");
const routingRoutes = require("./routes/routing.js");
const internalRoutes = require("./routes/internal.js");
const { syncFromDatabase } = require("./services/proxyRouter.js");
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));

app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/deployments", deploymentRoutes);
app.use("/api/logs", logRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/routing", routingRoutes);
app.use("/internal", internalRoutes);

const defaultPublicDir = path.join(__dirname, "public");
const fallbackDistPath = path.join(__dirname, "../frontend/dist");
const publicDir = process.env.PUBLIC_DIR || (fs.existsSync(defaultPublicDir) ? defaultPublicDir : fallbackDistPath);

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

const http = require("http");
const { getMode } = require("./services/dockerClient.js");

app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/internal/")) {
    return next();
  }

  // In host development or direct proxy mode, check if incoming Host matches an active project route
  const hostHeader = req.headers.host;
  let route = resolveDomain(hostHeader);
  if (!route && hostHeader && !hostHeader.startsWith("localhost:") && hostHeader !== "localhost" && !hostHeader.startsWith("127.0.0.1:") && hostHeader !== "127.0.0.1") {
    await syncFromDatabase().catch(() => {});
    route = resolveDomain(hostHeader);
  }

  if (route) {
    if (getMode() === "simulator") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${route.project_name} - DeployForge</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 2rem 2.5rem; max-width: 480px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3); margin-bottom: 1rem; }
    h1 { margin: 0 0 0.5rem 0; font-size: 1.5rem; }
    p { color: #9ca3af; font-size: 0.875rem; margin: 0 0 1.5rem 0; }
    .meta { background: #030712; border: 1px solid #1f2937; border-radius: 8px; padding: 1rem; font-family: ui-monospace, monospace; font-size: 0.8rem; text-align: left; }
    .meta-row { display: flex; justify-content: space-between; margin-bottom: 0.5rem; }
    .meta-row:last-child { margin-bottom: 0; }
    .meta-label { color: #6b7280; }
    .meta-value { color: #e5e7eb; font-weight: 500; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">● RUNNING</div>
    <h1>${route.project_name}</h1>
    <p>Application successfully deployed and running on DeployForge</p>
    <div class="meta">
      <div class="meta-row"><span class="meta-label">Domain:</span><span class="meta-value">${hostHeader}</span></div>
      <div class="meta-row"><span class="meta-label">Container:</span><span class="meta-value">${route.container_name || "df-container"}</span></div>
      <div class="meta-row"><span class="meta-label">Internal Port:</span><span class="meta-value">:${route.port}</span></div>
      <div class="meta-row"><span class="meta-label">Status:</span><span class="meta-value">200 OK</span></div>
    </div>
  </div>
</body>
</html>`);
    }

    const proxyTargetHost = route.target_host || "127.0.0.1";
    const proxyTargetPort = route.port || 3000;
    const proxyReq = http.request(
      {
        host: proxyTargetHost,
        port: proxyTargetPort,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: hostHeader,
          "x-forwarded-for": req.ip || req.socket.remoteAddress,
          "x-forwarded-proto": req.protocol,
          "x-real-ip": req.ip || req.socket.remoteAddress,
        },
        timeout: 10000,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (err) => {
      console.warn(`[ProxyRouter] Upstream connection error for ${hostHeader}:`, err.message);
      res.status(502).json({
        message: `DeployForge upstream connection failed for ${hostHeader}`,
        error: err.message,
      });
    });

    req.pipe(proxyReq);
    return;
  }

  // Missing static asset files must return 404 instead of falling back to index.html
  if (path.extname(req.path)) {
    return res.status(404).json({ message: "Asset not found" });
  }

  const indexPath = path.join(publicDir, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.status(404).send("Not Found");
});

const { startWorkerLoop } = require("./workers/deploymentWorker.js");
const { startOutboxRelayLoop } = require("./services/outboxRelay.js");
const { startPersistenceWorkerLoop } = require("./workers/persistenceWorker.js");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started running on port ${PORT}`);
  syncFromDatabase().catch((err) => console.warn("Proxy sync warning:", err.message));
  if (process.env.ENABLE_OUTBOX !== "false") {
    startOutboxRelayLoop();
  }
  if (process.env.ENABLE_PERSISTENCE !== "false") {
    startPersistenceWorkerLoop();
  }
  const executionEngine = (process.env.EXECUTION_ENGINE || "node").toLowerCase();
  const enableNodeDeploymentWorker =
    executionEngine !== "cpp" &&
    process.env.ENABLE_NODE_DEPLOYMENT_WORKER !== "false" &&
    process.env.ENABLE_WORKER !== "false";
  if (enableNodeDeploymentWorker) {
    startWorkerLoop().catch((err) => console.warn("Worker loop warning:", err.message));
  } else {
    console.log(`[Worker] Node.js deployment worker disabled (EXECUTION_ENGINE=${executionEngine})`);
  }
});