import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { uploadSingle, uploadTicketFiles } from '../middleware/upload.js';

const router = Router();

// Single-image upload (event banners / gallery images). Files are written to
// the local uploads dir and served back under /uploads. An absolute URL is
// returned so the wizard can store it directly on the event.
router.post('/image', authenticate, uploadSingle('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file received' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.status(201).json({ url: `${base}/uploads/${req.file.filename}` });
});

// Batch ticket files upload (pre-generated PDF or image passes).
router.post('/tickets', authenticate, (req, res) => {
  uploadTicketFiles('files')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message || 'File upload failed' });
    }
    const files = req.files || (req.file ? [req.file] : []);
    if (!files.length) {
      return res.status(400).json({ message: 'No ticket files received' });
    }
    const base = `${req.protocol}://${req.get('host')}`;
    const fileList = files.map((f) => ({
      file_url: `${base}/uploads/${f.filename}`,
      url: `${base}/uploads/${f.filename}`,
      file_name: f.originalname,
      originalName: f.originalname,
      size: f.size,
      mimetype: f.mimetype,
    }));
    res.status(201).json({ files: fileList, count: fileList.length });
  });
});

export default router;
