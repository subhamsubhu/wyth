const { auth } = require('../config/firebase');

const IS_PROD = process.env.NODE_ENV === 'production';

async function verifyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }

    const token = authHeader.split('Bearer ')[1];
    
    // Verify token and check expiration explicitly
    const decoded = await auth.verifyIdToken(token, true); // checkRevoked = true
    
    // Additional expiration check (Firebase already validates, but explicit is better)
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      return res.status(401).json({ 
        error: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
    }
    
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name || decoded.email?.split('@')[0] || 'User'
    };
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    
    // Provide specific error codes for token issues
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ 
        error: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
    }
    if (error.code === 'auth/id-token-revoked') {
      return res.status(401).json({ 
        error: 'Token revoked',
        code: 'TOKEN_REVOKED'
      });
    }
    
    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
}

/**
 * Socket.IO auth middleware.
 *
 * Production:  every connection MUST present a valid Firebase ID token.
 *              Anonymous and invalid-token connections are rejected.
 * Development: if no token is supplied, we attach a clearly-labelled
 *              anonymous identity so local testing still works. An
 *              *invalid* token is always rejected, even in dev — that's
 *              a clear sign of tampering, not of "just testing".
 */
async function verifySocketAuth(socket, next) {
  const token = socket.handshake.auth && socket.handshake.auth.token;

  if (!token) {
    if (IS_PROD) {
      return next(new Error('Unauthorized: authentication token required'));
    }
    socket.user = {
      uid: `anon_${socket.id}`,
      name: 'Anonymous (dev)',
      email: '',
      anonymous: true
    };
    return next();
  }

  try {
    // Verify token with revocation check
    const decoded = await auth.verifyIdToken(token, true);
    
    // Check token expiration explicitly
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      return next(new Error('Token expired'));
    }
    
    socket.user = {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name || decoded.email?.split('@')[0] || 'User',
      anonymous: false
    };
    return next();
  } catch (error) {
    console.error('Socket auth error:', error.message);
    
    if (error.code === 'auth/id-token-expired') {
      return next(new Error('Token expired'));
    }
    if (error.code === 'auth/id-token-revoked') {
      return next(new Error('Token revoked'));
    }
    
    return next(new Error('Unauthorized: invalid token'));
  }
}

module.exports = { verifyAuth, verifySocketAuth };
