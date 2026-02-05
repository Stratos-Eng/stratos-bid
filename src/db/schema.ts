import { pgTable, text, timestamp, uuid, real, jsonb, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';

// Note: With Clerk, users are managed externally. user_id is the Clerk user ID (string like "user_xxx")

export const connections = pgTable('connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(), // Clerk user ID
  platform: text('platform').notNull(), // 'gmail' | 'planhub' | 'buildingconnected' | 'planetbids'
  authType: text('auth_type').notNull(), // 'oauth' | 'password' | 'api_key'
  credentials: text('credentials'), // encrypted JSON
  status: text('status').notNull().default('active'), // 'active' | 'error' | 'needs_reauth'
  lastSynced: timestamp('last_synced'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  userIdx: index('connections_user_idx').on(table.userId),
}));

export const bids = pgTable('bids', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(), // Clerk user ID
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
}, (table) => ({
  userIdx: index('bids_user_idx').on(table.userId),
  statusIdx: index('bids_status_idx').on(table.status),
}));

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  bidId: uuid('bid_id').references(() => bids.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  docType: text('doc_type'), // 'plans' | 'specs' | 'addendum' | 'other'
  storagePath: text('storage_path'),
  relevanceScore: real('relevance_score').default(0),
  pageCount: integer('page_count'),
  downloadedAt: timestamp('downloaded_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  extractionStatus: text('extraction_status').default('not_started'), // 'not_started' | 'queued' | 'extracting' | 'completed' | 'failed'
  textExtractionStatus: text('text_extraction_status').default('not_started'), // 'not_started' | 'extracting' | 'completed' | 'failed'
  lineItemCount: integer('line_item_count').default(0),
  pagesWithTrades: jsonb('pages_with_trades'), // [{ page: 13, trades: ['signage'] }]
  signageLegend: jsonb('signage_legend'),
  pagesReady: boolean('pages_ready').default(false),
  updatedAt: timestamp('updated_at'),
}, (table) => ({
  bidIdx: index('documents_bid_idx').on(table.bidId),
  extractionStatusIdx: index('documents_extraction_status_idx').on(table.extractionStatus),
}));

export const syncJobs = pgTable('sync_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(), // Clerk user ID
  connectionId: uuid('connection_id').references(() => connections.id),
  status: text('status').notNull().default('pending'), // 'pending' | 'running' | 'completed' | 'failed'
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  errorMessage: text('error_message'),
  bidsFound: integer('bids_found'),
  docsDownloaded: integer('docs_downloaded'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  userIdx: index('sync_jobs_user_idx').on(table.userId),
  statusIdx: index('sync_jobs_status_idx').on(table.status),
}));

// Page text for full-text search
export const pageText = pgTable('page_text', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  pageNumber: integer('page_number').notNull(),
  rawText: text('raw_text'),
  // Note: text_search tsvector column is managed via raw SQL migration
  extractionMethod: text('extraction_method').default('pymupdf'), // 'pymupdf' | 'tesseract'
  needsOcr: boolean('needs_ocr').default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  documentPageUnique: uniqueIndex('page_text_document_page_unique').on(table.documentId, table.pageNumber),
  needsOcrIdx: index('page_text_needs_ocr_idx').on(table.needsOcr),
}));

// Line items extracted from documents (signage, glazing, etc.)
export const lineItems = pgTable('line_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(), // Clerk user ID

  // Classification
  tradeCode: text('trade_code').notNull(), // 'division_08' | 'division_10'
  category: text('category').notNull(), // e.g., 'Exit Signs', 'Storefront', 'Curtain Wall'

  // Location in PDF
  pageNumber: integer('page_number'),
  pageReference: text('page_reference'), // e.g., "A2.1" for architectural drawings
  pageX: real('page_x'), // X coordinate on PDF page (0-1 normalized)
  pageY: real('page_y'), // Y coordinate on PDF page (0-1 normalized)

  // Item details
  description: text('description').notNull(),
  estimatedQty: text('estimated_qty'), // Text to allow "TBD", "Verify", ranges like "10-15"
  unit: text('unit'), // 'EA', 'SF', 'LF', etc.

  // Additional context
  notes: text('notes'),

  // AI extraction metadata
  extractionConfidence: real('extraction_confidence'), // 0-1 confidence score
  extractedAt: timestamp('extracted_at'),
  extractionModel: text('extraction_model'), // 'claude-opus-4-5-20251101'
  rawExtractionJson: jsonb('raw_extraction_json'), // Full Claude response for debugging

  // Review status
  reviewStatus: text('review_status').notNull().default('pending'), // 'pending' | 'approved' | 'rejected' | 'modified'
  reviewedAt: timestamp('reviewed_at'),
  reviewedBy: text('reviewed_by'), // Clerk user ID

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  documentIdx: index('line_items_document_idx').on(table.documentId),
  bidIdx: index('line_items_bid_idx').on(table.bidId),
  tradeIdx: index('line_items_trade_idx').on(table.tradeCode),
  userIdx: index('line_items_user_idx').on(table.userId),
}));

