-- Add measurement_type column with derived default from geometry
ALTER TABLE "takeoff_measurements" ADD COLUMN "measurement_type" text;
UPDATE "takeoff_measurements" SET "measurement_type" =
  CASE
    WHEN geometry->>'type' = 'Point' THEN 'count'
    WHEN geometry->>'type' = 'LineString' THEN 'linear'
    WHEN geometry->>'type' = 'Polygon' THEN 'area'
    ELSE 'count'
  END;
ALTER TABLE "takeoff_measurements" ALTER COLUMN "measurement_type" SET NOT NULL;

--> statement-breakpoint

-- Add unit column with derived default based on measurement_type
ALTER TABLE "takeoff_measurements" ADD COLUMN "unit" text;
UPDATE "takeoff_measurements" SET "unit" =
  CASE
    WHEN "measurement_type" = 'count' THEN 'EA'
    WHEN "measurement_type" = 'linear' THEN 'LF'
    WHEN "measurement_type" = 'area' THEN 'SF'
    ELSE 'EA'
  END;
ALTER TABLE "takeoff_measurements" ALTER COLUMN "unit" SET NOT NULL;

--> statement-breakpoint

-- Add optional label column
ALTER TABLE "takeoff_measurements" ADD COLUMN "label" text;
