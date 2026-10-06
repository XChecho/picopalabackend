const REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET'] as const;

/**
 * Fails fast at boot when mandatory configuration is missing or unsafe,
 * instead of failing on the first request that needs it.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (config.JWT_SECRET === config.JWT_REFRESH_SECRET) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be different');
  }

  if (config.NODE_ENV === 'production') {
    const short = ['JWT_SECRET', 'JWT_REFRESH_SECRET'].filter(
      (key) => String(config[key]).length < 32,
    );
    if (short.length > 0) {
      throw new Error(`${short.join(', ')} must be at least 32 characters in production`);
    }
    if (!config.CORS_ORIGIN) {
      throw new Error('CORS_ORIGIN is required in production');
    }
  }

  return config;
}
