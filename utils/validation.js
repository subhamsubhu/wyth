/**
 * validation.js — Input validation and sanitization utilities
 * 
 * Addresses security issue #16: Insufficient Input Validation
 * 
 * Provides validation and sanitization for:
 * - Room names
 * - Usernames / display names
 * - Bios / descriptions
 * - Chat messages
 * - URLs (video links, external links)
 * - General text inputs
 */

const validator = require('validator');

/**
 * Sanitize text by escaping HTML entities and removing dangerous characters
 */
function sanitizeText(text, maxLength = 1000) {
  if (!text || typeof text !== 'string') return '';
  
  // Trim whitespace
  let clean = text.trim();
  
  // Limit length
  if (maxLength && clean.length > maxLength) {
    clean = clean.slice(0, maxLength);
  }
  
  // Escape HTML entities to prevent XSS
  clean = validator.escape(clean);
  
  // Remove null bytes and other control characters
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  
  return clean;
}

/**
 * Validate and sanitize room name
 * Rules: 1-100 chars, alphanumeric with spaces, hyphens, underscores
 */
function validateRoomName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Room name is required', sanitized: '' };
  }
  
  const trimmed = name.trim();
  
  if (trimmed.length < 1) {
    return { valid: false, error: 'Room name cannot be empty', sanitized: '' };
  }
  
  if (trimmed.length > 100) {
    return { valid: false, error: 'Room name must be 100 characters or less', sanitized: '' };
  }
  
  // Allow alphanumeric, spaces, hyphens, underscores, and basic punctuation
  const validPattern = /^[a-zA-Z0-9\s\-_.,!?']+$/;
  if (!validPattern.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Room name contains invalid characters. Use letters, numbers, spaces, and basic punctuation only.', 
      sanitized: '' 
    };
  }
  
  // Sanitize for safety
  const sanitized = sanitizeText(trimmed, 100);
  
  return { valid: true, error: null, sanitized };
}

/**
 * Validate and sanitize username/display name
 * Rules: 1-50 chars, alphanumeric with spaces and basic characters
 */
function validateUsername(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Username is required', sanitized: '' };
  }
  
  const trimmed = name.trim();
  
  if (trimmed.length < 1) {
    return { valid: false, error: 'Username cannot be empty', sanitized: '' };
  }
  
  if (trimmed.length > 50) {
    return { valid: false, error: 'Username must be 50 characters or less', sanitized: '' };
  }
  
  // Allow alphanumeric, spaces, and common name characters
  const validPattern = /^[a-zA-Z0-9\s\-_.]+$/;
  if (!validPattern.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Username contains invalid characters. Use letters, numbers, spaces, hyphens, underscores, and periods only.', 
      sanitized: '' 
    };
  }
  
  const sanitized = sanitizeText(trimmed, 50);
  
  return { valid: true, error: null, sanitized };
}

/**
 * Validate and sanitize bio/description
 * Rules: 0-500 chars, allow more characters but sanitize
 */
function validateBio(bio) {
  if (!bio) {
    return { valid: true, error: null, sanitized: '' };
  }
  
  if (typeof bio !== 'string') {
    return { valid: false, error: 'Bio must be text', sanitized: '' };
  }
  
  const trimmed = bio.trim();
  
  if (trimmed.length > 500) {
    return { valid: false, error: 'Bio must be 500 characters or less', sanitized: '' };
  }
  
  // Sanitize but allow most characters for bio
  const sanitized = sanitizeText(trimmed, 500);
  
  return { valid: true, error: null, sanitized };
}

/**
 * Validate and sanitize chat message
 * Rules: 1-2000 chars, sanitize for XSS
 */
function validateChatMessage(message) {
  if (!message || typeof message !== 'string') {
    return { valid: false, error: 'Message cannot be empty', sanitized: '' };
  }
  
  const trimmed = message.trim();
  
  if (trimmed.length < 1) {
    return { valid: false, error: 'Message cannot be empty', sanitized: '' };
  }
  
  if (trimmed.length > 2000) {
    return { valid: false, error: 'Message must be 2000 characters or less', sanitized: '' };
  }
  
  // Sanitize to prevent XSS
  const sanitized = sanitizeText(trimmed, 2000);
  
  return { valid: true, error: null, sanitized };
}

