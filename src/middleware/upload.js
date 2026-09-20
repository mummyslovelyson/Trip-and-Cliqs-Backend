import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// Directory where uploaded files are temporarily stored before being pushed to Cloudinary.
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

// Ensure the upload directory exists.
const ensureUploadDir = () => {
  const abs = path.resolve(UPLOAD_DIR);
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(abs, { recursive: true });
  }
};
ensureUploadDir();

// Disk storage with a randomised filename to avoid collisions.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = crypto.randomBytes(16).toString('hex');
    cb(null, `${base}${ext}`);
  },
});

// Only allow image uploads.
const fileFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|gif|webp/;
  const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
  const mimeOk = allowed.test(file.mimetype);
  if (extOk && mimeOk) {
    return cb(null, true);
  }
  return cb(new Error('Only image files (jpeg, jpg, png, gif, webp) are allowed'));
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
});

// File filter specifically for pre-generated tickets (allows PDF documents and pass images)
const ticketFileFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|gif|webp|pdf/;
  const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
  const mimeOk = allowed.test(file.mimetype) || file.mimetype === 'application/pdf';
  if (extOk && mimeOk) {
    return cb(null, true);
  }
  return cb(new Error('Only ticket documents (PDF) and images (JPEG, PNG, WebP) are allowed'));
};

export const ticketUpload = multer({
  storage,
  fileFilter: ticketFileFilter,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB per ticket file
});

// Convenience single-file and multi-file uploaders.
export const uploadSingle = (fieldName) => upload.single(fieldName);
export const uploadArray = (fieldName, maxCount = 8) => upload.array(fieldName, maxCount);
export const uploadTicketFiles = (fieldName = 'files', maxCount = 200) => ticketUpload.array(fieldName, maxCount);
export const uploadFields = (fields) => upload.fields(fields);

export default upload;
