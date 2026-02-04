import { relations } from "drizzle-orm/relations";
import { user, connections, bids, documents, extractionJobs, lineItems, session, account, syncJobs, userSettings, uploadSessions } from "./schema";

export const connectionsRelations = relations(connections, ({one, many}) => ({
	user: one(user, {
		fields: [connections.userId],
		references: [user.id]
	}),
	bids: many(bids),
	syncJobs: many(syncJobs),
}));

export const userRelations = relations(user, ({many}) => ({
	connections: many(connections),
	bids: many(bids),
	extractionJobs: many(extractionJobs),
	lineItems_userId: many(lineItems, {
		relationName: "lineItems_userId_user_id"
	}),
	lineItems_reviewedBy: many(lineItems, {
		relationName: "lineItems_reviewedBy_user_id"
	}),
	sessions: many(session),
	accounts: many(account),
	syncJobs: many(syncJobs),
	userSettings: many(userSettings),
	uploadSessions: many(uploadSessions),
}));

export const bidsRelations = relations(bids, ({one, many}) => ({
	user: one(user, {
		fields: [bids.userId],
		references: [user.id]
	}),
	connection: one(connections, {
		fields: [bids.connectionId],
		references: [connections.id]
	}),
	documents: many(documents),
	lineItems: many(lineItems),
}));

export const documentsRelations = relations(documents, ({one, many}) => ({
	bid: one(bids, {
		fields: [documents.bidId],
		references: [bids.id]
	}),
	extractionJobs: many(extractionJobs),
	lineItems: many(lineItems),
}));

export const extractionJobsRelations = relations(extractionJobs, ({one}) => ({
	document: one(documents, {
		fields: [extractionJobs.documentId],
		references: [documents.id]
	}),
	user: one(user, {
		fields: [extractionJobs.userId],
		references: [user.id]
	}),
}));

export const lineItemsRelations = relations(lineItems, ({one}) => ({
	document: one(documents, {
		fields: [lineItems.documentId],
		references: [documents.id]
	}),
	bid: one(bids, {
		fields: [lineItems.bidId],
		references: [bids.id]
	}),
	user_userId: one(user, {
		fields: [lineItems.userId],
		references: [user.id],
		relationName: "lineItems_userId_user_id"
	}),
	user_reviewedBy: one(user, {
		fields: [lineItems.reviewedBy],
		references: [user.id],
		relationName: "lineItems_reviewedBy_user_id"
	}),
}));

export const sessionRelations = relations(session, ({one}) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id]
	}),
}));

export const accountRelations = relations(account, ({one}) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id]
	}),
}));

export const syncJobsRelations = relations(syncJobs, ({one}) => ({
	user: one(user, {
		fields: [syncJobs.userId],
		references: [user.id]
	}),
	connection: one(connections, {
		fields: [syncJobs.connectionId],
		references: [connections.id]
	}),
}));

export const userSettingsRelations = relations(userSettings, ({one}) => ({
	user: one(user, {
		fields: [userSettings.userId],
		references: [user.id]
	}),
}));

export const uploadSessionsRelations = relations(uploadSessions, ({one}) => ({
	user: one(user, {
		fields: [uploadSessions.userId],
		references: [user.id]
	}),
}));