// User preferences for trades and settings
// Takeoff run workspace (v2)
export const takeoffRuns = pgTable('takeoff_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull(),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('running'),
  workerId: text('worker_id'),
  extractorVersion: text('extractor_version'),
  model: text('model'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
  summary: jsonb('summary'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  jobIdx: index('takeoff_runs_job_idx').on(table.jobId),
  bidIdx: index('takeoff_runs_bid_idx').on(table.bidId),
  userIdx: index('takeoff_runs_user_idx').on(table.userId),
  statusIdx: index('takeoff_runs_status_idx').on(table.status),
}));

export const takeoffArtifacts = pgTable('takeoff_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => takeoffRuns.id, { onDelete: 'cascade' }),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  pageNumber: integer('page_number'),
  method: text('method'),
  rawText: text('raw_text'),
  meta: jsonb('meta'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  runIdx: index('takeoff_artifacts_run_idx').on(table.runId),
  docIdx: index('takeoff_artifacts_doc_idx').on(table.documentId),
}));

export const takeoffFindings = pgTable('takeoff_findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => takeoffRuns.id, { onDelete: 'cascade' }),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  pageNumber: integer('page_number'),
  type: text('type').notNull(),
  confidence: real('confidence'),
  data: jsonb('data'),
  evidenceText: text('evidence_text'),
  evidence: jsonb('evidence'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  runIdx: index('takeoff_findings_run_idx').on(table.runId),
  docPageIdx: index('takeoff_findings_doc_page_idx').on(table.documentId, table.pageNumber),
  typeIdx: index('takeoff_findings_type_idx').on(table.type),
}));

export const takeoffItems = pgTable('takeoff_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => takeoffRuns.id, { onDelete: 'cascade' }),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  tradeCode: text('trade_code').notNull(),
  itemKey: text('item_key').notNull(),
  code: text('code'),
  category: text('category').notNull(),
  description: text('description').notNull(),
  qtyNumber: real('qty_number'),
  qtyText: text('qty_text'),
  unit: text('unit'),
  confidence: real('confidence'),
  status: text('status').notNull().default('draft'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  runIdx: index('takeoff_items_run_idx').on(table.runId),
  bidIdx: index('takeoff_items_bid_idx').on(table.bidId),
  userIdx: index('takeoff_items_user_idx').on(table.userId),
  tradeIdx: index('takeoff_items_trade_idx').on(table.tradeCode),
  runKeyUnique: uniqueIndex('takeoff_items_run_key_unique').on(table.runId, table.itemKey),
}));

export const takeoffItemEvidence = pgTable('takeoff_item_evidence', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemId: uuid('item_id').notNull().references(() => takeoffItems.id, { onDelete: 'cascade' }),
  findingId: uuid('finding_id').notNull().references(() => takeoffFindings.id, { onDelete: 'cascade' }),
  weight: real('weight'),
  note: text('note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  unique: uniqueIndex('takeoff_item_evidence_unique').on(table.itemId, table.findingId),
  itemIdx: index('takeoff_item_evidence_item_idx').on(table.itemId),
  findingIdx: index('takeoff_item_evidence_finding_idx').on(table.findingId),
}));

export const takeoffItemEdits = pgTable('takeoff_item_edits', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemId: uuid('item_id').notNull().references(() => takeoffItems.id, { onDelete: 'cascade' }),
  editedBy: text('edited_by').notNull(),
  editType: text('edit_type').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  itemIdx: index('takeoff_item_edits_item_idx').on(table.itemId),
}));

