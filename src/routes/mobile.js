import express from 'express';
import { getPublicMobileConfig } from '../controllers/adminController.js';

const router = express.Router();

// GET /api/mobile/config - Public configuration endpoint for mobile app
router.get('/config', getPublicMobileConfig);

export default router;
