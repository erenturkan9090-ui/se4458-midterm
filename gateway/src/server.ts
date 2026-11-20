import { createGateway } from './app';
import { API_PREFIX, VERSION } from './routes';

const port = Number(process.env.PORT ?? 8000);
const app = createGateway({
  upstream: process.env.UPSTREAM_URL ?? 'http://localhost:3000',
  subscriptionKey: process.env.GATEWAY_SUBSCRIPTION_KEY || undefined,
  jwtSecret: process.env.JWT_SECRET || undefined,
  rateLimit: {
    limit: Number(process.env.RATE_LIMIT ?? 100),
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  },
});

app.listen(port, () => {
  console.log(`Gateway listening on http://localhost:${port}${API_PREFIX}/${VERSION}`);
});
