import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../domain/errors';
import { verifyToken, type Principal } from './jwt';

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}

export function requireAuth(secret: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return next(new ApiError('UNAUTHORIZED', 'Missing or malformed Bearer token'));
    }
    try {
      req.principal = verifyToken(token, secret);
      next();
    } catch {
      next(new ApiError('UNAUTHORIZED', 'Invalid or expired token'));
    }
  };
}

/**
 * Object-level authorization: a subscriber may only touch their own subscriber number;
 * admins may act on any subscriber. This is what stops the AI agent from reading another
 * user's data just because a different number appeared in the prompt.
 */
export function assertCanAccess(principal: Principal | undefined, subscriberNo: string): void {
  if (!principal) throw new ApiError('UNAUTHORIZED', 'Authentication required');
  if (principal.role === 'ADMIN') return;
  if (principal.subscriberNo !== subscriberNo) {
    throw new ApiError('FORBIDDEN', 'You can only access your own subscriber account');
  }
}