/**
 * Validate URL (for video links, external links)
 * Rules: Must be valid HTTP/HTTPS URL, optionally check against allowed domains
 */
function validateUrl(url, allowedDomains = null) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required', sanitized: '' };
  }
  
  const trimmed = url.trim();
  
  // Check if it's a valid URL
  if (!validator.isURL(trimmed, { 
    protocols: ['http', 'https'],
    require_protocol: true 
  })) {
    return { valid: false, error: 'Invalid URL format. Must be a valid HTTP or HTTPS URL.', sanitized: '' };
  }
  
  // Additional check for allowed domains if specified
  if (allowedDomains && Array.isArray(allowedDomains) && allowedDomains.length > 0) {
    try {
      const urlObj = new URL(trimmed);
      const hostname = urlObj.hostname.toLowerCase();
      
      const isAllowed = allowedDomains.some(domain => {
        const domainLower = domain.toLowerCase();
        return hostname === domainLower || hostname.endsWith('.' + domainLower);
      });
      
      if (!isAllowed) {
        return { 
          valid: false, 
          error: `URL must be from allowed domains: ${allowedDomains.join(', ')}`, 
          sanitized: '' 
        };
      }
    } catch (e) {
      return { valid: false, error: 'Invalid URL format', sanitized: '' };
    }
  }
  
  // Check URL length
  if (trimmed.length > 2048) {
    return { valid: false, error: 'URL is too long (max 2048 characters)', sanitized: '' };
  }
  
  return { valid: true, error: null, sanitized: trimmed };
}

/**
 * Validate video URL (YouTube, Vimeo, direct video links)
 */
function validateVideoUrl(url) {
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    return urlValidation;
  }
  
  const trimmed = url.trim();
  
  try {
    const urlObj = new URL(trimmed);
    const hostname = urlObj.hostname.toLowerCase();
    
    // Check for supported video platforms
    const supportedDomains = [
      'youtube.com',
      'youtu.be',
      'vimeo.com',
      'dailymotion.com',
      'twitch.tv',
      'drive.google.com',
      'docs.google.com',
      'googleusercontent.com',
      'googleapis.com'
    ];
    
    const isVideoHost = supportedDomains.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
    
    // If it's a known video host, allow it
    if (isVideoHost) {
      return { valid: true, error: null, sanitized: trimmed };
    }
    
    // For direct video URLs, check if it ends with common video extensions
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.m3u8'];
    const pathname = urlObj.pathname.toLowerCase();
    const hasVideoExtension = videoExtensions.some(ext => pathname.endsWith(ext));
    
    if (hasVideoExtension) {
      return { valid: true, error: null, sanitized: trimmed };
    }
    
    // Allow any URL but warn it might not be a video
    return { valid: true, error: null, sanitized: trimmed };
    
  } catch (e) {
    return { valid: false, error: 'Invalid video URL', sanitized: '' };
  }
}

/**
 * Validate email address
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email is required', sanitized: '' };
  }
  
  const trimmed = email.trim().toLowerCase();
  
  if (!validator.isEmail(trimmed)) {
    return { valid: false, error: 'Invalid email address', sanitized: '' };
  }
  
  return { valid: true, error: null, sanitized: trimmed };
}

/**
 * Validate socket payload size
 */
function validatePayloadSize(data, maxSizeBytes = 1048576) { // 1MB default
  if (!data) return { valid: true, error: null };
  
  const size = JSON.stringify(data).length;
  
  if (size > maxSizeBytes) {
    return { 
      valid: false, 
      error: `Payload too large: ${Math.round(size/1024)}KB exceeds limit of ${Math.round(maxSizeBytes/1024)}KB` 
    };
  }
  
  return { valid: true, error: null };
}

module.exports = {
  sanitizeText,
  validateRoomName,
  validateUsername,
  validateBio,
  validateChatMessage,
  validateUrl,
  validateVideoUrl,
  validateEmail,
  validatePayloadSize
};
