/**
 * Environment Validation Module
 *
 * Validates required environment variables and provides
 * helpful error messages during development.
 *
 * Import this module early in your application to catch
 * configuration errors at startup.
 */

export interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Required environment variables
 */
const REQUIRED_VARS = [
  'DATABASE_URL',
  'BLOB_READ_WRITE_TOKEN',
] as const;

/**
 * Environment variables required for PDF operations
 */
const PDF_OPERATION_VARS = [
  'PYTHON_VECTOR_API_URL',
] as const;

/**
 * Optional but recommended environment variables
 */
const RECOMMENDED_VARS = [
  'NEXTAUTH_SECRET',
  'NEXTAUTH_URL',
] as const;

/**
 * Validate all environment variables
 */
export function validateEnv(): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check required variables
  for (const varName of REQUIRED_VARS) {
    if (!process.env[varName]) {
      errors.push(`Missing required environment variable: ${varName}`);
    }
  }

  // Check PDF operation variables (warn but don't fail)
  for (const varName of PDF_OPERATION_VARS) {
    if (!process.env[varName]) {
      warnings.push(
        `Missing ${varName} - PDF rendering, tile generation, and vector extraction will be unavailable`
      );
    }
  }

  // Check recommended variables
  for (const varName of RECOMMENDED_VARS) {
    if (!process.env[varName]) {
      warnings.push(`Missing recommended environment variable: ${varName}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Log validation results and throw if invalid
 */
export function validateEnvOrThrow(): void {
  const result = validateEnv();

  // Log warnings
  for (const warning of result.warnings) {
    console.warn(`[ENV WARNING] ${warning}`);
  }

  // Throw on errors
  if (!result.valid) {
    for (const error of result.errors) {
      console.error(`[ENV ERROR] ${error}`);
    }
    throw new Error(
      `Environment validation failed:\n${result.errors.join('\n')}`
    );
  }
}

/**
 * Check if a specific feature is available based on env vars
 */
export const featureAvailability = {
  /**
   * Check if PDF rendering is available
   */
  pdfRendering(): boolean {
    return !!process.env.PYTHON_VECTOR_API_URL;
  },

  /**
   * Check if tile generation is available
   */
  tileGeneration(): boolean {
    return !!process.env.PYTHON_VECTOR_API_URL;
  },

  /**
   * Check if vector extraction is available
   */
  vectorExtraction(): boolean {
    return !!process.env.PYTHON_VECTOR_API_URL;
  },

  /**
   * Check if visual search is available
   */
  visualSearch(): boolean {
    return !!process.env.PYTHON_VECTOR_API_URL;
  },
};

/**
 * Get a summary of available features
 */
export function getFeatureSummary(): Record<string, boolean> {
  return {
    pdfRendering: featureAvailability.pdfRendering(),
    tileGeneration: featureAvailability.tileGeneration(),
    vectorExtraction: featureAvailability.vectorExtraction(),
    visualSearch: featureAvailability.visualSearch(),
  };
}
