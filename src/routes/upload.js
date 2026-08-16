import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { uploadSingle } from '../middleware/upload.js';

const router = Router();

// Single-image upload (event banners / gallery images). Files are written to
// the local uploads dir and served back under /uploads. An absolute URL is
// returned so the wizard can store it directly on the event.
router.post('/image', authenticate, uploadSingle('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file received' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.status(201).json({ url: `${base}/uploads/${req.file.filename}` });
});

export default router;
