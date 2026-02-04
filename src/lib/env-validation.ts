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
  'DO_SPACES_BUCKET',
  'DO_SPACES_REGION',
  'DO_SPACES_ENDPOINT',
  'DO_SPACES_KEY',
  'DO_SPACES_SECRET',
] as const;

/**
 * Optional but recommended environment variables
 */
const RECOMMENDED_VARS = [
  'ANTHROPIC_API_KEY',
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
