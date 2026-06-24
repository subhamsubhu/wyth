const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');

/**
 * Health check endpoint for cold start detection
 * Returns 200 OK when backend is ready
 */
router.get('/health', (req, res) => {
  res.status(200).json({ 
    success: true, 
    status: 'healthy',
    timestamp: Date.now()
  });
});

/**
 * Public endpoint: latest active announcement
 */
router.get('/announcements/active', async (req, res) => {
  try {
    // Avoid composite index by not combining where + orderBy
    const snap = await db.collection('announcements')
      .where('active', '==', true)
      .limit(20)
      .get();
    if (snap.empty) return res.json({ success: true, announcement: null });
    let latest = null;
    snap.forEach(d => {
      const v = { id: d.id, ...d.data() };
      if (!latest || new Date(v.createdAt) > new Date(latest.createdAt)) latest = v;
    });
    res.json({ success: true, announcement: latest });
  } catch (error) {
    console.error('Active announcement error:', error.message);
    res.json({ success: true, announcement: null });
  }
});

/**
 * Public endpoint: privacy policy (static, no data stored or shared, calls E2E encrypted)
 */
router.get('/privacy-policy', (req, res) => {
  res.json({
    success: true,
    policy: {
      title: 'Privacy Policy',
      lastUpdated: '2026-05-11',
      sections: [
        {
          heading: 'Our Commitment',
          body: 'WYTH is built around a single principle: your privacy is non-negotiable. We do not store, sell, share, analyze, or otherwise monetize any personal data, conversations, voice/video calls, or viewing activity. Period.'
        },
        {
          heading: 'What We Do NOT Collect',
          body: 'We do not collect, save, or log: your watch history, the videos you upload or stream, your chat messages (beyond what is required to deliver them to the room in real time), your voice or video calls, your IP address for analytics, your device identifiers, or any behavioural / usage statistics. There are no third-party trackers, no advertising SDKs, no analytics platforms embedded in this app.'
        },
        {
          heading: 'End-to-End Encrypted Communication',
          body: 'All voice and video calls use WebRTC peer-to-peer encryption (DTLS-SRTP). Calls travel directly between participants and never pass through our servers — meaning we literally cannot see, hear, or record them, even if we wanted to. Chat messages are encrypted with AES-256-GCM before being stored ephemerally for in-room delivery, and are not exposed to any third party.'
        },
        {
          heading: 'What We Store, and Why',
          body: 'The bare minimum needed to make the service work: (1) your account email and a hashed password (via Firebase Authentication) so you can log in; (2) the rooms you create, until you delete them; (3) the file you optionally upload, only on the server you choose, until you replace or delete it. That is the complete list. Nothing else.'
        },
        {
          heading: 'No Third-Party Sharing',
          body: 'We do not sell, rent, lease, share, license, transfer, or disclose your data to any third party for any purpose, ever. There is no business model that depends on your data. We are funded by the operator of this instance, not by advertising or data brokerage.'
        },
        {
          heading: 'Your Rights',
          body: 'You may delete your account, your rooms, and your uploads at any time. Deletion is immediate and irreversible. Because we hold no analytics or backups of your content, once it is deleted it is gone everywhere.'
        },
        {
          heading: 'Cookies',
          body: 'We use a single first-party session cookie issued by Firebase Authentication to keep you logged in. We use zero tracking, marketing, advertising, or analytics cookies.'
        },
        {
          heading: 'Children',
          body: 'WYTH is not directed to children under 13. If you believe a child has registered, contact the operator and the account will be removed.'
        },
        {
          heading: 'Changes',
          body: 'If this policy is ever updated, the lastUpdated date above will change. The core commitment — no data stored, no data shared, calls end-to-end encrypted — will never change.'
        },
        {
          heading: 'Contact',
          body: 'Questions? Reach the operator of this WYTH instance directly.'
        }
      ]
    }
  });
});

module.exports = router;
