// Точка входа для Vercel: GET /api/health
import { handleHealth } from '../lib/ai.js';

export default function handler(req, res) {
  return handleHealth(req, res);
}
