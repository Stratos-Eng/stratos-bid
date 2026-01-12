import { db } from '../src/db';
import { sql } from 'drizzle-orm';

async function resetDatabase() {
  console.log('Dropping all tables...');

  // Drop all tables in correct order (respecting foreign keys)
  const tables = [
    'sheet_vectors',
    'takeoff_measurements',
    'takeoff_sheets',
    'takeoff_categories',
    'takeoff_projects',
    'line_items',
    'documents',
    'extraction_jobs',
    'sync_jobs',
    'bids',
    'projects',
    'planetbids_portals',
    'user_settings',
    'connections',
    'session',
    'account',
    'verificationToken',
    'user',
    'accounts'
  ];

  for (const table of tables) {
    try {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${table}" CASCADE`));
      console.log(`Dropped ${table}`);
    } catch (e) {
      console.log(`Could not drop ${table}: ${e}`);
    }
  }

  console.log('All tables dropped. Now run: npx drizzle-kit push');
}

resetDatabase().catch(console.error);
