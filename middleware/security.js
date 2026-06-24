/**
 * security.js — production-safe CORS, rate limiting and error sanitisation.
 *
 * Addresses the four backend hardening items requested:
 *   5. CORS Wildcard Allowed              → strict origin allow-list
 *   6. Weak Rate Limiting                 → tiered limiters for sensitive endpoints
 *   7. Huge File Upload Limit             → (kept unchanged per user choice)
 *   8. Error Messages Leak Internal Details → category-based generic errors in prod
 *
 * All knobs come from environment variables so nothing has to be re-coded
 * for staging vs production:
 *
 *   NODE_ENV                  "production" enables strict mode
 *   CORS_ORIGIN               Comma-separated list of allowed origins, e.g.
 *                             "https://wyth.app,https://www.wyth.app"
 *                             ("*" is silently rejected in production)
 *   ALLOWED_ORIGINS           Alias of CORS_ORIGIN (either is fine)
 *
 *   RL_GLOBAL_MAX             default 200  per 15 min  (all /api/*)
 *   RL_AUTH_MAX               default 10   per 15 min  (login/register/OTP/admin auth ops)
 *   RL_PASSWORD_MAX           default 5    per 15 min  (password change/reset)
 *   RL_OTP_MAX                default 5    per 10 min  (one-time codes)
 *   RL_UPLOAD_MAX             default 30   per 15 min  (file & avatar uploads)
 *   RL_ADMIN_WRITE_MAX        default 30   per 15 min  (admin mutating ops)
 */

const rateLimit = require('express-rate-limit');

const IS_PROD = process.env.NODE_ENV === 'production';

// ─────────────────────────────────────────────────────────────────────────────
// CORS — strict allow-list, no wildcards in production
// ─────────────────────────────────────────────────────────────────────────────
function parseAllowedOrigins() {
  const raw = process.env.CORS_ORIGIN || process.env.ALLOWED_ORIGINS || '';
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const ALLOWED_ORIGINS = parseAllowedOrigins();

// Sensible dev defaults so local development keeps working out of the box.
const DEV_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const EMERGENT_PREVIEW_REGEX = /^https:\/\/[a-z0-9-]+\.preview\.emergentagent\.com$/i;

function isOriginAllowed(origin) {
  // Non-browser requests (curl, server-to-server, same-origin) have no Origin.
  if (!origin) return true;

  const cleaned = origin.replace(/\/$/, '');

  if (ALLOWED_ORIGINS.length > 0) {
    // Explicit allow-list wins. "*" is intentionally NOT honoured in production.
    if (ALLOWED_ORIGINS.includes('*')) {
      if (IS_PROD) return false;
      return true;
    }
    return ALLOWED_ORIGINS.includes(cleaned);
  }

  // No explicit list: allow localhost + Emergent preview hosts in non-production.
  if (!IS_PROD) {
    return DEV_ORIGIN_REGEX.test(cleaned) || EMERGENT_PREVIEW_REGEX.test(cleaned);
  }

  // Production with no list configured → deny everything cross-origin.
  return false;
}

function corsOriginFn(origin, callback) {
  if (isOriginAllowed(origin)) return callback(null, true);
  // Don't throw — that produces a 500. Just deny the CORS headers.
  return callback(null, false);
}

const corsOptions = {
  origin: corsOriginFn,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 600,
};

const socketCorsOptions = {
  origin: corsOriginFn,
  methods: ['GET', 'POST'],
  credentials: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiters — tiered to protect sensitive endpoints
// ─────────────────────────────────────────────────────────────────────────────
function envInt(name, def) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const limiterDefaults = {
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { success: false, error: 'Too many requests, please try again later.' },
};

const globalLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  max: envInt('RL_GLOBAL_MAX', 200),
});

// Login / register / token-exchange style endpoints. Brute-force protection.
const authLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  max: envInt('RL_AUTH_MAX', 10),
  message: { success: false, error: 'Too many authentication attempts, please wait and try again.' },
});

// ─────────────────────────────────────────────────────────────────────────────
// Enhanced Security Headers — HTTPS enforcement & additional protections
// Security Fix #17: Comprehensive security headers for production-grade protection
// ─────────────────────────────────────────────────────────────────────────────
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function securityHeadersMiddleware(req, res, next) {
  // HSTS - Force HTTPS for 1 year (31536000 seconds) with subdomains and preload
  if (IS_PRODUCTION) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // X-Content-Type-Options - Prevent MIME sniffing attacks
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // X-Frame-Options - Prevent clickjacking attacks
  res.setHeader('X-Frame-Options', 'DENY');

  // X-XSS-Protection - Enable browser XSS filter (legacy support for older browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer-Policy - Control referrer information leakage
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions-Policy - Restrict browser features to prevent abuse
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), speaker=()');
  
  // X-Download-Options - Prevent IE from executing downloads in site's context
  res.setHeader('X-Download-Options', 'noopen');
  
  // X-Permitted-Cross-Domain-Policies - Restrict Adobe Flash and PDF cross-domain requests
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  
  // X-DNS-Prefetch-Control - Control DNS prefetching
  res.setHeader('X-DNS-Prefetch-Control', 'off');

  next();
}

