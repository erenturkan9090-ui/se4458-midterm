import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { ApiError } from './domain/errors';
import type { BillingRepository } from './repo/types';
import { v1Router } from './routes/v1';
import { BillingService } from './services/billingService';

export interface AppOptions {
  repo: BillingRepository;
  jwtSecret: string;
}

export function createApp({ repo, jwtSecret }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const service = new BillingService(repo, jwtSecret);

  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8'));
  app.get('/openapi.json', (_req, res) => res.json(spec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Versioned API. A future breaking change would be mounted at /api/v2.
  app.use('/api/v1', v1Router(service, jwtSecret));

  app.use((_req, _res, next) => next(new ApiError('NOT_FOUND', 'Route not found')));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
    }
    // Postgres unique violation on payments PK (race between two identical transaction IDs)
    if ((err as { code?: string })?.code === '23505') {
      return res.status(409).json({ error: { code: 'DUPLICATE_TRANSACTION', message: 'Transaction ID already processed' } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } });
  });

  return app;
}
