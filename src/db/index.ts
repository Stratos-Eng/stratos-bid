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

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });

export * from './schema';
