import { z } from 'zod';

// Measurement types
export const measurementTypeSchema = z.enum(['count', 'linear', 'area']);
export type MeasurementType = z.infer<typeof measurementTypeSchema>;

// Unit schemas per measurement type
export const countUnitSchema = z.literal('EA');
export const linearUnitSchema = z.enum(['LF', 'm']);
export const areaUnitSchema = z.enum(['SF', 'sqm']);

// Combined unit schema
export const unitSchema = z.enum(['EA', 'LF', 'm', 'SF', 'sqm']);
export type Unit = z.infer<typeof unitSchema>;

// GeoJSON schemas
export const pointGeometrySchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]),
});

export const lineStringGeometrySchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
});

export const polygonGeometrySchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()])).min(4)),
});

export const geometrySchema = z.discriminatedUnion('type', [
  pointGeometrySchema,
  lineStringGeometrySchema,
  polygonGeometrySchema,
]);

export type Geometry = z.infer<typeof geometrySchema>;

// Validate unit matches measurement type
export function validateUnitForType(type: MeasurementType, unit: Unit): boolean {
  const validUnits: Record<MeasurementType, Unit[]> = {
    count: ['EA'],
    linear: ['LF', 'm'],
    area: ['SF', 'sqm'],
  };
  return validUnits[type].includes(unit);
}

// ============================================================
// Projects API Schemas
// ============================================================

export const createProjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  bidId: z.string().uuid().optional(),
  clientName: z.string().max(255).optional(),
  address: z.string().max(500).optional(),
  defaultUnit: z.enum(['imperial', 'metric']).default('imperial'),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  clientName: z.string().max(255).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  defaultUnit: z.enum(['imperial', 'metric']).optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
});

// ============================================================
// Categories API Schemas
// ============================================================

export const createCategorySchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
  name: z.string().min(1, 'Name is required').max(100),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color').default('#3B82F6'),
  measurementType: measurementTypeSchema,
  sortOrder: z.number().int().min(0).optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  measurementType: measurementTypeSchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const deleteCategorySchema = z.object({
  id: z.string().uuid('Invalid category ID'),
});

// ============================================================
// Measurements API Schemas
// ============================================================

export const createMeasurementSchema = z.object({
  id: z.string().uuid().optional(), // Client can provide ID for optimistic updates
  sheetId: z.string().uuid('Invalid sheet ID'),
  categoryId: z.string().uuid('Invalid category ID'),
  type: measurementTypeSchema,
  geometry: geometrySchema,
  quantity: z.number().min(0).default(0),
  unit: unitSchema,
  label: z.string().max(100).optional().nullable(),
}).refine(
  (data) => validateUnitForType(data.type, data.unit),
  {
    message: 'Unit must match measurement type (count: EA, linear: LF/m, area: SF/sqm)',
    path: ['unit'],
  }
);

export const updateMeasurementSchema = z.object({
  id: z.string().uuid('Invalid measurement ID'),
  geometry: geometrySchema.optional(),
  quantity: z.number().min(0).optional(),
  type: measurementTypeSchema.optional(),
  unit: unitSchema.optional(),
  label: z.string().max(100).optional().nullable(),
}).refine(
  (data) => {
    // Only validate if both type and unit are provided
    if (data.type && data.unit) {
      return validateUnitForType(data.type, data.unit);
    }
    return true;
  },
  {
    message: 'Unit must match measurement type',
    path: ['unit'],
  }
);

export const deleteMeasurementSchema = z.object({
  id: z.string().uuid('Invalid measurement ID'),
});

export const getMeasurementsSchema = z.object({
  sheetId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
}).refine(
  (data) => data.sheetId || data.projectId,
  { message: 'Either sheetId or projectId is required' }
);

// ============================================================
// Vectors API Schemas
// ============================================================

export const extractVectorsSchema = z.object({
  sheetId: z.string().uuid('Invalid sheet ID'),
});

export const getVectorsSchema = z.object({
  sheetId: z.string().uuid('Invalid sheet ID'),
});

export const batchExtractVectorsSchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
});

// ============================================================
// Render API Schemas
// ============================================================

export const renderPageSchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
  page: z.number().int().min(1),
  scale: z.number().min(0.1).max(10).default(1.5),
});

// ============================================================
// Upload API Schemas
// ============================================================

// Upload validation happens via FormData, but we can validate metadata
export const uploadMetadataSchema = z.object({
  projectId: z.string().uuid('Invalid project ID').optional(),
  name: z.string().min(1).max(255).optional(),
});

// ============================================================
// Export API Schemas
// ============================================================

export const exportProjectSchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
  format: z.enum(['csv', 'excel', 'pdf']),
  includeImages: z.boolean().default(false),
});

// ============================================================
// Helper to format Zod errors for API responses
// ============================================================

export function formatZodError(error: z.ZodError<unknown>): string {
  return error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
}
