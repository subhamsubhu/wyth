/**
 * One-shot, idempotent migration from the legacy seeded/email-list admin
 * model to the new role-based model.
 *
 * Inputs consulted ONCE at boot:
 *   - Legacy `admins` Firestore collection (created by the old code).
 *   - `ADMIN_EMAILS` env var (legacy allow-list, comma-separated) — optional.
 *   - `SUPERADMIN_BOOTSTRAP_EMAIL` env var — guarantees a superadmin exists.
 *
 * What it does:
 *   - For every legacy admin email that maps to a real Firebase user:
 *       * write `users/{uid} = { email, role: 'admin' | 'superadmin', ... }`
 *       * set Firebase Auth custom claim `{ role }`
 *   - The bootstrap superadmin email (or `admin@wyth.app` if unset) is
 *     promoted to `superadmin`. All other legacy admins become `admin`.
 *   - If, after migration, the system still has zero superadmins, the
 *     bootstrap email is promoted unconditionally (provided the user exists).
 *
 * Idempotency: a flag doc `_meta/role_migration` is written when complete,
 * so re-running on subsequent boots is a no-op. The boot bootstrap check
 * still runs every boot — by design — so the system can never end up with
 * zero superadmins.
 *
 * Nothing here creates users, sets passwords, or stores credentials.
 */

const { auth, db } = require('../config/firebase');
const { ROLES } = require('../middleware/adminAuth');

const MIGRATION_DOC = '_meta/role_migration';

function legacyEnvAdmins() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

function bootstrapSuperadminEmail() {
  const v = (process.env.SUPERADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
  return v || 'admin@wyth.app';
}

async function setUserRole(uid, email, role, source) {
  // 1. Firestore users/{uid}
  await db.collection('users').doc(uid).set({
    uid,
    email: email.toLowerCase(),
    role,
    updatedAt: new Date().toISOString(),
    updatedBy: `migration:${source}`
  }, { merge: true });

  // 2. Firebase Auth custom claim
  try {
    const existing = (await auth.getUser(uid)).customClaims || {};
    if (existing.role !== role) {
      await auth.setCustomUserClaims(uid, { ...existing, role });
    }
  } catch (err) {
    console.error(`setUserRole: claim update failed for ${email}:`, err.message);
  }
}

async function migrateLegacyAdmins() {
  const migrationRef = db.doc(MIGRATION_DOC);
  let migrationDone = false;
  try {
    const snap = await migrationRef.get();
    migrationDone = snap.exists && !!snap.data().completedAt;
  } catch (e) { /* ignore */ }

  const bootstrap = bootstrapSuperadminEmail();

  if (!migrationDone) {
    console.log('🔁 Running one-shot role migration from legacy admin sources…');

    // Collect candidate legacy admin emails (lowercased, deduped).
    const candidates = new Set(legacyEnvAdmins());
    try {
      const snap = await db.collection('admins').get();
      snap.forEach(d => {
        const e = (d.data().email || d.id || '').toString().toLowerCase();
        if (e) candidates.add(e);
      });
    } catch (err) {
      console.error('  • could not read legacy admins collection:', err.message);
    }

    let promoted = 0, skipped = 0;
    for (const email of candidates) {
      try {
        const user = await auth.getUserByEmail(email);
        const role = email === bootstrap ? ROLES.SUPERADMIN : ROLES.ADMIN;
        await setUserRole(user.uid, email, role, 'legacy');
        console.log(`  • ${email} → ${role}`);
        promoted++;
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          console.log(`  • ${email} → skipped (no Firebase user)`);
        } else {
          console.error(`  • ${email} → error:`, err.message);
        }
        skipped++;
      }
    }

    await migrationRef.set({
      completedAt: new Date().toISOString(),
      promoted,
      skipped,
      bootstrapSuperadmin: bootstrap
    });
    console.log(`✅ Role migration complete (${promoted} promoted, ${skipped} skipped).`);
  }

  // Boot-time bootstrap safety net — runs every boot.
  await ensureSuperadminExists(bootstrap);
}

async function ensureSuperadminExists(bootstrapEmail) {
  try {
    const snap = await db.collection('users')
      .where('role', '==', ROLES.SUPERADMIN)
      .limit(1)
      .get();
    if (!snap.empty) return;

    console.log(`⚠️  No superadmin found — bootstrapping ${bootstrapEmail}…`);
    try {
      const user = await auth.getUserByEmail(bootstrapEmail);
      await setUserRole(user.uid, bootstrapEmail, ROLES.SUPERADMIN, 'bootstrap');
      console.log(`✅ Bootstrapped superadmin: ${bootstrapEmail}`);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        console.error(
          `❌ SUPERADMIN_BOOTSTRAP_EMAIL (${bootstrapEmail}) does not exist in Firebase Auth. ` +
          `Create the user first via the standard sign-up flow, then restart.`
        );
      } else {
        console.error('ensureSuperadminExists error:', err.message);
      }
    }
  } catch (err) {
    console.error('ensureSuperadminExists query failed:', err.message);
  }
}

module.exports = { migrateLegacyAdmins, setUserRole };
