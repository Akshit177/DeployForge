const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const { publishDeploymentJob, getQueueMetrics, STREAM_NAME, CONSUMER_GROUP } = require("../services/queue.js");
const { pollOnce, CONSUMER_NAME } = require("../workers/deploymentWorker.js");

async function runTestSuite() {
  console.log("==================================================");
  console.log("  DeployForge Redis Streams Queue & Worker Tests  ");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ ${message}`);
      failed++;
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  try {
    // 1. Create a test user and project in PostgreSQL
    const userRes = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, 'hash123')
       RETURNING id`,
      ["Queue Worker User", `queue_worker_${Date.now()}@test.com`]
    );
    const userId = userRes.rows[0].id;

    const projectRes = await pool.query(
      `INSERT INTO projects (user_id, name, repository_url, branch, runtime, port, domain)
       VALUES ($1, $2, $3, 'main', 'node', 3000, 'worker-test.deployforge.app')
       RETURNING id, name, domain`,
      [userId, `worker-test-${Date.now() % 10000}`, "https://github.com/acme/worker-test"]
    );
    const project = projectRes.rows[0];

    const deployRes = await pool.query(
      `INSERT INTO deployments (project_id, user_id, commit_hash, commit_message, branch, status, trigger, url)
       VALUES ($1, $2, 'abc1234', 'test worker build', 'main', 'Queued', 'manual', $3)
       RETURNING id, deployment_number`,
      [project.id, userId, project.domain]
    );
    const deployment = deployRes.rows[0];

    // 2. Publish deployment job to Redis Stream
    const messageId = await publishDeploymentJob({
      deployment_id: deployment.id,
      project_id: project.id,
      user_id: userId,
      repo_url: "https://github.com/acme/worker-test",
      branch: "main",
      commit_hash: "abc1234",
      runtime: "node",
      port: 3000,
      trigger: "manual",
    });
    assert(Boolean(messageId), `Published deployment job to Redis Stream (ID: ${messageId})`);

    // 3. Inspect Redis Stream metrics
    const metrics = await getQueueMetrics();
    assert(metrics.stream === STREAM_NAME, `Stream name verified as ${STREAM_NAME}`);
    assert(metrics.group === CONSUMER_GROUP, `Consumer group verified as ${CONSUMER_GROUP}`);
    assert(metrics.active_jobs >= 1, "Active jobs count reflects published job");

    // 4. Execution Worker pulls and processes jobs from Redis Stream until our target job completes
    console.log(`  Executing worker poll on stream...`);
    let attempts = 0;
    let finalDep = null;
    while (attempts < 15) {
      await pollOnce();
      const res = await pool.query(
        `SELECT status, duration_seconds, container_id FROM deployments WHERE id = $1`,
        [deployment.id]
      );
      if (res.rows[0].status === "Running") {
        finalDep = res.rows[0];
        break;
      }
      attempts++;
    }

    assert(Boolean(finalDep), "Worker successfully consumed and processed target job from Redis Stream");
    assert(finalDep.status === "Running", "Deployment status transitioned to 'Running'");
    assert(Boolean(finalDep.container_id && finalDep.container_id.startsWith("c_")), "Worker generated and assigned container ID");
    assert(finalDep.duration_seconds >= 0, "Worker calculated duration seconds");

    // 6. Verify parent project status updated to Running
    const finalProjRes = await pool.query(
      `SELECT status FROM projects WHERE id = $1`,
      [project.id]
    );
    assert(finalProjRes.rows[0].status === "Running", "Parent project status updated to 'Running'");

    // 7. Verify worker generated logs in PostgreSQL
    const logsRes = await pool.query(
      `SELECT level, source, message FROM logs WHERE deployment_id = $1 ORDER BY created_at ASC`,
      [deployment.id]
    );
    assert(logsRes.rows.length >= 3, "Worker generated build & container deployment logs");
    const hasWorkerPickup = logsRes.rows.some((l) => l.message.includes("picked up deployment"));
    assert(hasWorkerPickup, "Logs contain worker pickup event");
    const hasHealthyLog = logsRes.rows.some((l) => l.message.includes("healthy · public URL active"));
    assert(hasHealthyLog, "Logs contain healthy public route event");

    console.log("==================================================");
    console.log(`  All Queue & Worker tests passed! (${passed}/${passed})`);
    console.log("==================================================");
  } finally {
    redis.disconnect();
    await pool.end();
  }
}

runTestSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
  });
