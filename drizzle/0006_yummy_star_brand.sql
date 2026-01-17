ALTER TABLE "documents" ADD COLUMN "thumbnails_generated" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "updated_at" timestamp;