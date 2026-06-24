/**
 * User-facing support & notification routes.
 *
 * Collections:
 *   support_requests/{id} = {
 *     uid, name, email,                   // attached server-side from token
 *     type: 'help' | 'feedback' | 'feature',
 *     subject?, message?, title?, description?,
 *     read: bool, replied: bool,
 *     reply?: { text, adminName, repliedAt },
 *     createdAt
 *   }
 *
 *   notifications/{id} = {
 *     uid,                                 // owner (recipient)
 *     type: 'admin_reply',
 *     supportRequestId, supportType,
 *     originalRequest,                     // snapshotted user message
 *     replyText, adminName,
 *     read: bool,
 *     createdAt
 *   }
 *
 * SECURITY: users can only see/modify rows where uid === req.user.uid.
 *           admins (via /api/admin/support/*) can see all.
 */

const express = require('express');
const router = express.Router();
const { db, auth } = require('../config/firebase');
const { verifyAuth } = require('../middleware/auth');

const TYPES = new Set(['help', 'feedback', 'feature']);

/** Resolve display name from the verified token + Firebase user record. */
async function resolveIdentity(req) {
  const t = req.user || {};
  let name = t.name || t.displayName || null;
  if (!name) {
    try {
      const u = await auth.getUser(t.uid);
      name = u.displayName || (u.email || '').split('@')[0] || 'User';
    } catch (e) {
      name = (t.email || '').split('@')[0] || 'User';
    }
  }
  return { uid: t.uid, email: t.email, name };
}

/* ───────────────────────── Help request ───────────────────────── */

router.post('/help', verifyAuth, async (req, res) => {
  try {
    const { subject, message } = req.body || {};
    if (!subject || !subject.trim() || !message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Subject and message are required' });
    }
    const id = await createRequest(req, 'help', {
      subject: String(subject).slice(0, 200),
      message: String(message).slice(0, 4000)
    });
    res.json({ success: true, id });
  } catch (e) {
    console.error('Create help error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ───────────────────────── Feedback ───────────────────────── */

router.post('/feedback', verifyAuth, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Feedback message is required' });
    }
    const id = await createRequest(req, 'feedback', {
      message: String(message).slice(0, 4000)
    });
    res.json({ success: true, id });
  } catch (e) {
    console.error('Create feedback error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ───────────────────────── Feature suggestion ───────────────────────── */

router.post('/feature', verifyAuth, async (req, res) => {
  try {
    const { title, description } = req.body || {};
    if (!title || !title.trim() || !description || !description.trim()) {
      return res.status(400).json({ success: false, error: 'Title and description are required' });
    }
    const id = await createRequest(req, 'feature', {
      title: String(title).slice(0, 200),
      description: String(description).slice(0, 4000)
    });
    res.json({ success: true, id });
  } catch (e) {
    console.error('Create feature error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

async function createRequest(req, type, payload) {
  if (!TYPES.has(type)) throw new Error('Invalid type');
  const { uid, email, name } = await resolveIdentity(req);
  const doc = {
    uid,
    email: (email || '').toLowerCase(),
    name,
    type,
    read: false,
    replied: false,
    ...payload,
    createdAt: new Date().toISOString()
  };
  const ref = await db.collection('support_requests').add(doc);
  return ref.id;
}

/* ───────────────────────── Notifications (user-side) ───────────────────────── */

/**
 * List notifications belonging to the requesting user.
 * Returns only the fields the UI needs — no read/unread labels are exposed
 * beyond the boolean (the client uses it to show/hide the badge, but the
 * card itself doesn't render a "read/unread" label).
 */
router.get('/notifications', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const snap = await db.collection('notifications')
      .where('uid', '==', uid)
      .get();
    const items = [];
    snap.forEach(d => {
      const data = d.data();
      items.push({
        id: d.id,
        type: data.type,
        originalRequest: data.originalRequest || '',
        replyText: data.replyText || '',
        adminName: data.adminName || 'WYTH Team',
        createdAt: data.createdAt,
        read: !!data.read
      });
    });
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const unreadCount = items.filter(n => !n.read).length;
    res.json({ success: true, notifications: items, unreadCount });
  } catch (e) {
    console.error('List notifications error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/notifications/:id/read', verifyAuth, async (req, res) => {
  try {
    const doc = await db.collection('notifications').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    if (doc.data().uid !== req.user.uid) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    await doc.ref.update({ read: true, readAt: new Date().toISOString() });
    res.json({ success: true });
  } catch (e) {
    console.error('Mark notification read error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/notifications/:id', verifyAuth, async (req, res) => {
  try {
    const doc = await db.collection('notifications').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Not found' });
    if (doc.data().uid !== req.user.uid) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    await doc.ref.delete();
    res.json({ success: true });
  } catch (e) {
    console.error('Delete notification error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
