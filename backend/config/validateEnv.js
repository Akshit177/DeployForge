/**
 * Validate environment configuration at application startup.
 * Fails fast in production mode if required secrets are missing, insecure, or sharing keys.
 */

const INSECURE_JWT_DEFAULTS = new Set([
  "super-secret-deployforge-key-change-me",
  "super-secret-deployforge-key-change-me-in-production",
  "your-jwt-secret-here",
  "secret",
  "default-secret",
]);

const INSECURE_ENCRYPTION_DEFAULTS = new Set([
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "deployforge-vault-default-key-32b",
  "default-encryption-key",
]);

function validateEnv(env = process.env) {
  const isProduction = env.NODE_ENV === "production";
  const errors = [];

  if (isProduction) {
    // 1. JWT_SECRET checks
    if (!env.JWT_SECRET) {
      errors.push("JWT_SECRET must be set in production");
    } else if (env.JWT_SECRET.length < 32) {
      errors.push("JWT_SECRET must be at least 32 characters long in production");
    } else if (INSECURE_JWT_DEFAULTS.has(env.JWT_SECRET)) {
      errors.push("JWT_SECRET must not use a known default value in production");
    }

    // 2. ENCRYPTION_KEY checks
    if (!env.ENCRYPTION_KEY) {
      errors.push("ENCRYPTION_KEY must be set in production");
    } else if (env.ENCRYPTION_KEY.length < 32) {
      errors.push("ENCRYPTION_KEY must be at least 32 characters long in production");
    } else if (INSECURE_ENCRYPTION_DEFAULTS.has(env.ENCRYPTION_KEY)) {
      errors.push("ENCRYPTION_KEY must not use a known default value in production");
    }

    // 3. Distinct keys
    if (env.JWT_SECRET && env.ENCRYPTION_KEY && env.JWT_SECRET === env.ENCRYPTION_KEY) {
      errors.push("JWT_SECRET and ENCRYPTION_KEY must be distinct keys in production");
    }

    // 4. Database password check
    if (env.DB_PASSWORD === "postgres") {
      errors.push("DB_PASSWORD must not use the default 'postgres' in production");
    }

    // 5. Internal control-plane token (guards /internal/* which returns decrypted env vars)
    if (!env.INTERNAL_TOKEN) {
      errors.push("INTERNAL_TOKEN must be set in production");
    } else if (env.INTERNAL_TOKEN.length < 16) {
      errors.push("INTERNAL_TOKEN must be at least 16 characters long in production");
    } else if (env.INTERNAL_TOKEN === "deployforge-internal-dev-token") {
      errors.push("INTERNAL_TOKEN must not use the known development default in production");
    }

    if (errors.length > 0) {
      const msg = `[DeployForge FATAL] Production configuration validation failed:\n  - ${errors.join("\n  - ")}`;
      console.error(msg);
      throw new Error(msg);
    }
  }

  return { valid: true };
}

module.exports = {
  validateEnv,
  INSECURE_JWT_DEFAULTS,
  INSECURE_ENCRYPTION_DEFAULTS,
};
