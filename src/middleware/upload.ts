import multer from 'multer';
import path from 'path';
import os from 'os';

const upload = multer({
  dest: path.join(os.tmpdir(), 'leafdock-uploads'),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max
  },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'file' && !file.originalname.endsWith('.zip')) {
      cb(new Error('Only .zip files are accepted'));
      return;
    }
    cb(null, true);
  },
});

export const uploadMiddleware = upload.fields([
  { name: 'file', maxCount: 1 },
]);
