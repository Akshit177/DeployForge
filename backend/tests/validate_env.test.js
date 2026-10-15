const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateEnv } = require("../config/validateEnv.js");
const { encrypt, decrypt, CURRENT_KEY_VERSION } = require("../services/crypto.js");
const crypto = require("crypto");

describe("S-05: Environment and Secrets Validation", () => {
  const strongKey1 = "a".repeat(32);
  const strongKey2 = "b".repeat(32);

  it("passes in development mode even with default/missing secrets", () => {
    const result = validateEnv({
      NODE_ENV: "development",
      JWT_SECRET: "short",
      DB_PASSWORD: "postgres",
    });
    assert.equal(result.valid, true);
  });

  it("fails in production when JWT_SECRET is missing", () => {
    assert.throws(
      () =>
        validateEnv({
          NODE_ENV: "production",
          ENCRYPTION_KEY: strongKey1,
          DB_PASSWORD: "strong-password-123",
        }),
      /JWT_SECRET must be set in production/
    );
  });

  it("fails in production when JWT_SECRET is shorter than 32 chars", () => {
    assert.throws(
      () =>
        validateEnv({
          NODE_ENV: "production",
          JWT_SECRET: "short-secret",
          ENCRYPTION_KEY: strongKey1,
          DB_PASSWORD: "strong-password-123",
        }),
      /JWT_SECRET must be at least 32 characters/
    );
  });

  it("fails in production when JWT_SECRET uses a known insecure default", () => {
    assert.throws(
      () =>
        validateEnv({
          NODE_ENV: "production",
          JWT_SECRET: "super-secret-deployforge-key-change-me",
          ENCRYPTION_KEY: strongKey1,
          DB_PASSWORD: "strong-password-123",
        }),
      /JWT_SECRET must not use a known default/
    );
  });

  it("fails in production when ENCRYPTION_KEY is missing", () => {
    assert.throws(
      () =>
        validateEnv({
          NODE_ENV: "production",
          JWT_SECRET: strongKey1,
          DB_PASSWORD: "strong-password-123",
        }),
      /ENCRYPTION_KEY must be set in production/
    );
  });

  it("fails in production when ENCRYPTION_KEY is shorter than 32 chars", () => {
    assert.throws(
      () =>
        validateEnv({
          NODE_ENV: "production",
          JWT_SECRET: strongKey1,
          ENCRYPTION_KEY: "short-key",
          DB_PASSWORD: "strong-password-123",
        }),
      /ENCRYPTION_KEY must be at least 32 characters/
    );
  });

  it("fails in production when ENCRYPTION_KEY uses a known insecure default", () => {
    assert.throws(
      () =>
        validateEnv({
          NODE_ENV: "production",
          JWT_SECRET: strongKey1,
          ENCRYPTION_KEY: "deployforge-vault-default-key-32b",
          DB_PASSWORD: "strong-password-123",
        }),
      /ENCRYPTION_KEY must not use a known default/
    );
  });

  it("fails in production when JWT_SECRET and ENCRYPTION_KEY are identical", () => {
    assert.throws(
      () =>
        validateEnv({
          NODE_ENV: "production",
          JWT_SECRET: strongKey1,
          ENCRYPTION_KEY: strongKey1,
          DB_PASSWORD: "strong-password-123",
        }),
      /JWT_SECRET and ENCRYPTION_KEY must be distinct/
    );
  });

  it("fails in production when DB_PASSWORD is the default 'postgres'", () => {
    assert.throws(
      () =>
        validateEnv({
          NODE_ENV: "production",
          JWT_SECRET: strongKey1,
          ENCRYPTION_KEY: strongKey2,
          DB_PASSWORD: "postgres",
        }),
      /DB_PASSWORD must not use the default 'postgres'/
    );
  });

  it("passes in production when all secrets are secure and distinct", () => {
    const result = validateEnv({
      NODE_ENV: "production",
      JWT_SECRET: strongKey1,
      ENCRYPTION_KEY: strongKey2,
      DB_PASSWORD: "strong-db-password-123",
    });
    assert.equal(result.valid, true);
  });
});

describe("S-05: Crypto Key Versioning and Vault Operations", () => {
  it("encrypts with version prefix (CURRENT_KEY_VERSION = 1)", () => {
    const plain = "MY_SUPER_SECRET_TOKEN=xyz123";
    const enc = encrypt(plain);

    assert.equal(enc.version, CURRENT_KEY_VERSION);
    assert.ok(enc.ciphertext.startsWith("01"), "Ciphertext must start with version byte 01");

    const decrypted = decrypt(enc.ciphertext, enc.iv, enc.authTag);
    assert.equal(decrypted, plain);
  });

  it("decrypts legacy unversioned ciphertext for backward compatibility", () => {
    // Generate legacy ciphertext without "01" prefix directly
    const plain = "LEGACY_SECRET_VAL";
    const iv = crypto.randomBytes(12);
    // Use default seed key
    const seed = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "deployforge-vault-default-key-32b";
    const key = crypto.createHash("sha256").update(String(seed)).digest();

    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    let rawCiphertext = cipher.update(plain, "utf8", "hex");
    rawCiphertext += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");

    // Notice rawCiphertext does NOT have version prefix "01" (unless random chance, but legacy decrypts regardless)
    const decrypted = decrypt(rawCiphertext, iv.toString("hex"), authTag);
    assert.equal(decrypted, plain);
  });

  it("rejects tampered ciphertext or auth tag", () => {
    const enc = encrypt("test-tamper");
    const tamperedTag = "00".repeat(16);

    assert.throws(() => {
      decrypt(enc.ciphertext, enc.iv, tamperedTag);
    });
  });
});
