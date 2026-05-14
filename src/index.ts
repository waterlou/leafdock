import express from 'express';
import cors from 'cors';
import { initDb } from './db';
import { authMiddleware } from './middleware/auth';
import healthRouter from './routes/health';
import appsRouter from './routes/apps';

const PORT = parseInt(process.env.PORT || '3001', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';

async function main() {
  await initDb(DATA_DIR);

  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // Health check — no auth
  app.use('/api/v1/health', healthRouter);

  // Management API — auth required
  app.use('/api/v1/apps', authMiddleware, appsRouter);

  app.listen(PORT, () => {
    console.log(`Management API listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
