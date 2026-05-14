import { Request, Response, NextFunction } from 'express';

const API_KEY = process.env.MANAGEMENT_API_KEY || 'change-me';

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

  if (token !== API_KEY) {
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
