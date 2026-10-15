import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

// The API key is the single credential guarding docker.sock — root-equivalent
// on the host. No silent defaults: a missing or placeholder key is a startup
// error, not a running risk.
const API_KEY = process.env.MANAGEMENT_API_KEY || '';

export function assertApiKeyConfigured(): void {
  if (!API_KEY || API_KEY === 'change-me') {
    throw new Error(
      'MANAGEMENT_API_KEY must be set to a random secret (the default "change-me" is not accepted). ' +
      'Set it in the environment or .env before starting.'
    );
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// In-memory per-IP throttle on failed auth: slow down brute force without
// touching legitimate traffic. Entries expire after the window, so the map
// stays bounded by (attack rate × window), not by total history.
const FAIL_WINDOW_MS = 60_000;
const MAX_FAILS_PER_WINDOW = 30;
const failCounts = new Map<string, { count: number; resetAt: number }>();

function tooManyFails(ip: string): boolean {
  const now = Date.now();
  const entry = failCounts.get(ip);
  if (!entry || entry.resetAt <= now) {
    failCounts.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_FAILS_PER_WINDOW;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Missing or invalid Authorization header. Use: Bearer <api-key>',
      },
    });
    return;
  }

  const token = authHeader.slice(7);

  if (!safeEqual(token, API_KEY)) {
    const ip = req.ip || 'unknown';
    if (tooManyFails(ip)) {
      res.status(429).json({
        error: {
          code: 'rate_limited',
          message: 'Too many failed authentication attempts. Try again later.',
        },
      });
      return;
    }
    res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Invalid API key.',
      },
    });
    return;
  }

  next();
}
