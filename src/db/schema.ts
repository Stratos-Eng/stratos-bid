import { pgTable, text, timestamp, uuid, real, jsonb, integer } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  refresh_token: text('refresh_token'),
  access_token: text('access_token'),
  expires_at: integer('expires_at'),
  token_type: text('token_type'),
  scope: text('scope'),
  id_token: text('id_token'),
  session_state: text('session_state'),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionToken: text('session_token').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires').notNull(),
});

export const connections = pgTable('connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(), // 'gmail' | 'planhub' | 'buildingconnected' | 'planetbids'
  authType: text('auth_type').notNull(), // 'oauth' | 'password' | 'api_key'
  credentials: text('credentials'), // encrypted JSON
  status: text('status').notNull().default('active'), // 'active' | 'error' | 'needs_reauth'
  lastSynced: timestamp('last_synced'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const bids = pgTable('bids', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => connections.id),
  sourcePlatform: text('source_platform').notNull(),
  sourceBidId: text('source_bid_id').notNull(),

  title: text('title').notNull(),
  description: text('description'),
  projectAddress: text('project_address'),
  city: text('city'),
  state: text('state'),

  bidDueDate: timestamp('bid_due_date'),
  postedDate: timestamp('posted_date'),
  invitedDate: timestamp('invited_date'),

  status: text('status').notNull().default('new'), // 'new' | 'reviewing' | 'bidding' | 'passed' | 'won' | 'lost'
  relevanceScore: real('relevance_score').default(0),
  relevanceReasons: jsonb('relevance_reasons'),

  sourceUrl: text('source_url'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  docType: text('doc_type'), // 'plans' | 'specs' | 'addendum' | 'other'
  storagePath: text('storage_path'),
  extractedText: text('extracted_text'),
  relevanceScore: real('relevance_score').default(0),
  pageCount: integer('page_count'),
  downloadedAt: timestamp('downloaded_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const syncJobs = pgTable('sync_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => connections.id),
  status: text('status').notNull().default('pending'), // 'pending' | 'running' | 'completed' | 'failed'
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  errorMessage: text('error_message'),
  bidsFound: integer('bids_found'),
  docsDownloaded: integer('docs_downloaded'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
