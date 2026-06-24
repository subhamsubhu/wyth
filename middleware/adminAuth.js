/**
 * Role-based admin authorization.
 *
 * Source of truth (in order):
 *   1. Firebase Auth custom claim `role` on the ID token.
 *   2. Firestore `users/{uid}.role` document (fallback for tokens that
 *      haven't picked up new claims yet, or for legacy users).
 *
 * Roles:
 *   - "user"        regular member, no admin powers
 *   - "admin"       can run the admin console (users, rooms, announcements)
 *   - "superadmin"  everything admin can do PLUS manage other admins
 *                   (create / revoke / change password / promote / demote)
 *
 * There are NO hardcoded admin emails. There is NO seeded admin login.
 * The legacy email allow-list is consulted ONCE at boot by the migration
 * job in `utils/roleMigration.js`, then never read again at request time.
 */

const { auth, db } = require('../config/firebase');

const ROLES = Object.freeze({
  USER: 'user',
  ADMIN: 'admin',
  SUPERADMIN: 'superadmin'
});

const ADMIN_ROLES = new Set([ROLES.ADMIN, ROLES.SUPERADMIN]);

/**
 * Resolve the effective role of a verified Firebase user.
 * Order:
 *   1. Custom claim on the ID token (decoded.role).
 *   2. Firestore `users/{uid}.role`.
 *   3. Default "user".
 *
 * @param {{uid: string, role?: string}} decoded - decoded ID token
 * @returns {Promise<string>}
 */
async function resolveRole(decoded) {
  if (decoded.role && typeof decoded.role === 'string') {
    return decoded.role.toLowerCase();
  }
  try {
    const snap = await db.collection('users').doc(decoded.uid).get();
    if (snap.exists) {
      const r = (snap.data().role || '').toString().toLowerCase();
      if (r) return r;
    }
  } catch (err) {
    console.error('resolveRole: firestore lookup failed:', err.message);
  }
  return ROLES.USER;
}

function isAdminRole(role) {
  return ADMIN_ROLES.has((role || '').toLowerCase());
}

function isSuperadminRole(role) {
  return (role || '').toLowerCase() === ROLES.SUPERADMIN;
}

/**
 * Verify a bearer token, then require the user to be admin or superadmin.
 * Attaches `req.user = { uid, email, name, role, isSuperAdmin }`.
 */
async function verifyAdmin(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = header.split('Bearer ')[1];
    const decoded = await auth.verifyIdToken(token, true);
    const role = await resolveRole(decoded);
    if (!isAdminRole(role)) {
      return res.status(403).json({ error: 'Forbidden: admin only' });
    }
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name || decoded.email,
      role,
      isSuperAdmin: isSuperadminRole(role)
    };
    next();
  } catch (error) {
    console.error('Admin auth error:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Verify a bearer token, then require superadmin.
 * Used for any action that mutates the admin set itself.
 */
async function verifySuperAdmin(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = header.split('Bearer ')[1];
    const decoded = await auth.verifyIdToken(token, true);
    const role = await resolveRole(decoded);
    if (!isSuperadminRole(role)) {
      return res.status(403).json({ error: 'Forbidden: superadmin only' });
    }
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name || decoded.email,
      role,
      isSuperAdmin: true
    };
    next();
  } catch (error) {
    console.error('Superadmin auth error:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Resolve role for the request user without requiring admin.
 * Used by `/api/admin/me` so a regular user can ask "am I admin?"
 * without getting a 403.
 */
async function resolveRoleFromRequest(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.split('Bearer ')[1];
  const decoded = await auth.verifyIdToken(token, true);
  const role = await resolveRole(decoded);
  return { uid: decoded.uid, email: decoded.email, role };
}

module.exports = {
  ROLES,
  verifyAdmin,
  verifySuperAdmin,
  resolveRole,
  resolveRoleFromRequest,
  isAdminRole,
  isSuperadminRole
};
