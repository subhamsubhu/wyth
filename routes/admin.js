const express = require('express');
const router = express.Router();
const { db, auth, realtimeDb } = require('../config/firebase');
const { verifyAuth } = require('../middleware/auth');
const {
  ROLES,
  verifyAdmin,
  verifySuperAdmin,
  resolveRole,
  resolveRoleFromRequest,
  isAdminRole,
  isSuperadminRole
} = require('../middleware/adminAuth');
const { setUserRole } = require('../utils/roleMigration');
const axios = require('axios');

/**
 * "Who am I?" — used by the frontend to gate admin UI.
 * Backend is still the source of truth on every privileged action.
 */
router.get('/me', verifyAuth, async (req, res) => {
  try {
    const info = await resolveRoleFromRequest(req);
    if (!info) return res.status(401).json({ error: 'Unauthorized' });
    res.json({
      success: true,
      email: info.email,
      role: info.role,
      isAdmin: isAdminRole(info.role),
      isSuperAdmin: isSuperadminRole(info.role)
    });
  } catch (e) {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
});

/**
 * Dashboard stats — admin or superadmin.
 */
router.get('/dashboard', verifyAdmin, async (req, res) => {
  try {
    const [roomsSnap, usersResult] = await Promise.all([
      db.collection('rooms').get(),
      auth.listUsers(1000)
    ]);

    const rooms = [];
    let totalMembers = 0;
    roomsSnap.forEach(d => {
      const r = d.data();
      rooms.push(r);
      if (r.members) totalMembers += Object.keys(r.members).length;
    });

    const activeRooms = rooms.filter(r => r.isActive).length;
    const totalUsers = usersResult.users.length;
    const disabledUsers = usersResult.users.filter(u => u.disabled).length;

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentUsers = usersResult.users.filter(u =>
      u.metadata.creationTime && new Date(u.metadata.creationTime).getTime() > weekAgo
    ).length;

    res.json({
      success: true,
      stats: {
        totalUsers,
        disabledUsers,
        recentUsers,
        totalRooms: rooms.length,
        activeRooms,
        inactiveRooms: rooms.length - activeRooms,
        totalMembersAcrossRooms: totalMembers,
        serverTime: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Helper: fetch every user's role in one shot (Firestore users collection).
 * Returns Map<uid, role>.
 */
async function getRolesMap() {
  const map = new Map();
  try {
    const snap = await db.collection('users').get();
    snap.forEach(d => {
      const r = (d.data().role || '').toString().toLowerCase();
      if (r) map.set(d.id, r);
    });
  } catch (err) {
    console.error('getRolesMap error:', err.message);
  }
  return map;
}

/**
 * List all users (admin + superadmin)
 */
router.get('/users', verifyAdmin, async (req, res) => {
  try {
    const [result, rolesMap] = await Promise.all([
      auth.listUsers(1000),
      getRolesMap()
    ]);
    const users = result.users.map(u => {
      const role = rolesMap.get(u.uid) || ROLES.USER;
      return {
        uid: u.uid,
        email: u.email,
        displayName: u.displayName,
        disabled: u.disabled,
        emailVerified: u.emailVerified,
        createdAt: u.metadata.creationTime,
        lastSignInAt: u.metadata.lastSignInTime,
        role,
        isAdmin: isAdminRole(role),
        isSuperAdmin: isSuperadminRole(role)
      };
    });
    res.json({ success: true, users });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Helper: load a target user + role, with a guard against acting on a superadmin.
 */
async function loadTargetUser(uid) {
  const user = await auth.getUser(uid);
  const snap = await db.collection('users').doc(uid).get();
  const role = snap.exists ? (snap.data().role || ROLES.USER) : ROLES.USER;
  return { user, role };
}

/**
 * Disable a user (admin or superadmin).
 * Guard: cannot disable any admin/superadmin (only superadmin demotes those).
 */
router.post('/users/:uid/disable', verifyAdmin, async (req, res) => {
  try {
    const { role } = await loadTargetUser(req.params.uid);
    if (isAdminRole(role)) {
      return res.status(400).json({ success: false, error: 'Cannot disable an admin. Demote them first.' });
    }
    await auth.updateUser(req.params.uid, { disabled: true });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Enable a user (admin or superadmin)
 */
router.post('/users/:uid/enable', verifyAdmin, async (req, res) => {
  try {
    await auth.updateUser(req.params.uid, { disabled: false });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete a user (admin or superadmin). Cannot delete an admin or superadmin.
 */
router.delete('/users/:uid', verifyAdmin, async (req, res) => {
  try {
    const { role } = await loadTargetUser(req.params.uid);
    if (isAdminRole(role)) {
      return res.status(400).json({ success: false, error: 'Cannot delete an admin. Demote them first.' });
    }
    await auth.deleteUser(req.params.uid);
    try { await db.collection('users').doc(req.params.uid).delete(); } catch (e) { /* best effort */ }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * List rooms (admin or superadmin)
 */
router.get('/rooms', verifyAdmin, async (req, res) => {
  try {
    const snap = await db.collection('rooms').limit(500).get();
    const rooms = [];
    snap.forEach(d => rooms.push({ id: d.id, ...d.data() }));
    rooms.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, rooms });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Force-delete a room (admin)
 */
router.delete('/rooms/:roomId', verifyAdmin, async (req, res) => {
  try {
    await db.collection('rooms').doc(req.params.roomId).delete();
    try { await realtimeDb.ref(`rooms/${req.params.roomId}`).remove(); } catch (e) { /* best effort */ }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ─────────────── Announcements ─────────────── */

router.post('/announcements', verifyAdmin, async (req, res) => {
  try {
    const { title, message, level = 'info', active = true } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    const doc = {
      title: (title || '').slice(0, 120),
      message: message.slice(0, 1000),
      level: ['info', 'success', 'warning', 'critical'].includes(level) ? level : 'info',
      active: !!active,
      createdAt: new Date().toISOString(),
      createdBy: req.user.email
    };
    const ref = await db.collection('announcements').add(doc);

    if (doc.active) {
      const others = await db.collection('announcements').where('active', '==', true).get();
      const batch = db.batch();
      others.forEach(o => { if (o.id !== ref.id) batch.update(o.ref, { active: false }); });
      await batch.commit();
    }

    res.json({ success: true, id: ref.id, announcement: { id: ref.id, ...doc } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/announcements', verifyAdmin, async (req, res) => {
  try {
    const snap = await db.collection('announcements').limit(100).get();
    const items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, announcements: items });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/announcements/:id', verifyAdmin, async (req, res) => {
  try {
    await db.collection('announcements').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/announcements/:id', verifyAdmin, async (req, res) => {
  try {
    const { active } = req.body;
    const updates = {};
    if (typeof active === 'boolean') updates.active = active;
    await db.collection('announcements').doc(req.params.id).update(updates);

    if (active === true) {
      const others = await db.collection('announcements').where('active', '==', true).get();
      const batch = db.batch();
      others.forEach(o => { if (o.id !== req.params.id) batch.update(o.ref, { active: false }); });
      await batch.commit();
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ─────────────── Admin Management (SUPERADMIN ONLY) ─────────────── */

/**
 * List admins (everyone with role admin or superadmin).
 * Visible to any admin so they can see who else is in the console,
 * but mutations below require superadmin.
 */
router.get('/admins', verifyAdmin, async (req, res) => {
  try {
    const usersSnap = await db.collection('users')
      .where('role', 'in', [ROLES.ADMIN, ROLES.SUPERADMIN])
      .get();

    const admins = await Promise.all(usersSnap.docs.map(async d => {
      const data = d.data();
      const email = (data.email || '').toLowerCase();
      let displayName = null, disabled = false, createdAt = null;
      try {
        const u = await auth.getUser(d.id);
        displayName = u.displayName;
        disabled = u.disabled;
        createdAt = u.metadata.creationTime;
      } catch (e) { /* user vanished */ }
      const role = (data.role || ROLES.ADMIN).toLowerCase();
      return {
        uid: d.id,
        email,
        displayName,
        disabled,
        createdAt,
        role,
        // For backwards-compat with existing UI fields:
        source: role === ROLES.SUPERADMIN ? 'superadmin' : 'role',
        removable: role !== ROLES.SUPERADMIN && d.id !== req.user.uid
      };
    }));

    res.json({ success: true, admins });
  } catch (error) {
    console.error('List admins error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create / promote an admin (SUPERADMIN ONLY).
 * Body: { email, password?, displayName?, role? }
 *
 * - If the Firebase user exists, they are promoted (no password is set
 *   unless explicitly provided).
 * - If the Firebase user does NOT exist, a `password` MUST be supplied so
 *   the account can be created. The password is used ONCE and never stored.
 * - `role` defaults to "admin". Only superadmins may set role="superadmin".
 */
router.post('/admins', verifySuperAdmin, async (req, res) => {
  try {
    const { email, password, displayName, role: requestedRole } = req.body || {};
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }
    const normEmail = String(email).trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normEmail)) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }
    const role = requestedRole === ROLES.SUPERADMIN ? ROLES.SUPERADMIN : ROLES.ADMIN;

    let user;
    try {
      user = await auth.getUserByEmail(normEmail);
      // Existing user — only update password if explicitly provided.
      if (password) {
        if (String(password).length < 6) {
          return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
        }
        await auth.updateUser(user.uid, {
          password,
          emailVerified: true,
          ...(displayName ? { displayName } : {})
        });
      } else if (displayName) {
        await auth.updateUser(user.uid, { displayName });
      }
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        if (!password || String(password).length < 6) {
          return res.status(400).json({
            success: false,
            error: 'Password (min 6 chars) is required to create a new admin user'
          });
        }
        user = await auth.createUser({
          email: normEmail,
          password,
          displayName: displayName || normEmail.split('@')[0],
          emailVerified: true
        });
      } else {
        throw e;
      }
    }

    await setUserRole(user.uid, normEmail, role, `superadmin:${req.user.email}`);

    res.json({
      success: true,
      admin: {
        uid: user.uid,
        email: normEmail,
        displayName: displayName || user.displayName,
        role,
        source: role === ROLES.SUPERADMIN ? 'superadmin' : 'role',
        removable: role !== ROLES.SUPERADMIN
      }
    });
  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Revoke admin / demote to user (SUPERADMIN ONLY).
 * Cannot revoke a superadmin or yourself.
 *
 * Param is the email (kept for backwards compatibility with the existing UI).
 */
router.delete('/admins/:email', verifySuperAdmin, async (req, res) => {
  try {
    const email = String(req.params.email).trim().toLowerCase();
    if (email === String(req.user.email).toLowerCase()) {
      return res.status(400).json({ success: false, error: 'You cannot revoke your own access' });
    }
    let user;
    try {
      user = await auth.getUserByEmail(email);
    } catch (e) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const snap = await db.collection('users').doc(user.uid).get();
    const currentRole = snap.exists ? (snap.data().role || '').toLowerCase() : '';
    if (currentRole === ROLES.SUPERADMIN) {
      return res.status(400).json({ success: false, error: 'Cannot revoke a superadmin' });
    }
    await setUserRole(user.uid, email, ROLES.USER, `superadmin:${req.user.email}`);
    // Clean up legacy `admins` doc if it still exists.
    try { await db.collection('admins').doc(email).delete(); } catch (e) { /* best effort */ }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Promote any user to admin by uid (SUPERADMIN ONLY).
 * Body: { role?: 'admin' | 'superadmin' }
 */
router.post('/users/:uid/promote', verifySuperAdmin, async (req, res) => {
  try {
    const { role: requestedRole } = req.body || {};
    const role = requestedRole === ROLES.SUPERADMIN ? ROLES.SUPERADMIN : ROLES.ADMIN;
    const user = await auth.getUser(req.params.uid);
    await setUserRole(user.uid, user.email, role, `superadmin:${req.user.email}`);
    res.json({ success: true, role });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Change password for any user (SUPERADMIN ONLY).
 * Plain admins can no longer reset other people's passwords — that's a
 * privilege escalation surface that belongs to the superadmin.
 */
router.post('/users/:uid/password', verifySuperAdmin, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    await auth.updateUser(req.params.uid, { password });
    res.json({ success: true });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Helper: verify a password by attempting a Firebase REST sign-in.
 */
async function verifyFirebasePassword(email, password) {
  try {
    const apiKey = process.env.FIREBASE_API_KEY || process.env.FIREBASE_WEB_API_KEY;
    if (!apiKey) {
      throw new Error('Firebase API key not configured. Set FIREBASE_API_KEY in .env');
    }
    const response = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      { email, password, returnSecureToken: true }
    );
    return !!(response.data && response.data.idToken);
  } catch (error) {
    if (error.response?.status === 400) return false;
    throw error;
  }
}

/**
 * Change password by email.
 *
 * Two distinct flows:
 *   1. Self-change (any admin): MUST supply currentPassword for re-auth.
 *   2. Change someone else's password: SUPERADMIN ONLY.
 *
 * We accept both flows on the same endpoint to preserve the existing UI.
 */
router.post('/admins/change-password', verifyAdmin, async (req, res) => {
  try {
    const { email, password, currentPassword } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    const targetEmail = String(email).toLowerCase();
    const requestingEmail = String(req.user.email).toLowerCase();
    const isSelf = targetEmail === requestingEmail;

    if (!isSelf && !req.user.isSuperAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Only a superadmin can change another user\'s password'
      });
    }

    if (isSelf) {
      if (!currentPassword) {
        return res.status(400).json({
          success: false,
          error: 'Current password is required when changing your own password'
        });
      }
      const ok = await verifyFirebasePassword(targetEmail, currentPassword);
      if (!ok) {
        return res.status(401).json({ success: false, error: 'Current password is incorrect' });
      }
    }

    const user = await auth.getUserByEmail(targetEmail);
    await auth.updateUser(user.uid, { password });

    res.json({ success: true });
  } catch (error) {
    console.error('Change admin password error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ─────────────── Users Updates (Support inbox) ─────────────── */

const SUPPORT_TYPES = { help: 'help', feedback: 'feedback', feature: 'feature' };

function originalRequestSnapshot(data) {
  if (data.type === 'help') {
    return [data.subject, data.message].filter(Boolean).join('\n\n');
  }
  if (data.type === 'feature') {
    return [data.title, data.description].filter(Boolean).join('\n\n');
  }
  return data.message || '';
}

/**
 * Unread counts per type. Admin/superadmin only.
 */
router.get('/support/counts', verifyAdmin, async (req, res) => {
  try {
    const types = ['help', 'feedback', 'feature'];
    const counts = { help: 0, feedback: 0, feature: 0, total: 0 };
    await Promise.all(types.map(async (t) => {
      const snap = await db.collection('support_requests')
        .where('type', '==', t)
        .where('read', '==', false)
        .get();
      counts[t] = snap.size;
    }));
    counts.total = counts.help + counts.feedback + counts.feature;
    res.json({ success: true, counts });
  } catch (e) {
    console.error('Support counts error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * List support requests by type. Admin/superadmin only.
 */
router.get('/support/:type', verifyAdmin, async (req, res) => {
  try {
    const type = SUPPORT_TYPES[req.params.type];
    if (!type) return res.status(400).json({ success: false, error: 'Invalid type' });

    const snap = await db.collection('support_requests')
      .where('type', '==', type)
      .get();

    const items = [];
    snap.forEach(d => {
      const data = d.data();
      items.push({
        id: d.id,
        uid: data.uid,
        name: data.name,
        email: data.email,
        type: data.type,
        subject: data.subject || null,
        message: data.message || null,
        title: data.title || null,
        description: data.description || null,
        read: !!data.read,
        replied: !!data.replied,
        reply: data.reply || null,
        createdAt: data.createdAt
      });
    });
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, requests: items });
  } catch (e) {
    console.error('List support error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * Mark a request as read. Admin/superadmin only.
 */
router.post('/support/:type/:id/read', verifyAdmin, async (req, res) => {
  try {
    const ref = db.collection('support_requests').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Not found' });
    await ref.update({
      read: true,
      readAt: new Date().toISOString(),
      readBy: req.user.email
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Mark read error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * Admin reply. Creates a notification for the request author.
 * Admin/superadmin only.
 */
router.post('/support/:type/:id/reply', verifyAdmin, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Reply text is required' });
    }
    const reqRef = db.collection('support_requests').doc(req.params.id);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) return res.status(404).json({ success: false, error: 'Request not found' });
    const data = reqSnap.data();

    const reply = {
      text: String(text).slice(0, 4000),
      adminName: req.user.name || req.user.email || 'Admin',
      adminUid: req.user.uid,
      repliedAt: new Date().toISOString()
    };

    await reqRef.update({
      reply,
      replied: true,
      read: true,
      readAt: new Date().toISOString()
    });

    // Create notification for the original requester.
    const notif = {
      uid: data.uid,
      type: 'admin_reply',
      supportRequestId: req.params.id,
      supportType: data.type,
      originalRequest: originalRequestSnapshot(data).slice(0, 2000),
      replyText: reply.text,
      adminName: reply.adminName,
      read: false,
      createdAt: new Date().toISOString()
    };
    const notifRef = await db.collection('notifications').add(notif);

    res.json({ success: true, reply, notificationId: notifRef.id });
  } catch (e) {
    console.error('Reply error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