export const userSettings = pgTable('user_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().unique(), // Clerk user ID
  trades: jsonb('trades').default(['division_08', 'division_10']), // User's trade specialties
  locations: jsonb('locations'), // State/region filters
  autoExtract: boolean('auto_extract').default(true), // Auto-extract when docs downloaded
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Symbol regions for visual similarity search
export const symbolRegions = pgTable('symbol_regions', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  pageNumber: integer('page_number').notNull(),

  // Region coordinates (normalized 0-1)
  x: real('x').notNull(),
  y: real('y').notNull(),
  width: real('width').notNull(),
  height: real('height').notNull(),

  // CLIP embedding stored as JSON array (for similarity search)
  embedding: jsonb('embedding'), // number[] - 512 dimensions

  // OCR text if detected
  ocrText: text('ocr_text'),
  ocrConfidence: real('ocr_confidence'),

  // Metadata
  source: text('source').default('user_click'), // 'user_click' | 'auto_detected' | 'sliding_window'
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  documentIdx: index('symbol_regions_document_idx').on(table.documentId),
  pageIdx: index('symbol_regions_page_idx').on(table.documentId, table.pageNumber),
}));

// PlanetBids portal tracking
export const planetbidsPortals = pgTable('planetbids_portals', {
  id: uuid('id').primaryKey().defaultRandom(),
  portalId: text('portal_id').notNull().unique(), // Numeric ID like "14319"
  name: text('name'), // Agency name like "Kern High School District"
  state: text('state').default('CA'),
  registered: boolean('registered').default(false), // Whether we've signed up
  lastScraped: timestamp('last_scraped'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Upload sessions for chunked file uploads
export const uploadSessions = pgTable('upload_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(), // Clerk user ID
  bidId: uuid('bid_id').references(() => bids.id, { onDelete: 'cascade' }),

  // File metadata
  filename: text('filename').notNull(),
  fileSize: integer('file_size').notNull(), // Total file size in bytes
  mimeType: text('mime_type').notNull(),

  // Chunking info
  chunkSize: integer('chunk_size').notNull(), // Chunk size in bytes
  totalChunks: integer('total_chunks').notNull(),
  receivedChunks: integer('received_chunks').default(0).notNull(),

  // Status tracking
  status: text('status').notNull().default('pending'), // 'pending' | 'uploading' | 'assembling' | 'completed' | 'failed' | 'expired'
  errorMessage: text('error_message'),

  // Storage paths
  tempDir: text('temp_dir').notNull(), // Temp directory for chunks
  finalPath: text('final_path'), // Final assembled file path

  // For sheet naming (optional metadata passed from client)
  folderName: text('folder_name'),
  relativePath: text('relative_path'),

  // Timestamps
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(), // Auto-cleanup stale uploads
}, (table) => ({
  expiresAtIdx: index('upload_sessions_expires_at_idx').on(table.expiresAt),
}));

// Type exports for inserting data
export type NewBid = typeof bids.$inferInsert;
export type NewPlanetbidsPortal = typeof planetbidsPortals.$inferInsert;
export type NewDocument = typeof documents.$inferInsert;
export type NewLineItem = typeof lineItems.$inferInsert;
export type NewUploadSession = typeof uploadSessions.$inferInsert;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type NewPageText = typeof pageText.$inferInsert;
export type PageText = typeof pageText.$inferSelect;
export type NewSymbolRegion = typeof symbolRegions.$inferInsert;
export type SymbolRegion = typeof symbolRegions.$inferSelect;

// ========================================
// Takeoff job queue (droplet worker)
// ========================================

export const takeoffJobs = pgTable('takeoff_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('queued'), // queued | running | succeeded | failed
  requestedDocumentIds: jsonb('requested_document_ids'),
  bidFolder: text('bid_folder'),

  lockId: text('lock_id'),
  lockedAt: timestamp('locked_at'),

  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
}, (table) => ({
  statusIdx: index('takeoff_jobs_status_idx').on(table.status),
  bidIdx: index('takeoff_jobs_bid_idx').on(table.bidId),
  userIdx: index('takeoff_jobs_user_idx').on(table.userId),
}));

export const takeoffJobDocuments = pgTable('takeoff_job_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => takeoffJobs.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  uniqueJobDoc: uniqueIndex('takeoff_job_documents_unique').on(table.jobId, table.documentId),
  jobIdx: index('takeoff_job_documents_job_idx').on(table.jobId),
  docIdx: index('takeoff_job_documents_doc_idx').on(table.documentId),
}));

export type TakeoffJob = typeof takeoffJobs.$inferSelect;
export type NewTakeoffJob = typeof takeoffJobs.$inferInsert;
export type TakeoffJobDocument = typeof takeoffJobDocuments.$inferSelect;
export type NewTakeoffJobDocument = typeof takeoffJobDocuments.$inferInsert;
