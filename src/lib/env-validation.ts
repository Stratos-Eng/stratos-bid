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
  // Add non-secret quality-of-life vars here if needed.
] as const;

/**
 * Validate all environment variables
 */
export function validateEnv(): EnvValidationResult {
  // Next.js evaluates some server modules during `next build`.
  // In Docker builds (e.g. DigitalOcean App Platform), runtime secrets may not be present
  // in the build environment. Don't fail builds on missing runtime env vars.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return { valid: true, errors: [], warnings: [] };
  }

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

  // Special case: we require at least one inference credential set.
  // Supported options today:
  // - OpenClaw (preferred for Stratos): OPENCLAW_INFERENCE_URL + OPENCLAW_API_KEY
  // - Direct Anthropic: ANTHROPIC_API_KEY
  // - Legacy gateway mode: INFERENCE_API_KEY (+ INFERENCE_BASE_URL)
  const hasOpenClaw = Boolean(process.env.OPENCLAW_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasLegacyGateway = Boolean(process.env.INFERENCE_API_KEY);

  if (!hasOpenClaw && !hasAnthropic && !hasLegacyGateway) {
    warnings.push(
      'Missing inference credentials: set OPENCLAW_API_KEY (preferred) or ANTHROPIC_API_KEY or INFERENCE_API_KEY'
    );
  }

  // If OpenClaw is configured, Anthropic/legacy gateway keys are not expected.
  if (hasOpenClaw) {
    // Remove noisy warnings that don't apply when using OpenClaw.
    for (let i = warnings.length - 1; i >= 0; i--) {
      if (warnings[i].includes('ANTHROPIC_API_KEY') || warnings[i].includes('INFERENCE_API_KEY')) {
        warnings.splice(i, 1);
      }
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
