CREATE TABLE "planetbids_portals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_id" text NOT NULL,
	"name" text,
	"state" text DEFAULT 'CA',
	"registered" boolean DEFAULT false,
	"last_scraped" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "planetbids_portals_portal_id_unique" UNIQUE("portal_id")
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"filename" text NOT NULL,
	"file_size" integer NOT NULL,
	"mime_type" text NOT NULL,
	"chunk_size" integer NOT NULL,
	"total_chunks" integer NOT NULL,
	"received_chunks" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"temp_dir" text NOT NULL,
	"final_path" text,
	"folder_name" text,
	"relative_path" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tile_config" text;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_project_id_takeoff_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."takeoff_projects"("id") ON DELETE cascade ON UPDATE no action;