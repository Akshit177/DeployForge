const fs = require("fs");
const path = require("path");
const pool = require("../config/db.js");

async function runMigrations() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");

  console.log("Applying database schema migrations...");
  try {
    await pool.query(sql);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS github_connected BOOLEAN DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{"notify_failures": true, "notify_weekly": false}'::jsonb;
      ALTER TABLE deployments ALTER COLUMN status SET DEFAULT 'INITIATED';
      ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    `);

    if (process.env.SEED_DEMO === "true" && process.env.NODE_ENV !== "production") {
      const bcrypt = require("bcryptjs");
      const demoHash = await bcrypt.hash("password123", 10);
      await pool.query(
        `INSERT INTO users (name, email, password_hash, github_connected)
         VALUES ('Anurag Singh', 'anurag@deployforge.dev', $1, true)
         ON CONFLICT (email) DO NOTHING`,
        [demoHash]
      );
    }

    console.log("Database schema migrations applied successfully.");
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .catch(() => process.exit(1));
}

module.exports = { runMigrations };
