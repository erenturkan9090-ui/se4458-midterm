/**
 * Gateway route table: the single source for which Billing API operations are published.
 * The same table drives the Azure API Management setup, so the local gateway and APIM
 * expose identical routes.
 *
 *   gateway:  {GATEWAY}/billing/v1/<path>   ->   backend: {API}/api/v1/<path>
 */
export const API_PREFIX = '/billing';
export const VERSION = 'v1';
export const BACKEND_PREFIX = '/api/v1';

export interface RouteDef {
  /** Operation id (also the APIM operation name). */
  id: string;
  method: 'GET' | 'POST';
  /** Path template relative to the version prefix, with {params}. */
  path: string;
  /** Protected routes need a valid Bearer JWT at the gateway before reaching the API. */
  protected: boolean;
  description: string;
}

export const ROUTES: RouteDef[] = [
  { id: 'login', method: 'POST', path: '/auth/login', protected: false, description: 'Get a JWT access token' },
  { id: 'add-usage', method: 'POST', path: '/usage', protected: true, description: 'Add Usage' },
  { id: 'calculate-bill', method: 'POST', path: '/bills/calculate', protected: true, description: 'Calculate Bill' },
  { id: 'query-bill', method: 'GET', path: '/bills/{subscriberNo}', protected: false, description: 'Query Bill' },
  {
    id: 'query-bill-detailed',
    method: 'GET',
    path: '/bills/{subscriberNo}/detailed',
    protected: true,
    description: 'Query Bill Detailed (paged)',
  },
  { id: 'pay-bill', method: 'POST', path: '/payments', protected: true, description: 'Pay Bill' },
];

interface CompiledRoute extends RouteDef {
  regex: RegExp;
}

const compiled: CompiledRoute[] = ROUTES.map((r) => ({
  ...r,
  // "/bills/{subscriberNo}" -> /^\/bills\/[^/]+$/ ; literal segments win over params ("calculate" vs "{subscriberNo}")
  regex: new RegExp('^' + r.path.replace(/\{[^}]+\}/g, '[^/]+').replace(/\//g, '\\/') + '\\/?$'),
}));

export type MatchResult =
  | { kind: 'match'; route: RouteDef }
  | { kind: 'method-not-allowed'; allow: string[] }
  | { kind: 'not-found' };

export function matchRoute(method: string, path: string): MatchResult {
  const candidates = compiled.filter((r) => r.regex.test(path));
  if (candidates.length === 0) return { kind: 'not-found' };
  // Prefer a literal path over a parameterised one when both match (e.g. POST /bills/calculate).
  const exact = candidates.find((r) => r.method === method && !r.path.includes('{'));
  const route = exact ?? candidates.find((r) => r.method === method);
  if (route) return { kind: 'match', route };
  return { kind: 'method-not-allowed', allow: [...new Set(candidates.map((r) => r.method))] };
}
