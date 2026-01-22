import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';
import { validateEnv, getFeatureSummary } from '@/lib/env-validation';

// Validate environment on module load (first import)
if (typeof window === 'undefined') {
  const result = validateEnv();

  // Log warnings
  for (const warning of result.warnings) {
    console.warn(`[ENV] ${warning}`);
  }

  // Log errors but don't throw - allow app to start for debugging
  for (const error of result.errors) {
    console.error(`[ENV ERROR] ${error}`);
  }

  // Log feature availability in development
  if (process.env.NODE_ENV === 'development') {
    const features = getFeatureSummary();
    console.log('[ENV] Feature availability:', features);
  }
}

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });

export * from './schema';
