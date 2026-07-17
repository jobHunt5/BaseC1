// Encrypts per-user secrets at rest (SMTP app passwords) — the DB now holds
// real credentials for potentially many real people, not just dev/test
// data, so these can't sit in profile_json as plaintext like the rest of
// the profile blob. AES-256-GCM with a key generated once and persisted
// the same way AUTH_SECRET/ADMIN_AUTH_SECRET already are.

const crypto = require('crypto');
const { getAllSettings, setSetting } = require('../db');

function getEncryptionKey() {
  if (process.env.EMAIL_ENCRYPTION_KEY) {
    return crypto.createHash('sha256').update(process.env.EMAIL_ENCRYPTION_KEY).digest();
  }
  const stored = getAllSettings();
  if (stored.EMAIL_ENCRYPTION_KEY) {
    return Buffer.from(stored.EMAIL_ENCRYPTION_KEY, 'hex');
  }
  const generated = crypto.randomBytes(32);
  setSetting('EMAIL_ENCRYPTION_KEY', generated.toString('hex'));
  return generated;
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payload) {
  if (!payload) return null;
  try {
    const buf = Buffer.from(payload, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
