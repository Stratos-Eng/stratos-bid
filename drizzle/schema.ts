import { pgTable, foreignKey, uuid, text, timestamp, real, jsonb, integer, index, unique, boolean } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const connections = pgTable("connections", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	platform: text().notNull(),
	authType: text("auth_type").notNull(),
	credentials: text(),
	status: text().default('active').notNull(),
	lastSynced: timestamp("last_synced", { mode: 'string' }),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "connections_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const bids = pgTable("bids", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	connectionId: uuid("connection_id"),
	sourcePlatform: text("source_platform").notNull(),
	sourceBidId: text("source_bid_id").notNull(),
	title: text().notNull(),
	description: text(),
	projectAddress: text("project_address"),
	city: text(),
	state: text(),
	bidDueDate: timestamp("bid_due_date", { mode: 'string' }),
	postedDate: timestamp("posted_date", { mode: 'string' }),
	invitedDate: timestamp("invited_date", { mode: 'string' }),
	status: text().default('new').notNull(),
	relevanceScore: real("relevance_score").default(0),
	relevanceReasons: jsonb("relevance_reasons"),
	sourceUrl: text("source_url"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "bids_user_id_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.connectionId],
			foreignColumns: [connections.id],
			name: "bids_connection_id_connections_id_fk"
		}),
]);

export const documents = pgTable("documents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	bidId: uuid("bid_id").notNull(),
	filename: text().notNull(),
	docType: text("doc_type"),
	storagePath: text("storage_path"),
	relevanceScore: real("relevance_score").default(0),
	pageCount: integer("page_count"),
	downloadedAt: timestamp("downloaded_at", { mode: 'string' }),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	extractionStatus: text("extraction_status").default('not_started'),
	lineItemCount: integer("line_item_count").default(0),
	pagesWithTrades: jsonb("pages_with_trades"),
	signageLegend: jsonb("signage_legend"),
}, (table) => [
	foreignKey({
			columns: [table.bidId],
			foreignColumns: [bids.id],
			name: "documents_bid_id_bids_id_fk"
		}).onDelete("cascade"),
]);

export const extractionJobs = pgTable("extraction_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	documentId: uuid("document_id").notNull(),
	userId: uuid("user_id").notNull(),
	status: text().default('pending').notNull(),
	tradeFilter: jsonb("trade_filter"),
	totalPages: integer("total_pages"),
	processedPages: integer("processed_pages").default(0),
	itemsExtracted: integer("items_extracted").default(0),
	startedAt: timestamp("started_at", { mode: 'string' }),
	completedAt: timestamp("completed_at", { mode: 'string' }),
	errorMessage: text("error_message"),
	processingTimeMs: integer("processing_time_ms"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [documents.id],
			name: "extraction_jobs_document_id_documents_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "extraction_jobs_user_id_user_id_fk"
		}).onDelete("cascade"),
]);

export const lineItems = pgTable("line_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	documentId: uuid("document_id").notNull(),
	bidId: uuid("bid_id").notNull(),
	userId: uuid("user_id").notNull(),
	tradeCode: text("trade_code").notNull(),
	category: text().notNull(),
	pageNumber: integer("page_number"),
	pageReference: text("page_reference"),
	description: text().notNull(),
	estimatedQty: text("estimated_qty"),
	unit: text(),
	notes: text(),
	extractionConfidence: real("extraction_confidence"),
	extractedAt: timestamp("extracted_at", { mode: 'string' }),
	extractionModel: text("extraction_model"),
	rawExtractionJson: jsonb("raw_extraction_json"),
	reviewStatus: text("review_status").default('pending').notNull(),
	reviewedAt: timestamp("reviewed_at", { mode: 'string' }),
	reviewedBy: uuid("reviewed_by"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("line_items_bid_idx").using("btree", table.bidId.asc().nullsLast().op("uuid_ops")),
	index("line_items_document_idx").using("btree", table.documentId.asc().nullsLast().op("uuid_ops")),
	index("line_items_trade_idx").using("btree", table.tradeCode.asc().nullsLast().op("text_ops")),
	index("line_items_user_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [documents.id],
			name: "line_items_document_id_documents_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.bidId],
			foreignColumns: [bids.id],
			name: "line_items_bid_id_bids_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "line_items_user_id_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.reviewedBy],
			foreignColumns: [user.id],
			name: "line_items_reviewed_by_user_id_fk"
		}),
]);

export const session = pgTable("session", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	sessionToken: text().notNull(),
	userId: uuid().notNull(),
	expires: timestamp({ mode: 'string' }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "session_userId_user_id_fk"
		}).onDelete("cascade"),
	unique("session_sessionToken_unique").on(table.sessionToken),
]);

export const planetbidsPortals = pgTable("planetbids_portals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	portalId: text("portal_id").notNull(),
	name: text(),
	state: text().default('CA'),
	registered: boolean().default(false),
	lastScraped: timestamp("last_scraped", { mode: 'string' }),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("planetbids_portals_portal_id_unique").on(table.portalId),
]);

export const account = pgTable("account", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid().notNull(),
	type: text().notNull(),
	provider: text().notNull(),
	providerAccountId: text().notNull(),
	refreshToken: text("refresh_token"),
	accessToken: text("access_token"),
	expiresAt: integer("expires_at"),
	tokenType: text("token_type"),
	scope: text(),
	idToken: text("id_token"),
	sessionState: text("session_state"),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "account_userId_user_id_fk"
		}).onDelete("cascade"),
]);

export const syncJobs = pgTable("sync_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	connectionId: uuid("connection_id"),
	status: text().default('pending').notNull(),
	startedAt: timestamp("started_at", { mode: 'string' }),
	completedAt: timestamp("completed_at", { mode: 'string' }),
	errorMessage: text("error_message"),
	bidsFound: integer("bids_found"),
	docsDownloaded: integer("docs_downloaded"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "sync_jobs_user_id_user_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.connectionId],
			foreignColumns: [connections.id],
			name: "sync_jobs_connection_id_connections_id_fk"
		}),
]);

export const userSettings = pgTable("user_settings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	trades: jsonb().default(["division_08","division_10"]),
	locations: jsonb(),
	autoExtract: boolean("auto_extract").default(true),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "user_settings_user_id_user_id_fk"
		}).onDelete("cascade"),
	unique("user_settings_user_id_unique").on(table.userId),
]);

export const verificationToken = pgTable("verificationToken", {
	identifier: text().notNull(),
	token: text().notNull(),
	expires: timestamp({ mode: 'string' }).notNull(),
}, (table) => [
	unique("verificationToken_token_unique").on(table.token),
]);

export const user = pgTable("user", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: text().notNull(),
	emailVerified: timestamp({ mode: 'string' }),
	name: text(),
	image: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("user_email_unique").on(table.email),
]);

export const uploadSessions = pgTable("upload_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	filename: text().notNull(),
	fileSize: integer("file_size").notNull(),
	mimeType: text("mime_type").notNull(),
	chunkSize: integer("chunk_size").notNull(),
	totalChunks: integer("total_chunks").notNull(),
	receivedChunks: integer("received_chunks").default(0).notNull(),
	status: text().default('pending').notNull(),
	errorMessage: text("error_message"),
	tempDir: text("temp_dir").notNull(),
	finalPath: text("final_path"),
	folderName: text("folder_name"),
	relativePath: text("relative_path"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "upload_sessions_user_id_user_id_fk"
		}).onDelete("cascade"),
]);
