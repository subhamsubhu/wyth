/**
 * authTracking.js — Login tracking and brute force protection routes
 * 
 * Firebase Auth handles actual login on the client side, but we track
 * login attempts here to prevent brute force attacks.
 */

const express = require('express');
const router = express.Router();
const { auth } = require('../config/firebase');
const {
  checkBruteForce,
  recordFailedAttempt,
  clearFailedAttempts
} = require('../middleware/bruteForceProtection');

/**
 * POST /api/auth/track-login
 * 
 * Called by frontend AFTER Firebase login attempt to track success/failure
 * This allows us to implement brute force protection even though Firebase
 * handles the actual authentication.
 */
router.post('/track-login', checkBruteForce, async (req, res) => {
  const { email, success, token } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'Email is required'
    });
  }

  // If login was successful, verify the token and clear failed attempts
  if (success && token) {
    try {
      const decoded = await auth.verifyIdToken(token, true);
      if (decoded.email === email) {
        clearFailedAttempts(email);
        return res.json({
          success: true,
          message: 'Login tracked successfully'
        });
      }
    } catch (error) {
      console.error('Token verification failed in track-login:', error.message);
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }
  }

  // If login failed, record the attempt
  if (!success) {
    const isLocked = recordFailedAttempt(email);
    
    if (isLocked) {
      return res.status(429).json({
        success: false,
        error: 'Account locked due to multiple failed login attempts. Please try again in 15 minutes.',
        locked: true
      });
    }

    return res.json({
      success: true,
      message: 'Failed attempt recorded'
    });
  }

  res.status(400).json({
    success: false,
    error: 'Invalid request'
  });
});

/**
 * POST /api/auth/check-lockout
 * 
 * Check if an account is locked before attempting login
 * This provides better UX by showing lockout status upfront
 */
router.post('/check-lockout', (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'Email is required'
    });
  }

  const {
    isAccountLocked,
    getRemainingLockoutTime
  } = require('../middleware/bruteForceProtection');

  if (isAccountLocked(email)) {
    const remainingSeconds = getRemainingLockoutTime(email);
    const remainingMinutes = Math.ceil(remainingSeconds / 60);

    return res.status(429).json({
      success: false,
      locked: true,
      error: `Account temporarily locked. Please try again in ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}.`,
      remainingSeconds
    });
  }

  res.json({
    success: true,
    locked: false
  });
});

module.exports = router;
