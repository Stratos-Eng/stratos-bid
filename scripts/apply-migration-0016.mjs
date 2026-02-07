// Apply drizzle/0016_takeoff_instances.sql to Neon
import { config } from 'dotenv';
config({ path: '.env.worker' });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL in .env.worker');
  process.exit(1);
}

const { neon } = await import('@neondatabase/serverless');
const sql = neon(DATABASE_URL);

const fs = await import('fs');
const path = await import('path');

const filePath = path.join(process.cwd(), 'drizzle', '0016_takeoff_instances.sql');
const content = fs.readFileSync(filePath, 'utf-8');

const statements = content
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => s + ';');

for (const stmt of statements) {
  console.log('Applying:', stmt.slice(0, 80).replace(/\s+/g, ' ') + (stmt.length > 80 ? '…' : ''));
  await sql.query(stmt);
}

console.log('Migration 0016 applied successfully');
