import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }
  // Key should be 32 bytes (256 bits) for AES-256
  // If provided as hex string (64 chars), convert to buffer
  if (key.length === 64) {
    return Buffer.from(key, 'hex');
  }
  // If provided as base64 (44 chars), convert to buffer
  if (key.length === 44) {
    return Buffer.from(key, 'base64');
  }
  throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars or 44 base64 chars)');
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedData: string): string {
  const key = getEncryptionKey();
  const parts = encryptedData.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const [ivHex, authTagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// Typed credential helpers for JSON credentials
export type PasswordCredentials = {
  type: 'password';
  email: string;
  password: string;
};

export type ApiKeyCredentials = {
  type: 'api_key';
  apiKey: string;
};

export type OAuthCredentials = {
  type: 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

export type Credentials = PasswordCredentials | ApiKeyCredentials | OAuthCredentials;

export function encryptCredentials(credentials: Credentials): string {
  return encrypt(JSON.stringify(credentials));
}

export function decryptCredentials(encryptedCredentials: string): Credentials {
  const decrypted = decrypt(encryptedCredentials);
  return JSON.parse(decrypted) as Credentials;
}

// Utility to generate a new encryption key (for setup)
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex');
}
