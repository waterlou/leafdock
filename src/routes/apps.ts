import { Router, Request, Response } from 'express';
import * as apps from '../services/apps';
import { uploadMiddleware } from '../middleware/upload';

const router = Router();

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

// GET /api/v1/apps
router.get('/', (_req: Request, res: Response) => {
  try {
    const appsList = apps.listApps();
    res.json({ apps: appsList });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/v1/apps — JSON upload
router.post('/', async (req: Request, res: Response) => {
  try {
    const app = await apps.createApp(req.body);
    res.status(201).json(app);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/v1/apps/upload — zip upload
router.post('/upload', uploadMiddleware, async (req: Request, res: Response) => {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    if (!files?.file?.[0]) {
      res.status(400).json({ error: { code: 'validation_error', message: 'No zip file uploaded. Use form field "file".' } });
      return;
    }

    const config = req.body?.config
      ? JSON.parse(req.body.config)
      : {};

    if (!config.name || !config.type) {
      res.status(400).json({ error: { code: 'validation_error', message: 'Config must include "name" and "type".' } });
      return;
    }

    const app = await apps.createAppFromZip(
      config.name,
      config.type,
      files.file[0].path,
      config.config
    );
    res.status(201).json(app);
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/v1/apps/:name/upload — zip update
router.put('/:name/upload', uploadMiddleware, async (req: Request, res: Response) => {
  try {
    const name = param(req, 'name');
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    if (!files?.file?.[0]) {
      res.status(400).json({ error: { code: 'validation_error', message: 'No zip file uploaded. Use form field "file".' } });
      return;
    }

    let config: apps.AppConfig | undefined;
    if (req.body?.config) {
      const body = JSON.parse(req.body.config);
      config = body.config;
    }

    const app = await apps.updateAppFromZip(name, files.file[0].path, config);
    res.json(app);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/v1/apps/:name
router.get('/:name', (req: Request, res: Response) => {
  try {
    const name = param(req, 'name');
    const app = apps.getApp(name);
    if (!app) {
      res.status(404).json({
        error: { code: 'app_not_found', message: `No app named "${name}" exists.` },
      });
      return;
    }
    res.json(app);
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/v1/apps/:name
router.put('/:name', async (req: Request, res: Response) => {
  try {
    const name = param(req, 'name');
    if (req.body.name && req.body.name !== name) {
      res.status(400).json({
        error: { code: 'validation_error', message: 'Name in URL must match name in request body.' },
      });
      return;
    }

    const app = await apps.updateApp(name, req.body);
    res.json(app);
  } catch (err) {
    handleError(res, err);
  }
});

// PATCH /api/v1/apps/:name
router.patch('/:name', async (req: Request, res: Response) => {
  try {
    const app = await apps.updateApp(param(req, 'name'), req.body);
    res.json(app);
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE /api/v1/apps/:name
router.delete('/:name', async (req: Request, res: Response) => {
  try {
    await apps.deleteApp(param(req, 'name'));
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/v1/apps/:name/logs
router.get('/:name/logs', async (req: Request, res: Response) => {
  try {
    const tail = parseInt(req.query.tail as string) || 100;
    const logs = await apps.getLogs(param(req, 'name'), tail);
    res.json({ logs });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/v1/apps/:name/restart
router.post('/:name/restart', async (req: Request, res: Response) => {
  try {
    const app = await apps.restartApp(param(req, 'name'));
    res.json(app);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/v1/apps/:name/stop
router.post('/:name/stop', async (req: Request, res: Response) => {
  try {
    const app = await apps.stopApp(param(req, 'name'));
    res.json(app);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/v1/apps/:name/start
router.post('/:name/start', async (req: Request, res: Response) => {
  try {
    const app = await apps.startApp(param(req, 'name'));
    res.json(app);
  } catch (err) {
    handleError(res, err);
  }
});

function handleError(res: Response, err: unknown): void {
  if (err instanceof apps.ValidationError) {
    // Check if it's a "not found" or "already exists" style message
    if (err.message.includes('not found')) {
      res.status(404).json({
        error: { code: 'app_not_found', message: err.message },
      });
    } else if (err.message.includes('already exists') || err.message.includes('already in use')) {
      const code = err.message.includes('already in use') ? 'prefix_conflict' : 'app_already_exists';
      res.status(code === 'prefix_conflict' ? 400 : 409).json({
        error: { code, message: err.message },
      });
    } else {
      res.status(400).json({
        error: { code: 'validation_error', message: err.message },
      });
    }
    return;
  }

  console.error('Unexpected error:', err);
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'An unexpected error occurred.',
    },
  });
}

export default router;
