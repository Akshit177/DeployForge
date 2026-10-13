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
  retryStrategy(times) {
    if (times > 5) {
      console.warn("Redis connection retry limit reached. Continuing in fallback mode.");
      return null;
    }
    return Math.min(times * 200, 2000);
  },
});

redis.on("connect", () => {
  console.log("Connected to Redis server successfully");
});

redis.on("error", (err) => {
  console.warn("Redis client warning:", err.message);
});

module.exports = redis;
