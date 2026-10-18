const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();
const Redis = require("ioredis");

const redisHost = process.env.REDIS_HOST || "127.0.0.1";
const redisPort = Number.parseInt(process.env.REDIS_PORT, 10) || 6379;

const redis = new Redis({
  host: redisHost,
  port: redisPort,
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  // Never give up permanently: a Redis restart longer than a few seconds used to leave the
  // client in the terminal "end" state until the whole API was restarted. Keep retrying with
  // a capped backoff (callers already degrade gracefully while Redis is unavailable).
  retryStrategy(times) {
    if (times === 6) {
      console.warn("Redis still unreachable after 5 retries. Continuing in fallback mode and retrying in the background.");
    }
    return Math.min(times * 200, 5000);
  },
});

redis.on("connect", () => {
  console.log("Connected to Redis server successfully");
});

redis.on("error", (err) => {
  console.warn("Redis client warning:", err.message);
});

module.exports = redis;
