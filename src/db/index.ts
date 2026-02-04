import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';
import { validateEnv } from '@/lib/env-validation';

// Validate environment once on first import (not per-request)
const _envValidated = globalThis as unknown as { __envValidated?: boolean };
if (typeof window === 'undefined' && !_envValidated.__envValidated) {
  _envValidated.__envValidated = true;
  const result = validateEnv();

  for (const warning of result.warnings) {
    console.warn(`[ENV] ${warning}`);
  }

  for (const error of result.errors) {
    console.error(`[ENV ERROR] ${error}`);
  }
}

// IMPORTANT:
// Next.js may evaluate server modules during `next build`.
// In Docker builds (DigitalOcean App Platform), runtime env vars like DATABASE_URL
// are not always available to the *build stage*.
//
// So we lazily create the DB client and only throw when it is actually used.
let _db: ReturnType<typeof drizzle> | null = null;

function getDb() {
  if (_db) return _db;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (required at runtime to use the database)');
  }
  const sql = neon(process.env.DATABASE_URL);
  _db = drizzle(sql, { schema });
  return _db;
}

// Provide a proxy so existing imports (`import { db } from '@/db'`) keep working.
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    const real = getDb() as any;
    return real[prop as any];
  },
}) as ReturnType<typeof drizzle>;

export * from './schema';
