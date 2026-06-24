/**
 * bruteForceProtection.js — Account lockout after failed login attempts
 * 
 * Prevents brute-force attacks by tracking failed login attempts per email.
 * After 5 failed attempts, the account is locked for 15 minutes.
 * 
 * This works alongside rate limiting to provide defense-in-depth.
 */

// In-memory store for failed attempts. In production with multiple instances,
// use Redis or Firestore for shared state across replicas.
const failedAttempts = new Map();
const lockedAccounts = new Map();

const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW = 15 * 60 * 1000; // 15 minutes window for attempts

/**
 * Check if an account is currently locked
 */
function isAccountLocked(email) {
  const lockInfo = lockedAccounts.get(email);
  if (!lockInfo) return false;

  const now = Date.now();
  if (now < lockInfo.lockedUntil) {
    return true;
  }

  // Lock expired, clean up
  lockedAccounts.delete(email);
  failedAttempts.delete(email);
  return false;
}

/**
 * Record a failed login attempt
 */
function recordFailedAttempt(email) {
  const now = Date.now();
  const attempts = failedAttempts.get(email) || [];

  // Remove attempts older than the window
  const recentAttempts = attempts.filter(timestamp => now - timestamp < ATTEMPT_WINDOW);
  recentAttempts.push(now);

  failedAttempts.set(email, recentAttempts);

  if (recentAttempts.length >= MAX_ATTEMPTS) {
    const lockedUntil = now + LOCKOUT_DURATION;
    lockedAccounts.set(email, {
      lockedUntil,
      attempts: recentAttempts.length
    });
    console.warn(`🔒 Account locked due to brute force: ${email} (${recentAttempts.length} attempts)`);
    return true; // Account now locked
  }

  return false;
}

/**
 * Clear failed attempts on successful login
 */
function clearFailedAttempts(email) {
  failedAttempts.delete(email);
  lockedAccounts.delete(email);
}

/**
 * Get remaining lockout time in seconds
 */
function getRemainingLockoutTime(email) {
  const lockInfo = lockedAccounts.get(email);
  if (!lockInfo) return 0;

  const remaining = Math.ceil((lockInfo.lockedUntil - Date.now()) / 1000);
  return Math.max(0, remaining);
}

/**
 * Express middleware to check brute force protection before login
 * This should be applied BEFORE the actual login logic runs
 */
function checkBruteForce(req, res, next) {
  const email = req.body?.email;
  
  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'Email is required'
    });
  }

  if (isAccountLocked(email)) {
    const remainingSeconds = getRemainingLockoutTime(email);
    const remainingMinutes = Math.ceil(remainingSeconds / 60);
    
    return res.status(429).json({
      success: false,
      error: `Account temporarily locked due to multiple failed login attempts. Please try again in ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}.`,
      lockedUntil: Date.now() + (remainingSeconds * 1000),
      remainingSeconds
    });
  }

  next();
}

/**
 * Get stats for monitoring (optional - for admin panel)
 */
function getBruteForceStats() {
  return {
    totalTrackedAccounts: failedAttempts.size,
    lockedAccounts: lockedAccounts.size,
    locked: Array.from(lockedAccounts.entries()).map(([email, info]) => ({
      email: email.replace(/(.{2}).*(@.*)/, '$1***$2'), // Partial redaction
      lockedUntil: new Date(info.lockedUntil).toISOString(),
      attempts: info.attempts
    }))
  };
}

module.exports = {
  checkBruteForce,
  recordFailedAttempt,
  clearFailedAttempts,
  isAccountLocked,
  getRemainingLockoutTime,
  getBruteForceStats
};
