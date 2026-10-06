const DEFAULT_CORS_ORIGINS = ["http://localhost:8081"];

type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;

/**
 * Parses a comma-separated list of origins (CORS_ORIGIN) into a clean array.
 * Falls back to the local Expo web origin when the variable is empty/unset.
 */
export function parseCorsOrigins(
  raw: string | undefined = process.env.CORS_ORIGIN,
): string[] {
  const origins = (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return origins.length > 0 ? origins : [...DEFAULT_CORS_ORIGINS];
}

/**
 * Origin resolver evaluated per request. Reading CORS_ORIGIN lazily avoids
 * depending on whether .env was loaded before decorators were evaluated.
 * Requests without an Origin header (native clients) are allowed because CORS
 * is a browser-only mechanism.
 */
export function corsOriginResolver(
  requestOrigin: string | undefined,
  callback: CorsOriginCallback,
): void {
  if (!requestOrigin) {
    callback(null, true);
    return;
  }
  const allowed = parseCorsOrigins();
  callback(null, allowed.includes("*") || allowed.includes(requestOrigin));
}