// Password change / reset (any flow that mutates a credential).
const passwordLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  max: envInt('RL_PASSWORD_MAX', 5),
  message: { success: false, error: 'Too many password change attempts, please wait and try again.' },
});

// OTP / one-time code endpoints.
const otpLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 10 * 60 * 1000,
  max: envInt('RL_OTP_MAX', 5),
  message: { success: false, error: 'Too many code requests, please wait before requesting another.' },
});

// File uploads (video, avatar). Lower than global since each request is heavy.
const uploadLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  max: envInt('RL_UPLOAD_MAX', 30),
  message: { success: false, error: 'Too many uploads, please wait a moment before trying again.' },
});

// Admin mutating endpoints (create/delete users, rooms, announcements, etc.).
const adminWriteLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  max: envInt('RL_ADMIN_WRITE_MAX', 30),
  message: { success: false, error: 'Too many admin operations, please slow down.' },
});

// ─────────────────────────────────────────────────────────────────────────────
// Error sanitisation — no stack traces / internal details leak to the client
// ─────────────────────────────────────────────────────────────────────────────
function categoryFromStatus(status) {
  if (status === 400 || status === 422) return 'Validation error';
  if (status === 401) return 'Authentication error';
  if (status === 403) return 'Authorization error';
  if (status === 404) return 'Not found';
  if (status === 409) return 'Conflict';
  if (status === 413) return 'Payload too large';
  if (status === 415) return 'Unsupported media type';
  if (status === 429) return 'Rate limit exceeded';
  if (status >= 500) return 'Server error';
  return 'Request error';
}

// Heuristic: does this string look like it leaks internals?
const LEAKY_PATTERNS = [
  /\bat\s+\S+\s+\(/,           // stack-trace frames "at fn (file:line)"
  /\/(?:app|usr|home|root)\//, // absolute filesystem paths
  /node_modules/i,
  /\bFIREBASE_/,
  /firebase-admin/i,
  /firestore/i,
  /\bAxios|MongoServerError|TypeError|RangeError|ReferenceError\b/,
  /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND/,
  /private[_-]?key/i,
];

function looksLeaky(msg) {
  if (typeof msg !== 'string') return false;
  // Long messages are suspicious by default in production.
  if (IS_PROD && msg.length > 200) return true;
  return LEAKY_PATTERNS.some((re) => re.test(msg));
}

function makeErrorId() {
  return (
    Math.random().toString(36).slice(2, 8) +
    Date.now().toString(36).slice(-4)
  );
}

// Express middleware that wraps res.json to strip leaky error payloads.
function sanitizeJsonResponses(req, res, next) {
  const original = res.json.bind(res);
  res.json = function patched(body) {
    try {
      const status = res.statusCode;
      if (status >= 400 && body && typeof body === 'object') {
        const errMsg = body.error || body.message;
        if (errMsg) {
          const category = categoryFromStatus(status);
          const leaky = looksLeaky(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
          const force = IS_PROD && status >= 500; // always sanitise 5xx in prod

          if (force || leaky) {
            const errorId = makeErrorId();
            // Keep the original message in server logs.
            console.error(
              `[err ${errorId}] ${req.method} ${req.originalUrl} → ${status}: ${
                typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)
              }`
            );
            body = {
              success: false,
              error: category,
              errorId,
            };
          }
        }
      }
    } catch (e) {
      // Never let sanitisation itself break the response.
    }
    return original(body);
  };
  next();
}

// Final error-handling middleware. Must be last in the chain.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || err.statusCode || 500;
  const errorId = makeErrorId();
  console.error(`[err ${errorId}] ${req.method} ${req.originalUrl} →`, err);

  if (res.headersSent) return; // delegate to default handler

  const category = categoryFromStatus(status);
  // In non-production we expose the original message to make debugging easy.
  const payload = {
    success: false,
    error: IS_PROD ? category : (err.message || category),
    errorId,
  };
  res.status(status).json(payload);
}

module.exports = {
  ALLOWED_ORIGINS,
  corsOptions,
  socketCorsOptions,
  isOriginAllowed,
  globalLimiter,
  authLimiter,
  passwordLimiter,
  otpLimiter,
  uploadLimiter,
  adminWriteLimiter,
  sanitizeJsonResponses,
  errorHandler,
  securityHeadersMiddleware,
};
