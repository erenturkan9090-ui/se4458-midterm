import jwt from 'jsonwebtoken';
import type { Role } from '../domain/types';

export interface Principal {
  username: string;
  role: Role;
  /** Set for SUBSCRIBER tokens: the only subscriber whose data this caller may access. */
  subscriberNo: string | null;
}

const ISSUER = 'billing-api';
const AUDIENCE = 'billing-clients';

export function signToken(p: Principal, secret: string, expiresInSeconds = 3600): string {
  return jwt.sign({ role: p.role, sno: p.subscriberNo }, secret, {
    subject: p.username,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: expiresInSeconds,
    algorithm: 'HS256',
  });
}

export function verifyToken(token: string, secret: string): Principal {
  const c = jwt.verify(token, secret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] }) as jwt.JwtPayload;
  if (typeof c.sub !== 'string' || (c.role !== 'SUBSCRIBER' && c.role !== 'ADMIN')) {
    throw new Error('invalid claims');
  }
  return { username: c.sub, role: c.role, subscriberNo: c.sno ?? null };
}
