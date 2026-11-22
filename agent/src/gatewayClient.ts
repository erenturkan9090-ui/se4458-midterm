/**
 * Billing REST API client. Every call goes to the API Gateway base URL, never
 * straight to the API service.
 */

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface Session {
  accessToken: string;
  username: string;
  role: 'SUBSCRIBER' | 'ADMIN';
  subscriberNo: string | null;
}

export interface HttpCall {
  method: string;
  path: string;
  status: number;
  ms: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Reads the (already server-signed) JWT payload. No signature check is needed client-side. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('Malformed access token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export class GatewayClient {
  /** Last HTTP call, so the tool trace can show method, path and status. */
  lastCall: HttpCall | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly subscriptionKey?: string,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
  ) {}

  private async request<T>(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (this.subscriptionKey) headers['Ocp-Apim-Subscription-Key'] = this.subscriptionKey;

    const started = Date.now();
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      // 45 s: an idle App Service F1 app can take 20-30 s to wake up on the first request.
      signal: AbortSignal.timeout(45_000),
    });
    this.lastCall = { method, path, status: res.status, ms: Date.now() - started };

    const text = await res.text();
    let data: any = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new GatewayError(
        res.status,
        err.code ?? `HTTP_${res.status}`,
        err.message ?? data?.message ?? res.statusText ?? 'Request failed',
        err.details,
      );
    }
    return data as T;
  }

  async login(username: string, password: string): Promise<Session> {
    const r = await this.request<{ accessToken: string }>('POST', '/auth/login', {
      body: { username, password },
    });
    const claims = decodeJwtPayload(r.accessToken);
    return {
      accessToken: r.accessToken,
      username: String(claims.sub ?? claims.username ?? username),
      role: claims.role === 'ADMIN' ? 'ADMIN' : 'SUBSCRIBER',
      subscriberNo: (claims.sno as string | null | undefined) ?? null,
    };
  }

  queryBill(subscriberNo: string, year: number, month: number) {
    return this.request<Record<string, unknown>>(
      'GET',
      `/bills/${encodeURIComponent(subscriberNo)}?year=${year}&month=${month}`,
    );
  }

  queryBillDetailed(token: string, subscriberNo: string, year: number, month: number, page = 1, pageSize = 20) {
    return this.request<Record<string, unknown>>(
      'GET',
      `/bills/${encodeURIComponent(subscriberNo)}/detailed?year=${year}&month=${month}&page=${page}&pageSize=${pageSize}`,
      { token },
    );
  }

  payBill(token: string, body: { subscriberNo: string; year: number; month: number; amount: number; transactionId: string }) {
    return this.request<Record<string, unknown>>('POST', '/payments', { token, body });
  }
}
