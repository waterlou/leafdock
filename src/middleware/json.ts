import { Request, Response, NextFunction } from 'express';

// Common AI-client JSON mistakes: single-quoted strings, unquoted keys,
// trailing commas. Best-effort repair used only when strict JSON.parse fails;
// anything it can't fix still yields a clean validation_error.
export function repairJsonish(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  let inString = false;

  const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isIdentChar = (c: string) => /[A-Za-z0-9_$-]/.test(c);

  while (i < n) {
    const c = input[i];

    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < n) { out += input[i + 1]; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
      continue;
    }

    if (c === '"') { inString = true; out += c; i++; continue; }

    if (c === "'") {
      // Single-quoted string -> double-quoted. \' becomes ' (invalid JSON
      // escape otherwise); \\ and other escapes pass through.
      out += '"';
      i++;
      while (i < n) {
        const d = input[i];
        if (d === '\\' && i + 1 < n) {
          const e = input[i + 1];
          out += e === "'" ? "'" : '\\' + e;
          i += 2;
          continue;
        }
        if (d === "'") { out += '"'; i++; break; }
        out += d;
        i++;
      }
      continue;
    }

    // Trailing comma before } or ]
    if (c === ',' && (input[i + 1] === '}' || input[i + 1] === ']')) {
      i++;
      continue;
    }

    // Unquoted key at object-key position (after { or ,): {key: -> {"key":
    if (isIdentStart(c) && (/\{\s*$/.test(out) || /,\s*$/.test(out))) {
      let j = i;
      while (j < n && isIdentChar(input[j])) j++;
      let k = j;
      while (k < n && /\s/.test(input[k])) k++;
      if (input[k] === ':') {
        out += '"' + input.slice(i, j) + '"';
        i = j;
        continue;
      }
    }

    out += c;
    i++;
  }
  return out;
}

// Replaces body-parser's error path: strict parse first (express.json), and
// when it fails with entity.parse.failed, repair the raw body once and resume
// the request with the repaired object. If repair fails too, answer 400 with
// the documented error shape instead of Express's HTML error page.
export function jsonErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (
    typeof err === 'object' && err !== null &&
    'type' in err && err.type === 'entity.parse.failed' &&
    'body' in err && typeof err.body === 'string'
  ) {
    try {
      req.body = JSON.parse(repairJsonish(err.body));
      console.warn('Repaired malformed JSON request body:', JSON.stringify(err.body.slice(0, 200)));
      next();
      return;
    } catch {
      // fall through to the clean 400 below
    }
  }
  res.status(400).json({
    error: {
      code: 'validation_error',
      message: `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    },
  });
}
