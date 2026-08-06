import { Router, Request, Response } from 'express';
import * as apps from '../services/apps';
import { handleError } from './apps';

const router = Router();

// PUT /api/v1/folders/* — set or clear a folder's display label.
// The label is metadata only: URLs and the disk layout keep using the slug
// path, and the landing page renders the label in place of the slug.
router.put('/*', async (req: Request, res: Response) => {
  try {
    const rawPath = (req.params as Record<string, string>)[0];
    if (!rawPath) {
      res.status(400).json({ error: { code: 'validation_error', message: 'Folder path is required.' } });
      return;
    }
    const folderPath = apps.validateFolder(rawPath);

    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : undefined;
    if (label === undefined) {
      res.status(400).json({ error: { code: 'validation_error', message: '"label" must be a string.' } });
      return;
    }
    if (/[\x00-\x1F\x7F]/.test(label)) {
      res.status(400).json({ error: { code: 'validation_error', message: '"label" must not contain control characters.' } });
      return;
    }
    if (label.length > 100) {
      res.status(400).json({ error: { code: 'validation_error', message: '"label" must be at most 100 characters.' } });
      return;
    }

    if (label === '') {
      apps.clearFolderLabel(folderPath);
    } else {
      apps.setFolderLabel(folderPath, label);
    }
    res.json({ path: folderPath, label });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
