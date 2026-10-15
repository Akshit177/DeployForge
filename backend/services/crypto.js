const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const CURRENT_KEY_VERSION = 1;
const VERSION_PREFIX_HEX = Buffer.from([CURRENT_KEY_VERSION]).toString("hex"); // "01"

function getMasterKey() {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.ENCRYPTION_KEY) {
      throw new Error("ENCRYPTION_KEY is required in production environment");
    }
    if (process.env.JWT_SECRET && process.env.ENCRYPTION_KEY === process.env.JWT_SECRET) {
      throw new Error("ENCRYPTION_KEY and JWT_SECRET must be distinct in production");
    }
  }
  const seed = process.env.ENCRYPTION_KEY || (process.env.NODE_ENV === "production" ? null : process.env.JWT_SECRET) || "deployforge-vault-default-key-32b";
  return crypto.createHash("sha256").update(String(seed)).digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM with key-version byte prefix
 * @param {string} plainText
 * @returns {{ ciphertext: string, iv: string, authTag: string, version: number }}
 */
function encrypt(plainText) {
  if (typeof plainText !== "string") {
    plainText = String(plainText ?? "");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getMasterKey(), iv);

  let ciphertext = cipher.update(plainText, "utf8", "hex");
  ciphertext += cipher.final("hex");

  const authTag = cipher.getAuthTag().toString("hex");

  return {
    ciphertext: VERSION_PREFIX_HEX + ciphertext,
    iv: iv.toString("hex"),
    authTag,
    version: CURRENT_KEY_VERSION,
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM with authentication tag verification
 * Supports versioned ciphertext (prefixed with version byte) and legacy format.
 * @param {string} ciphertext
 * @param {string} ivHex
 * @param {string} authTagHex
 * @returns {string}
 */
function decrypt(ciphertext, ivHex, authTagHex) {
  if (!ciphertext) return "";

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  // If ciphertext has version prefix (e.g. "01"), attempt versioned decryption first
  if (ciphertext.length > 2 && ciphertext.startsWith("01")) {
    try {
      const payload = ciphertext.slice(2);
      const decipher = crypto.createDecipheriv("aes-256-gcm", getMasterKey(), iv);
      decipher.setAuthTag(authTag);
      let plainText = decipher.update(payload, "hex", "utf8");
      plainText += decipher.final("utf8");
      return plainText;
    } catch (_) {
      // Fall through to legacy decryption in case raw ciphertext started with 01
    }
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", getMasterKey(), iv);
  decipher.setAuthTag(authTag);

  let plainText = decipher.update(ciphertext, "hex", "utf8");
  plainText += decipher.final("utf8");

  return plainText;
}

module.exports = {
  encrypt,
  decrypt,
  CURRENT_KEY_VERSION,
};
