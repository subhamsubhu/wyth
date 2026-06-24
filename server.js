const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ─────────────────────────────────────────────────────────────────────────────
// Fail fast if required secrets are missing or insecure. This MUST run before
// any module that touches Firebase / encryption is loaded.
// ─────────────────────────────────────────────────────────────────────────────
(function validateEnv() {
  const errors = [];
  const isProd = process.env.NODE_ENV === 'production';

  const weak = new Set([
    'change_me_to_a_strong_random_secret',
    'change_me_to_a_32_byte_strong_encryption_key',
    'default_32_byte_key_change_this!',
    'secret', 'jwt_secret', 'changeme', 'change-me'
  ]);

  const jwt = process.env.JWT_SECRET;
  if (!jwt) errors.push('JWT_SECRET is missing.');
  else if (weak.has(jwt)) errors.push('JWT_SECRET is using a known weak/default value.');
  else if (jwt.length < 32) errors.push('JWT_SECRET must be at least 32 characters (64 hex chars recommended).');

  const enc = process.env.ENCRYPTION_KEY;
  if (!enc) errors.push('ENCRYPTION_KEY is missing.');
  else if (weak.has(enc)) errors.push('ENCRYPTION_KEY is using a known weak/default value.');
  else if (enc.length < 32) errors.push('ENCRYPTION_KEY must be at least 32 characters (64 hex chars recommended).');

  const hasIndividual =
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY;
  const hasJsonBlob = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!hasIndividual && !hasJsonBlob) {
    errors.push(
      'Firebase credentials missing — set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL ' +
      'and FIREBASE_PRIVATE_KEY (or FIREBASE_SERVICE_ACCOUNT_JSON) in backend/.env.'
    );
  }

  const corsRaw = (process.env.CORS_ORIGIN || process.env.ALLOWED_ORIGINS || '').trim();
  if (isProd) {
    if (!corsRaw) {
      errors.push('CORS_ORIGIN is required in production — list your trusted frontend origins, comma-separated.');
    } else if (corsRaw.split(',').map((s) => s.trim()).includes('*')) {
      errors.push('CORS_ORIGIN="*" is not allowed in production. Set explicit origins instead.');
    }
  }

  if (errors.length) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ Startup aborted — fix the following before starting the server:');
    for (const e of errors) console.error('   • ' + e);
    console.error('   See backend/.env.example for the expected values.');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(1);
  }
})();

// Import middleware
const { verifySocketAuth, verifyAuth } = require('./middleware/auth');
const { auth } = require('./config/firebase');
const { migrateLegacyAdmins } = require('./utils/roleMigration');
const {
  ALLOWED_ORIGINS,
  corsOptions,
  socketCorsOptions,
  globalLimiter,
  authLimiter,
  passwordLimiter,
  otpLimiter,
  uploadLimiter,
  adminWriteLimiter,
  sanitizeJsonResponses,
  errorHandler,
  securityHeadersMiddleware,
} = require('./middleware/security');

// Import socket handlers
const handleRoomSocket = require('./sockets/roomSocket');
const handleChatSocket = require('./sockets/chatSocket');
const handleVideoSocket = require('./sockets/videoSocket');
const handleWebRTCSocket = require('./sockets/webrtcSocket');

// Import routes
const roomRoutes = require('./routes/rooms');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const youtubeRoutes = require('./routes/youtube');
const authTrackingRoutes = require('./routes/authTracking');
const { router: profileRoutes, avatarDir } = require('./routes/profile');
const supportRoutes = require('./routes/support');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with strict CORS allow-list (no wildcards in prod).
// Security Fix #13: Add maxHttpBufferSize to limit socket payload size
const io = new Server(server, {
  cors: socketCorsOptions,
  path: '/api/socket.io',
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6, // 1MB limit for socket payloads
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Security headers
// Security Fix #15: Enable Content Security Policy with proper configuration
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'", // Required for React inline scripts
        "'unsafe-eval'", // Required for React development
        "https://www.youtube.com",
        "https://www.google.com",
        "https://player.vimeo.com",
        "https://cdn.jsdelivr.net",
        "*.firebaseapp.com",
        "*.googleapis.com"
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'", // Required for styled components and inline styles
        "https://fonts.googleapis.com"
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com",
        "data:"
      ],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https:",
        "*.googleusercontent.com",
        "*.firebasestorage.app",
        "*.googleapis.com"
      ],
      mediaSrc: [
        "'self'",
        "blob:",
        "https:",
        "data:"
      ],
      connectSrc: [
        "'self'",
        "https:",
        "wss:",
        "*.firebaseio.com",
        "*.googleapis.com",
        "*.firebaseapp.com",
        "*.cloudfunctions.net"
      ],
      frameSrc: [
        "'self'",
        "https://www.youtube.com",
        "https://www.youtube-nocookie.com",
        "https://player.vimeo.com"
      ],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'unsafe-none' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Enhanced security headers (HSTS, X-Frame-Options, etc.)
