// Точка входа для Vercel: POST /api/chat
import { handleChat } from '../lib/ai.js';

export default async function handler(req, res) {
  return handleChat(req, res);
}
