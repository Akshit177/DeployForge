const fs = require("fs");
const path = require("path");
const pool = require("../config/db.js");

async function runMigrations() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");

  console.log("Applying database schema migrations...");
  try {
    await pool.query(sql);
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
