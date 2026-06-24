const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { auth, db } = require('../config/firebase');
const { verifyAuth } = require('../middleware/auth');
const { validateUsername, validateBio } = require('../utils/validation');

// ---- Avatar storage (disk) ----
const avatarDir = path.join(__dirname, '..', 'uploads', 'avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: avatarDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '') || '.png').toLowerCase();
      cb(null, `${req.user.uid}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPG, WEBP, or GIF images are allowed'));
  },
});

function publicAvatarUrl(req, filename) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}/api/avatars/${filename}`;
}

async function loadProfile(uid) {
  const snap = await db.collection('userProfiles').doc(uid).get();
  return snap.exists ? snap.data() : {};
}

/**
 * GET /api/profile/me  — own profile (auth + profile doc merged)
 */
router.get('/me', verifyAuth, async (req, res) => {
  try {
    const u = await auth.getUser(req.user.uid);
    const profile = await loadProfile(req.user.uid);
    res.json({
      success: true,
      profile: {
        uid: u.uid,
        email: u.email,
        emailVerified: u.emailVerified,
        displayName: profile.displayName || u.displayName || (u.email || '').split('@')[0],
        photoURL: profile.avatarUrl || u.photoURL || null,
        bio: profile.bio || '',
        createdAt: u.metadata.creationTime,
        lastSignInAt: u.metadata.lastSignInTime,
        updatedAt: profile.updatedAt || null,
      },
    });
  } catch (e) {
    console.error('profile/me error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * PUT /api/profile/me  — update displayName / bio
 */
router.put('/me', verifyAuth, async (req, res) => {
  try {
    const { displayName, bio } = req.body || {};
    const updates = {};
    
    if (typeof displayName === 'string') {
      const nameValidation = validateUsername(displayName);
      if (!nameValidation.valid) {
        return res.status(400).json({ success: false, error: nameValidation.error });
      }
      updates.displayName = nameValidation.sanitized;
    }
    
    if (typeof bio === 'string') {
      const bioValidation = validateBio(bio);
      if (!bioValidation.valid) {
        return res.status(400).json({ success: false, error: bioValidation.error });
      }
      updates.bio = bioValidation.sanitized;
    }
    
    updates.updatedAt = new Date().toISOString();

    await db.collection('userProfiles').doc(req.user.uid).set(updates, { merge: true });

    if (updates.displayName) {
      try { await auth.updateUser(req.user.uid, { displayName: updates.displayName }); } catch (e) {}
    }

    const profile = await loadProfile(req.user.uid);
    res.json({ success: true, profile });
  } catch (e) {
    console.error('profile update error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/profile/avatar  — upload new avatar (multipart, field "avatar")
 */
router.post('/avatar', verifyAuth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const url = publicAvatarUrl(req, req.file.filename);

    // delete old avatar file if it was local
    const existing = await loadProfile(req.user.uid);
    if (existing.avatarFilename && existing.avatarFilename !== req.file.filename) {
      const oldPath = path.join(avatarDir, existing.avatarFilename);
      fs.promises.unlink(oldPath).catch(() => {});
    }

    await db.collection('userProfiles').doc(req.user.uid).set({
      avatarUrl: url,
      avatarFilename: req.file.filename,
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    try { await auth.updateUser(req.user.uid, { photoURL: url }); } catch (e) {}

    res.json({ success: true, photoURL: url });
  } catch (e) {
    console.error('avatar upload error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * DELETE /api/profile/avatar  — remove avatar
 */
router.delete('/avatar', verifyAuth, async (req, res) => {
  try {
    const existing = await loadProfile(req.user.uid);
    if (existing.avatarFilename) {
      const oldPath = path.join(avatarDir, existing.avatarFilename);
      fs.promises.unlink(oldPath).catch(() => {});
    }
    await db.collection('userProfiles').doc(req.user.uid).set({
      avatarUrl: null,
      avatarFilename: null,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    try { await auth.updateUser(req.user.uid, { photoURL: null }); } catch (e) {}
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/profile/password — change own password
 * Body: { password }
 */
router.post('/password', verifyAuth, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    await auth.updateUser(req.user.uid, { password });
    res.json({ success: true });
  } catch (e) {
    console.error('change own password error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = { router, avatarDir };
