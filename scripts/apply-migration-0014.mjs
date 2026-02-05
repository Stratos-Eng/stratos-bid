#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL in environment');
  process.exit(1);
}

const migrationPath = path.join(__dirname, '..', 'drizzle', '0014_takeoff_runs_findings_items.sql');
const sqlText = fs.readFileSync(migrationPath, 'utf8');

// naive split on semicolons at EOL; good enough for this migration file
const statements = sqlText
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s + ';');

const sql = neon(DATABASE_URL);

console.log(`[migration] applying ${migrationPath}`);
for (const [i, stmt] of statements.entries()) {
  try {
    await sql(stmt);
  } catch (err) {
    console.error(`\n[migration] statement ${i + 1}/${statements.length} failed:`);
    console.error(stmt);
    throw err;
  }
}
console.log('[migration] done');
