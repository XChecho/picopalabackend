import { timingSafeEqual } from 'crypto';
import { isIP } from 'net';

export const BFF_KEY_HEADER = 'x-bff-key';
export const CLIENT_IP_HEADER = 'x-client-ip';

/** Minimal request shape (works for Express requests and test doubles). */
export interface IClientIpRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const headerValue = (
  headers: IClientIpRequest['headers'],
  name: string,
): string | undefined => {
  const value = headers?.[name];
  return typeof value === 'string' ? value : undefined;
};

/** Timing-safe string comparison; different lengths never match. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Real client IP. X-Client-IP is honoured ONLY when X-BFF-Key matches the shared secret
 * (the web BFF sits in front of the API, so req.ip would be the BFF's address) and the
 * value is a valid IP. Otherwise falls back to req.ip.
 */
export function getClientIp(
  req: IClientIpRequest,
  bffSecret: string | undefined = process.env.BFF_SHARED_SECRET,
): string {
  const key = headerValue(req.headers, BFF_KEY_HEADER);
  const forwarded = headerValue(req.headers, CLIENT_IP_HEADER)?.trim();
  if (
    bffSecret &&
    key !== undefined &&
    forwarded &&
    isIP(forwarded) !== 0 &&
    safeEqual(key, bffSecret)
  ) {
    return forwarded;
  }
  return req.ip ?? '';
}
