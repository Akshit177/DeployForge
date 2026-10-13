const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

function getMasterKey() {
  const seed = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "deployforge-vault-default-key-32b";
  return crypto.createHash("sha256").update(String(seed)).digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM
 * @param {string} plainText
 * @returns {{ ciphertext: string, iv: string, authTag: string }}
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
    ciphertext,
    iv: iv.toString("hex"),
    authTag,
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM with authentication tag verification
 * @param {string} ciphertext
 * @param {string} ivHex
 * @param {string} authTagHex
 * @returns {string}
 */
function decrypt(ciphertext, ivHex, authTagHex) {
  if (!ciphertext) return "";

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getMasterKey(), iv);
  decipher.setAuthTag(authTag);

  let plainText = decipher.update(ciphertext, "hex", "utf8");
  plainText += decipher.final("utf8");

  return plainText;
}

module.exports = {
  encrypt,
  decrypt,
};
