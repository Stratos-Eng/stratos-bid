CREATE TABLE "sheet_vectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sheet_id" uuid NOT NULL,
	"snap_points" jsonb,
	"lines" jsonb,
	"extracted_at" timestamp,
	"raw_path_count" integer,
	"cleaned_path_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sheet_vectors_sheet_id_unique" UNIQUE("sheet_id")
);
--> statement-breakpoint
ALTER TABLE "sheet_vectors" ADD CONSTRAINT "sheet_vectors_sheet_id_takeoff_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."takeoff_sheets"("id") ON DELETE cascade ON UPDATE no action;