import { NextResponse } from 'next/server';
import { db } from '@/db';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  checks: {
    database: { status: 'ok' | 'error'; latencyMs?: number; error?: string };
    pythonService?: { status: 'ok' | 'error'; latencyMs?: number; error?: string };
  };
}

// GET /api/health - Health check endpoint
export async function GET() {
  const startTime = Date.now();
  const checks: HealthStatus['checks'] = {
    database: { status: 'error' },
  };

  let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

  // Check database
  try {
    const dbStart = Date.now();
    await db.execute(sql`SELECT 1`);
    checks.database = {
      status: 'ok',
      latencyMs: Date.now() - dbStart,
    };
  } catch (error) {
    checks.database = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
    overallStatus = 'unhealthy';
  }

  // Check Python service (optional - degraded if down, not unhealthy)
  const pythonServiceUrl = process.env.PYTHON_VECTOR_API_URL;
  if (pythonServiceUrl) {
    try {
      const pyStart = Date.now();
      const response = await fetch(`${pythonServiceUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        checks.pythonService = {
          status: 'ok',
          latencyMs: Date.now() - pyStart,
        };
      } else {
        checks.pythonService = {
          status: 'error',
          error: `HTTP ${response.status}`,
        };
        if (overallStatus === 'healthy') overallStatus = 'degraded';
      }
    } catch (error) {
      checks.pythonService = {
        status: 'error',
        error: error instanceof Error ? error.message : 'Connection failed',
      };
      if (overallStatus === 'healthy') overallStatus = 'degraded';
    }
  }

  const healthStatus: HealthStatus = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '0.1.0',
    checks,
  };

  const statusCode = overallStatus === 'unhealthy' ? 503 : 200;

  return NextResponse.json(healthStatus, { status: statusCode });
}
