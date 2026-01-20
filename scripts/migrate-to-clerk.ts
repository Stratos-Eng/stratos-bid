import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

async function migrate() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('Starting migration to Clerk auth...\n');

  // Drop old NextAuth tables
  console.log('1. Dropping NextAuth tables...');
  try {
    await sql`DROP TABLE IF EXISTS session CASCADE`;
    console.log('   Dropped session');
  } catch (e: any) {
    console.log(`   session: ${e.message}`);
  }
  try {
    await sql`DROP TABLE IF EXISTS account CASCADE`;
    console.log('   Dropped account');
  } catch (e: any) {
    console.log(`   account: ${e.message}`);
  }
  try {
    await sql`DROP TABLE IF EXISTS "verificationToken" CASCADE`;
    console.log('   Dropped verificationToken');
  } catch (e: any) {
    console.log(`   verificationToken: ${e.message}`);
  }
  try {
    await sql`DROP TABLE IF EXISTS "user" CASCADE`;
    console.log('   Dropped user');
  } catch (e: any) {
    console.log(`   user: ${e.message}`);
  }

  // Change user_id columns from uuid to text
  console.log('\n2. Changing user_id columns from UUID to TEXT...');

  // connections
  try {
    await sql`ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_user_id_user_id_fk`;
    await sql`ALTER TABLE connections ALTER COLUMN user_id TYPE TEXT`;
    console.log('   Changed connections.user_id to TEXT');
  } catch (e: any) {
    console.log(`   connections.user_id: ${e.message}`);
  }

  // bids
  try {
    await sql`ALTER TABLE bids DROP CONSTRAINT IF EXISTS bids_user_id_user_id_fk`;
    await sql`ALTER TABLE bids ALTER COLUMN user_id TYPE TEXT`;
    console.log('   Changed bids.user_id to TEXT');
  } catch (e: any) {
    console.log(`   bids.user_id: ${e.message}`);
  }

  // sync_jobs
  try {
    await sql`ALTER TABLE sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_user_id_user_id_fk`;
    await sql`ALTER TABLE sync_jobs ALTER COLUMN user_id TYPE TEXT`;
    console.log('   Changed sync_jobs.user_id to TEXT');
  } catch (e: any) {
    console.log(`   sync_jobs.user_id: ${e.message}`);
  }

  // line_items
  try {
    await sql`ALTER TABLE line_items DROP CONSTRAINT IF EXISTS line_items_user_id_user_id_fk`;
    await sql`ALTER TABLE line_items ALTER COLUMN user_id TYPE TEXT`;
    console.log('   Changed line_items.user_id to TEXT');
  } catch (e: any) {
    console.log(`   line_items.user_id: ${e.message}`);
  }

  // extraction_jobs
  try {
    await sql`ALTER TABLE extraction_jobs DROP CONSTRAINT IF EXISTS extraction_jobs_user_id_user_id_fk`;
    await sql`ALTER TABLE extraction_jobs ALTER COLUMN user_id TYPE TEXT`;
    console.log('   Changed extraction_jobs.user_id to TEXT');
  } catch (e: any) {
    console.log(`   extraction_jobs.user_id: ${e.message}`);
  }

  // user_settings
  try {
    await sql`ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS user_settings_user_id_user_id_fk`;
    await sql`ALTER TABLE user_settings ALTER COLUMN user_id TYPE TEXT`;
    console.log('   Changed user_settings.user_id to TEXT');
  } catch (e: any) {
    console.log(`   user_settings.user_id: ${e.message}`);
  }

  // takeoff_projects
  try {
    await sql`ALTER TABLE takeoff_projects DROP CONSTRAINT IF EXISTS takeoff_projects_user_id_user_id_fk`;
    await sql`ALTER TABLE takeoff_projects ALTER COLUMN user_id TYPE TEXT`;
    console.log('   Changed takeoff_projects.user_id to TEXT');
  } catch (e: any) {
    console.log(`   takeoff_projects.user_id: ${e.message}`);
  }

  // upload_sessions
  try {
    await sql`ALTER TABLE upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_user_id_user_id_fk`;
    await sql`ALTER TABLE upload_sessions ALTER COLUMN user_id TYPE TEXT`;
    console.log('   Changed upload_sessions.user_id to TEXT');
  } catch (e: any) {
    console.log(`   upload_sessions.user_id: ${e.message}`);
  }

  // reviewed_by and created_by columns
  console.log('\n3. Changing reviewed_by/created_by columns...');

  try {
    await sql`ALTER TABLE line_items DROP CONSTRAINT IF EXISTS line_items_reviewed_by_user_id_fk`;
    await sql`ALTER TABLE line_items ALTER COLUMN reviewed_by TYPE TEXT`;
    console.log('   Changed line_items.reviewed_by to TEXT');
  } catch (e: any) {
    console.log(`   line_items.reviewed_by: ${e.message}`);
  }

  try {
    await sql`ALTER TABLE takeoff_measurements DROP CONSTRAINT IF EXISTS takeoff_measurements_created_by_user_id_fk`;
    await sql`ALTER TABLE takeoff_measurements ALTER COLUMN created_by TYPE TEXT`;
    console.log('   Changed takeoff_measurements.created_by to TEXT');
  } catch (e: any) {
    console.log(`   takeoff_measurements.created_by: ${e.message}`);
  }

  console.log('\nMigration complete!');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
