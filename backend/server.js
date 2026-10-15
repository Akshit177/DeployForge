const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config();

const authRoutes = require("./routes/auth.js");
const projectRoutes = require("./routes/projects.js");
const deploymentRoutes = require("./routes/deployments.js");
const logRoutes = require("./routes/logs.js");
const settingsRoutes = require("./routes/settings.js");
const routingRoutes = require("./routes/routing.js");
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

const frontendDistPath = path.join(__dirname, "../frontend/dist");
const frontendRootPath = path.join(__dirname, "../frontend");
const frontendStaticPath = fs.existsSync(frontendDistPath) ? frontendDistPath : frontendRootPath;

app.use(express.static(frontendStaticPath));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }

  return res.sendFile(path.join(frontendStaticPath, "index.html"));
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