app.use(securityHeadersMiddleware);

// CORS — explicit allow-list, no "*" in production
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Body parsers. Limits guard against oversized JSON / form payloads
// (multipart upload limits are configured on the multer instances).
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.URLENCODED_BODY_LIMIT || '1mb' }));

// Strip leaky error details from any JSON response before it leaves the server.
app.use(sanitizeJsonResponses);

// Rate limiting - trust proxy for K8s ingress
app.set('trust proxy', 1);

// Tiered limiters: stricter ones MUST come BEFORE the global one so they win.
app.use('/api/admin/admins/change-password', passwordLimiter);
app.use('/api/admin/users/:uid/password', passwordLimiter);
app.use('/api/profile/password', passwordLimiter);

// OTP / verification code endpoints (mounted defensively in case routes add them later).
app.use('/api/auth/otp', otpLimiter);
app.use('/api/auth/verify-otp', otpLimiter);

// Authentication-sensitive endpoints (login/register/token refresh) — Firebase is
// client-side here, but admin create/seed is a privileged auth-style op.
app.use('/api/admin/admins', authLimiter);

// Admin write operations.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/admin/') && req.method !== 'GET') {
    return adminWriteLimiter(req, res, next);
  }
  next();
});

// Upload endpoints.
app.use('/api/upload', uploadLimiter);
app.use('/api/profile/avatar', uploadLimiter);

// Global limiter for everything else under /api/.
app.use('/api/', globalLimiter);

// Root-level health check (used by the K8s ingress readiness probe)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'WYTH Backend',
  });
});

// Expose io on app so routes can emit
app.set('io', io);

// API Routes
app.use('/api/auth', authTrackingRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api', publicRoutes);

// Serve avatars publicly
app.use('/api/avatars', express.static(avatarDir));

// File upload endpoint (fallback for Firebase Storage issues)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB (kept per user preference)
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  },
});

app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Always derive public URL from the request (respecting K8s ingress forwarded headers)
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  const fileUrl = `${proto}://${host}/api/videos/${req.file.filename}`;
  res.json({ success: true, url: fileUrl, filename: req.file.filename });
});

// Serve uploaded videos
app.use('/api/videos', express.static(uploadDir));

// Serve downloadable code zips
app.use('/api/downloads', express.static(path.join(__dirname, 'public_downloads')));

// Socket.IO authentication — strict in production, dev-only anonymous fallback.
io.use(verifySocketAuth);

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('New socket connection:', socket.user.name);

  // Register all socket handlers
  handleRoomSocket(io, socket);
  handleChatSocket(io, socket);
  handleVideoSocket(io, socket);
  handleWebRTCSocket(io, socket);

  // Error handler
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

// Final error-handling middleware — strips stack traces / internal details.
app.use(errorHandler);

// Seed admin user once at startup (idempotent)
async function seedAdmin() {
  // ─────────────────────────────────────────────────────────────────────
  // SECURITY: the previous implementation read SEED_ADMIN_EMAIL +
  // SEED_ADMIN_PASSWORD from .env and reset the admin's Firebase password
  // on every boot. That is a hardcoded credential surface and silently
  // undoes manual password rotations. It has been REMOVED.
  //
  // The new system is purely role-based — see utils/roleMigration.js.
  // ─────────────────────────────────────────────────────────────────────
  return;
}

// Start server
const PORT = process.env.PORT || 8001;
server.listen(PORT, '0.0.0.0', async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎬 WYTH Backend Server');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔌 Socket.IO ready for connections`);
  console.log(`🔥 Firebase initialized`);
  console.log(`👑 Auth model: role-based (Firebase custom claims + users/{uid}.role)`);
  console.log(`🛡️  CORS allow-list: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : '(dev defaults: localhost + emergent preview)'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  await seedAdmin();
  try {
    await migrateLegacyAdmins();
  } catch (err) {
    console.error('Role migration failed (will retry on next boot):', err.message);
  }
});

module.exports = { app, server, io };
