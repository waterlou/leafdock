import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as apps from '../services/apps';
import { ComposePolicyError } from '../services/compose-validation';
import { uploadMiddleware } from '../middleware/upload';

const router = Router();

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

// GET /api/v1/apps
router.get('/', (_req: Request, res: Response) => {
  try {
    const appsList = apps.listApps();
    res.json({ apps: appsList, folder_labels: apps.listFolderLabels() });
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
  const files = req.files as { [fieldname: string]: Express.Multer.File[] };
  const zipPath = files?.file?.[0]?.path;
  try {
    if (!zipPath) {
      res.status(400).json({ error: { code: 'validation_error', message: 'No zip file uploaded. Use form field "file".' } });
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = req.body?.config ? JSON.parse(req.body.config) : {};
    } catch {
      res.status(400).json({ error: { code: 'validation_error', message: '"config" must be valid JSON.' } });
      return;
    }

    if (!config.name || !config.type) {
      res.status(400).json({ error: { code: 'validation_error', message: 'Config must include "name" and "type".' } });
      return;
    }

    if (config.folder !== undefined && typeof config.folder !== 'string') {
      res.status(400).json({ error: { code: 'validation_error', message: '"folder" must be a string.' } });
      return;
    }

    if (config.icon !== undefined && typeof config.icon !== 'string') {
      res.status(400).json({ error: { code: 'validation_error', message: '"icon" must be a string.' } });
      return;
    }

    const app = await apps.createAppFromZip(
      config.name as string,
      config.type as 'static' | 'docker' | 'docker-compose',
      zipPath,
      config.config as apps.AppConfig | undefined,
      config.folder as string | undefined,
      config.icon as string | undefined
    );
    res.status(201).json(app);
  } catch (err) {
    handleError(res, err);
  } finally {
    // Never leak the multer temp file, whatever happened above.
    if (zipPath) fs.rmSync(zipPath, { force: true });
  }
});

// POST /api/v1/apps/git — git clone create
router.post('/git', async (req: Request, res: Response) => {
  try {
    const { name, type, git, config, folder, icon } = req.body;

    if (!git || typeof git !== 'object' || Array.isArray(git)) {
      res.status(400).json({ error: { code: 'validation_error', message: '"git" is required' } });
      return;
    }
    if (typeof git.url !== 'string') {
      res.status(400).json({ error: { code: 'validation_error', message: '"git.url" must be a string.' } });
      return;
    }
    if (folder !== undefined && typeof folder !== 'string') {
      res.status(400).json({ error: { code: 'validation_error', message: '"folder" must be a string.' } });
      return;
    }
    if (icon !== undefined && typeof icon !== 'string') {
      res.status(400).json({ error: { code: 'validation_error', message: '"icon" must be a string.' } });
      return;
    }

    const app = await apps.createAppFromGit(name, type, git, config, folder, icon);
    res.status(201).json(app);
  } catch (err) {
    handleError(res, err);
  }
});

// PUT /api/v1/apps/:name/upload — zip update
router.put('/:name/upload', uploadMiddleware, async (req: Request, res: Response) => {
  const name = param(req, 'name');
  const files = req.files as { [fieldname: string]: Express.Multer.File[] };
  const zipPath = files?.file?.[0]?.path;
  try {
    if (!zipPath) {
      res.status(400).json({ error: { code: 'validation_error', message: 'No zip file uploaded. Use form field "file".' } });
      return;
    }

    let config: apps.AppConfig | undefined;
    let icon: string | undefined;
    if (req.body?.config) {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(req.body.config);
      } catch {
        res.status(400).json({ error: { code: 'validation_error', message: '"config" must be valid JSON.' } });
        return;
      }
      config = body.config as apps.AppConfig | undefined;
      icon = typeof body.icon === 'string' ? body.icon : undefined;
    }

    if (icon !== undefined && typeof icon !== 'string') {
      res.status(400).json({ error: { code: 'validation_error', message: '"icon" must be a string.' } });
      return;
    }

    const app = await apps.updateAppFromZip(name, zipPath, config, icon);
    res.json(app);
  } catch (err) {
    handleError(res, err);
  } finally {
    if (zipPath) fs.rmSync(zipPath, { force: true });
  }
});

// PUT /api/v1/apps/:name/git — git clone update (re-clone)
router.put('/:name/git', async (req: Request, res: Response) => {
  try {
    const name = param(req, 'name');
    const { git, config, icon } = req.body;

    if (!git || typeof git !== 'object' || Array.isArray(git)) {
      res.status(400).json({ error: { code: 'validation_error', message: '"git" is required' } });
      return;
    }
    if (typeof git.url !== 'string') {
      res.status(400).json({ error: { code: 'validation_error', message: '"git.url" must be a string.' } });
      return;
    }
    if (icon !== undefined && typeof icon !== 'string') {
      res.status(400).json({ error: { code: 'validation_error', message: '"icon" must be a string.' } });
      return;
    }

    const app = await apps.updateAppFromGit(name, git, config, icon);
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

// GET /api/v1/apps/:name/zip
router.get('/:name/zip', (req: Request, res: Response) => {
  try {
    const name = param(req, 'name');
    const buf = apps.downloadAppZip(name);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
    res.send(buf);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/v1/apps/:name/compose-check
router.get('/:name/compose-check', (req: Request, res: Response) => {
  try {
    res.json(apps.checkCompose(param(req, 'name')));
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/v1/apps/:name/logs
router.get('/:name/logs', async (req: Request, res: Response) => {
  try {
    const tail = Math.min(Math.max(parseInt(req.query.tail as string) || 100, 1), 10_000);
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

// POST /api/v1/apps/:name/move
router.post('/:name/move', async (req: Request, res: Response) => {
  try {
    const folder = req.body?.folder;
    if (typeof folder !== 'string') {
      res.status(400).json({
        error: { code: 'validation_error', message: 'folder is required' },
      });
      return;
    }
    const app = await apps.moveApp(param(req, 'name'), folder);
    res.json(app);
  } catch (err) {
    handleError(res, err);
  }
});

export function handleError(res: Response, err: unknown): void {
  // A compose file that fails the host-safety policy is a client error with a
  // list of concrete violations, not an internal failure.
  if (err instanceof ComposePolicyError) {
    res.status(400).json({
      error: { code: err.code, message: err.message, violations: err.violations },
    });
    return;
  }

  if (err instanceof apps.ValidationError) {
    if (err.code === 'app_not_found') {
      res.status(404).json({
        error: { code: 'app_not_found', message: err.message },
      });
    } else if (err.code === 'app_already_exists') {
      res.status(409).json({
        error: { code: 'app_already_exists', message: err.message },
      });
    } else {
      res.status(400).json({
        error: { code: err.code, message: err.message },
      });
    }
    return;
  }

  if (err instanceof apps.DockerError) {
    console.error('Docker operation failed:', err.message);
    res.status(500).json({
      error: { code: 'docker_error', message: err.message },
    });
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
