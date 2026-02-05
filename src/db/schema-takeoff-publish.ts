import { pgTable, text, timestamp, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { bids, takeoffRuns } from './schema';

export const takeoffRunPublishes = pgTable('takeoff_run_publishes', {
  id: uuid('id').primaryKey().defaultRandom(),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').notNull().references(() => takeoffRuns.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  bidUserUnique: uniqueIndex('takeoff_run_publishes_bid_user_unique').on(table.bidId, table.userId),
  runIdx: index('takeoff_run_publishes_run_idx').on(table.runId),
}));
