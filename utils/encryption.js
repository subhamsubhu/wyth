const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

/**
 * Resolve a strong 32-byte encryption key from env.
 *
 * Security rules:
 *   - No default / fallback key — server cannot be started without a
 *     real ENCRYPTION_KEY.
 *   - Recommended format: 64 hex chars (= 32 raw bytes), generated with
 *     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
 *   - As a convenience, any other string of length >= 32 is also accepted
 *     and hashed to 32 bytes with SHA-256. We do NOT use scrypt with a
 *     static salt anymore (that effectively made the key derivation
 *     deterministic but weak when the input was a default value).
 */
function resolveKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || typeof raw !== 'string') {
    throw new Error(
      'ENCRYPTION_KEY is missing. Generate one with: ' +
      '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` ' +
      'and set it in backend/.env'
    );
  }

  // Reject the legacy insecure placeholder explicitly.
  if (raw === 'default_32_byte_key_change_this!' ||
      raw === 'change_me_to_a_32_byte_strong_encryption_key') {
    throw new Error('ENCRYPTION_KEY is using an insecure default. Replace it.');
  }

  // Preferred: 64-char hex string → 32 raw bytes.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // Fallback: any other string must be at least 32 chars; derive 32 bytes via SHA-256.
  if (raw.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters (64 hex chars recommended).');
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

const KEY = resolveKey();

function encrypt(text) {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex')
    };
  } catch (error) {
    console.error('Encryption error:', error);
    return null;
  }
}

function decrypt(encryptedData) {
  try {
    if (!encryptedData || typeof encryptedData !== 'object') {
      return null;
    }
    
    const { encrypted, iv, authTag } = encryptedData;
    
    // Validate required fields
    if (!encrypted || !iv || !authTag) {
      return null;
    }
    
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    // Silently fail for decryption errors (common when ENCRYPTION_KEY changes)
    // Only log in development
    if (process.env.NODE_ENV === 'development') {
      console.warn('Decryption failed (likely key mismatch):', error.message);
    }
    return null;
  }
}

module.exports = { encrypt, decrypt };
