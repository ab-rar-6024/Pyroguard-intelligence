import 'dotenv/config';
import { createApp } from '../src/server/app.js';

// Vercel's Node.js runtime invokes the default export as a standard
// (req, res) request handler, which is exactly an Express app's signature.
export default createApp();
