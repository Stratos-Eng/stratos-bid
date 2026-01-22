import 'dotenv/config';
import { db } from '../src/db';
import { sql } from 'drizzle-orm';

async function resetDatabase() {
  console.log('Dropping all tables...');

  // Drop ALL tables using pg_tables
  await db.execute(sql`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);

  console.log('All tables dropped. Now run: npx drizzle-kit push');
  process.exit(0);
}

resetDatabase().catch((e) => {
  console.error(e);
  process.exit(1);
});
