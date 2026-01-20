import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';

async function clearTables() {
  const connection = neon(process.env.DATABASE_URL!);
  const db = drizzle(connection);

  const tables = [
    'symbol_regions',
    'page_text',
    'takeoff_measurements',
    'sheet_vectors',
    'takeoff_sheets',
    'takeoff_categories',
    'takeoff_projects',
    'line_items',
    'sync_jobs',
    'upload_sessions',
    'documents',
    'connections',
    'bids',
  ];

  for (const table of tables) {
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE "${table}" CASCADE`));
      console.log(`Truncated ${table}`);
    } catch (e: any) {
      console.log(`Skipped ${table}: ${e.message}`);
    }
  }

  console.log('Done!');
  process.exit(0);
}

clearTables();
