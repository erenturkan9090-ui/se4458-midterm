/**
 * Local API Gateway. Behaves like the Azure API Management instance:
 * - only the operations in the route table are published, under /billing/v1
 * - optional subscription key (Ocp-Apim-Subscription-Key), stripped before forwarding
 * - protected operations: Bearer JWT validated at the gateway (validate-jwt)
 * - rate limit per subscription key / client IP (429 + Retry-After)
 * - gateway errors use the API's error shape plus "source": "gateway"
 * - upstream down -> 502, upstream timeout -> 504
 */
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { API_PREFIX, BACKEND_PREFIX, matchRoute, ROUTES, VERSION, type RouteDef } from './routes';

export interface GatewayOptions {
  /** Backend origin, e.g. http://localhost:3000 */
  upstream: string;
  /** If set, every request must carry this key in Ocp-Apim-Subscription-Key. */
  subscriptionKey?: string;
  /** If set, protected routes verify the JWT signature (HS256, issuer billing-api, audience billing-clients). */
  jwtSecret?: string;
  rateLimit?: { limit: number; windowMs: number };
  upstreamTimeoutMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding',
]);

type GatewayErrorCode =
  | 'ROUTE_NOT_FOUND' | 'METHOD_NOT_ALLOWED' | 'UNAUTHORIZED' | 'SUBSCRIPTION_KEY_INVALID'
  | 'RATE_LIMITED' | 'BAD_GATEWAY' | 'GATEWAY_TIMEOUT';

function gatewayError(res: Response, status: number, code: GatewayErrorCode, message: string) {
  res.status(status).json({ error: { code, message, source: 'gateway' } });
}

export function createGateway(opts: GatewayOptions) {
  const app = express();
  const base = `${API_PREFIX}/${VERSION}`;
  const upstream = opts.upstream.replace(/\/+$/, '');
  const limit = opts.rateLimit ?? { limit: 100, windowMs: 60_000 };
  const windows = new Map<string, { start: number; count: number }>();
  const log = opts.log ?? ((e) => console.log(JSON.stringify(e)));

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // Request id + access log for every call.
  app.use((req, res, next) => {
    const id = req.header('x-request-id') ?? randomUUID();
    const started = Date.now();
    res.setHeader('x-request-id', id);
    res.locals.requestId = id;
    res.on('finish', () =>
      log({
        ts: new Date().toISOString(),
        requestId: id,
        method: req.method,
        path: req.originalUrl,
        route: res.locals.routeId ?? null,
        status: res.statusCode,
        ms: Date.now() - started,
      }),
    );
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', gateway: 'local', basePath: base, routes: ROUTES.length });
  });

  // Published route list (what APIM shows in its developer portal).
  app.get(`${base}/_routes`, (_req, res) => {
    res.json(ROUTES.map((r) => ({ ...r, path: `${base}${r.path}` })));
  });

  app.use(base, express.raw({ type: '*/*', limit: '1mb' }));

  app.use(base, (req: Request, res: Response, next: NextFunction) => {
    // 1. Subscription key (APIM product subscription)
    if (opts.subscriptionKey && req.header('ocp-apim-subscription-key') !== opts.subscriptionKey) {
      return gatewayError(res, 401, 'SUBSCRIPTION_KEY_INVALID', 'Access denied: missing or invalid subscription key.');
    }

    // 2. Route table
    const m = matchRoute(req.method, req.path);
    if (m.kind === 'not-found') {
      return gatewayError(res, 404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${base}${req.path}`);
    }
    if (m.kind === 'method-not-allowed') {
      res.setHeader('Allow', m.allow.join(', '));
      return gatewayError(res, 405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on ${base}${req.path}`);
    }
    res.locals.routeId = m.route.id;

    // 3. Rate limit (fixed window per subscription key or client IP)
    const key = req.header('ocp-apim-subscription-key') ?? req.ip ?? 'anonymous';
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.start >= limit.windowMs) {
      windows.set(key, { start: now, count: 1 });
    } else if (++w.count > limit.limit) {
      res.setHeader('Retry-After', String(Math.ceil((w.start + limit.windowMs - now) / 1000)));
      return gatewayError(res, 429, 'RATE_LIMITED', `Rate limit exceeded: ${limit.limit} calls per ${limit.windowMs / 1000}s.`);
    }

    // 4. JWT validation for protected operations
    if (m.route.protected && !validJwt(req, opts.jwtSecret)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return gatewayError(res, 401, 'UNAUTHORIZED', 'A valid Bearer token is required for this operation.');
    }

    void forward(req, res, m.route).catch(next);
  });

  async function forward(req: Request, res: Response, route: RouteDef) {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const target = `${upstream}${BACKEND_PREFIX}${req.path}${query}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || k === 'ocp-apim-subscription-key') continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    headers.set('x-request-id', res.locals.requestId);
    headers.set('x-forwarded-for', req.ip ?? '');
    headers.set('x-forwarded-prefix', `${API_PREFIX}/${VERSION}`);
    headers.set('x-gateway-route', route.id);

    const body = req.method === 'GET' || req.method === 'HEAD' || !Buffer.isBuffer(req.body) || req.body.length === 0
      ? undefined
      : new Uint8Array(req.body);

    let upstreamRes: globalThis.Response;
    try {
      upstreamRes = await fetch(target, {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.upstreamTimeoutMs ?? 15_000),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return timeout
        ? gatewayError(res, 504, 'GATEWAY_TIMEOUT', 'The billing service did not respond in time.')
        : gatewayError(res, 502, 'BAD_GATEWAY', 'The billing service is unavailable.');
    }

    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name)) res.setHeader(name, value);
    });
    res.setHeader('x-gateway', 'local');
    res.send(Buffer.from(await upstreamRes.arrayBuffer()));
  }

  // Anything outside /billing/v1 (e.g. /billing/v2/..., /api/v1/... directly) is not published.
  app.use((req, res) => {
    gatewayError(res, 404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`);
  });

  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large', source: 'gateway' } });
    }
    console.error('gateway error', err);
    return gatewayError(res, 502, 'BAD_GATEWAY', 'Gateway failed to forward the request.');
  });

  return app;
}

function validJwt(req: Request, secret?: string): boolean {
  const m = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
  if (!m) return false;
  if (!secret) return m[1].split('.').length === 3; // presence/shape check only; the API verifies the signature
  try {
    jwt.verify(m[1], secret, { algorithms: ['HS256'], issuer: 'billing-api', audience: 'billing-clients' });
    return true;
  } catch {
    return false;
  }
}
