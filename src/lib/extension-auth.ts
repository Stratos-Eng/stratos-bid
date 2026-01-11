/**
 * Extension authentication utilities using proper JWT
 */
import jwt from 'jsonwebtoken';

const EXTENSION_TOKEN_SECRET = process.env.EXTENSION_TOKEN_SECRET;

// Use a fallback for development only - warn if missing in production
const SECRET = EXTENSION_TOKEN_SECRET || 'dev-secret-do-not-use-in-production';

if (!EXTENSION_TOKEN_SECRET && process.env.NODE_ENV === 'production') {
  console.error('WARNING: EXTENSION_TOKEN_SECRET not set in production!');
}

// Token expires in 90 days
const TOKEN_EXPIRY = '90d';

export interface ExtensionTokenPayload {
  userId: string;
  email: string;
  type: 'extension';
}

/**
 * Generate a signed JWT for the browser extension
 */
export function generateExtensionToken(userId: string, email: string): {
  token: string;
  expiresAt: Date;
} {
  const payload: ExtensionTokenPayload = {
    userId,
    email,
    type: 'extension',
  };

  const token = jwt.sign(payload, SECRET, {
    expiresIn: TOKEN_EXPIRY,
    issuer: 'stratos-app',
    audience: 'stratos-extension',
  });

  // Calculate expiration date (90 days from now)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90);

  return { token, expiresAt };
}

/**
 * Verify an extension token and return the user ID
 * Returns null if token is invalid or expired
 */
export function verifyExtensionToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, SECRET, {
      issuer: 'stratos-app',
      audience: 'stratos-extension',
    }) as ExtensionTokenPayload;

    // Verify it's an extension token
    if (decoded.type !== 'extension') {
      return null;
    }

    return decoded.userId;
  } catch (error) {
    // Token is invalid, expired, or tampered with
    if (error instanceof jwt.TokenExpiredError) {
      console.log('Extension token expired');
    } else if (error instanceof jwt.JsonWebTokenError) {
      console.log('Invalid extension token:', error.message);
    }
    return null;
  }
}

/**
 * Decode token without verification (for debugging only)
 */
export function decodeExtensionToken(token: string): ExtensionTokenPayload | null {
  try {
    const decoded = jwt.decode(token) as ExtensionTokenPayload;
    return decoded;
  } catch {
    return null;
  }
}
