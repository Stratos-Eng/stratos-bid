import { pgTable, text, timestamp, uuid, real, jsonb, integer, boolean, index, uniqueIndex, customType } from 'drizzle-orm/pg-core';

// Custom type for pgvector
const vector = customType<{ data: number[]; driverData: string }>({
  dataType(config) {
    const dimensions = (config as { dimensions?: number })?.dimensions ?? 512;
    return `vector(${dimensions})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    // Parse "[0.1,0.2,...]" format
    return JSON.parse(value.replace(/^\[/, '[').replace(/\]$/, ']'));
  },
});

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
});

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
  tileConfig: text('tile_config'), // JSON: { zoomLevels, tileUrlPattern, pageWidth, pageHeight }
  downloadedAt: timestamp('downloaded_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Extraction status (signage items)
  extractionStatus: text('extraction_status').default('not_started'), // 'not_started' | 'queued' | 'extracting' | 'completed' | 'failed'
  // Text extraction status (for search)
  textExtractionStatus: text('text_extraction_status').default('not_started'), // 'not_started' | 'extracting' | 'completed' | 'failed'
  lineItemCount: integer('line_item_count').default(0),
  pagesWithTrades: jsonb('pages_with_trades'), // [{ page: 13, trades: ['signage'] }]
  // Signage legend data (extracted from sign legend/schedule pages)
  // Structure: { found: boolean, legendPages: number[], sheetNumbers: string[], symbols: SymbolDefinition[], confidence: number }
  signageLegend: jsonb('signage_legend'),
  // Thumbnail generation status
  thumbnailsGenerated: boolean('thumbnails_generated').default(false),
  updatedAt: timestamp('updated_at'),
});

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
});

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
  pdfFilePath: text('pdf_file_path'),
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
  specifications: jsonb('specifications'), // Division/section references

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

// Track extraction job progress
export const extractionJobs = pgTable('extraction_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(), // Clerk user ID

  status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'completed' | 'failed'
  tradeFilter: jsonb('trade_filter'), // ['division_08', 'division_10']

  // Progress tracking
  totalPages: integer('total_pages'),
  processedPages: integer('processed_pages').default(0),
  itemsExtracted: integer('items_extracted').default(0),

  // Timing
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),

  // Results
  errorMessage: text('error_message'),
  processingTimeMs: integer('processing_time_ms'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// User preferences for trades and settings
export const userSettings = pgTable('user_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().unique(), // Clerk user ID
  trades: jsonb('trades').default(['division_08', 'division_10']), // User's trade specialties
  locations: jsonb('locations'), // State/region filters
  autoExtract: boolean('auto_extract').default(true), // Auto-extract when docs downloaded
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Takeoff projects (for full takeoff builder)
export const takeoffProjects = pgTable('takeoff_projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(), // Clerk user ID
  bidId: uuid('bid_id').references(() => bids.id, { onDelete: 'set null' }),

  name: text('name').notNull(),
  clientName: text('client_name'),
  address: text('address'),

  defaultUnit: text('default_unit').default('imperial'), // 'imperial' | 'metric'
  status: text('status').notNull().default('active'), // 'active' | 'completed' | 'archived'

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Sheets within a takeoff project (PDF pages)
export const takeoffSheets = pgTable('takeoff_sheets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => takeoffProjects.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').references(() => documents.id),

  pageNumber: integer('page_number').notNull(),
  name: text('name'), // e.g., "A2.1 - Floor Plan Level 1"

  // Dimensions
  widthPx: integer('width_px'),
  heightPx: integer('height_px'),

  // Scale calibration (user-set)
  calibration: jsonb('calibration'), // { pixelLength, realLength, unit, pixelsPerUnit }

  // Legacy scale fields (deprecated, use calibration instead)
  scaleValue: real('scale_value'), // pixels per foot
  scaleSource: text('scale_source'), // 'auto_titleblock' | 'auto_scalebar' | 'manual'
  scaleConfidence: real('scale_confidence'), // 0-1

  // Processing status
  tilesReady: boolean('tiles_ready').default(false),
  vectorsReady: boolean('vectors_ready').default(false),
  vectorQuality: text('vector_quality'), // 'good' | 'medium' | 'poor' | 'none'

  // Tile URL pattern
  tileUrlTemplate: text('tile_url_template'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  projectIdx: index('takeoff_sheets_project_idx').on(table.projectId),
}));

// Measurement categories in takeoff
export const takeoffCategories = pgTable('takeoff_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => takeoffProjects.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  color: text('color').notNull().default('#3B82F6'),
  measurementType: text('measurement_type').notNull(), // 'count' | 'linear' | 'area'
  sortOrder: integer('sort_order').default(0),

  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Individual measurements/annotations
export const takeoffMeasurements = pgTable('takeoff_measurements', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').notNull().references(() => takeoffCategories.id, { onDelete: 'cascade' }),
  sheetId: uuid('sheet_id').notNull().references(() => takeoffSheets.id, { onDelete: 'cascade' }),

  // GeoJSON geometry
  geometry: jsonb('geometry').notNull(), // { type: 'Point' | 'LineString' | 'Polygon', coordinates: [...] }

  // Measurement type and unit - MUST be persisted, not derived from geometry
  measurementType: text('measurement_type').notNull(), // 'count' | 'linear' | 'area'
  unit: text('unit').notNull(), // 'EA', 'LF', 'SF', 'm', 'sqm'
  label: text('label'), // User-defined label for this measurement

  // Calculated values
  quantity: real('quantity').notNull(), // count=1, linear=feet, area=sqft

  // Metadata
  createdBy: text('created_by'), // Clerk user ID
  source: text('source').notNull().default('manual'), // 'manual' | 'find_similar' | 'ai_detected'
  confidence: real('confidence'), // For AI-generated

  // For auditing
  snappedTo: text('snapped_to'), // 'pdf_vector' | 'annotation' | 'grid' | 'none'

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  categoryIdx: index('takeoff_measurements_category_idx').on(table.categoryId),
  sheetIdx: index('takeoff_measurements_sheet_idx').on(table.sheetId),
}));

// Sheet vectors for snapping (extracted from PDF)
export const sheetVectors = pgTable('sheet_vectors', {
  id: uuid('id').primaryKey().defaultRandom(),
  sheetId: uuid('sheet_id').notNull().references(() => takeoffSheets.id, { onDelete: 'cascade' }).unique(),

  // Simplified snap points for client
  snapPoints: jsonb('snap_points'), // Array<{ type: 'endpoint' | 'midpoint' | 'intersection', coords: [x, y] }>

  // Line segments for on-line snapping
  lines: jsonb('lines'), // Array<{ start: [x, y], end: [x, y] }>

  // Extraction metadata
  extractedAt: timestamp('extracted_at'),
  rawPathCount: integer('raw_path_count'),
  cleanedPathCount: integer('cleaned_path_count'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
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

  // CLIP embedding for visual similarity (512 dimensions)
  embedding: vector('embedding', { dimensions: 512 }),

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
  projectId: uuid('project_id').references(() => takeoffProjects.id, { onDelete: 'cascade' }),
  bidId: uuid('bid_id').references(() => bids.id, { onDelete: 'cascade' }), // For projects flow

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
});

// Type exports for inserting data
export type NewBid = typeof bids.$inferInsert;
export type NewPlanetbidsPortal = typeof planetbidsPortals.$inferInsert;
export type NewDocument = typeof documents.$inferInsert;
export type NewLineItem = typeof lineItems.$inferInsert;
export type NewExtractionJob = typeof extractionJobs.$inferInsert;
export type NewTakeoffProject = typeof takeoffProjects.$inferInsert;
export type NewTakeoffSheet = typeof takeoffSheets.$inferInsert;
export type NewTakeoffCategory = typeof takeoffCategories.$inferInsert;
export type NewTakeoffMeasurement = typeof takeoffMeasurements.$inferInsert;
export type NewSheetVectors = typeof sheetVectors.$inferInsert;
export type NewUploadSession = typeof uploadSessions.$inferInsert;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type NewPageText = typeof pageText.$inferInsert;
export type PageText = typeof pageText.$inferSelect;
export type NewSymbolRegion = typeof symbolRegions.$inferInsert;
export type SymbolRegion = typeof symbolRegions.$inferSelect;
