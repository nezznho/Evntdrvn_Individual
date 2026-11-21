import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Where each module runs. Set these in mediflow-gateway/.env when a module is on another device,
// e.g. POS_URL=http://192.168.1.20:3001
const KIOSK_URL = process.env.KIOSK_URL || 'http://localhost:3004';
const POS_URL = process.env.POS_URL || 'http://localhost:3001';
const INVENTORY_URL = process.env.INVENTORY_URL || 'http://localhost:3002';
const AUDIT_URL = process.env.AUDIT_URL || 'http://localhost:3003';

// Enable CORS for frontend clients
app.use(cors({
  origin: true,
  credentials: true
}));

// 1. Route Kiosk Traffic (Port 3004)
app.use(['/kiosk', '/api/kiosk'], createProxyMiddleware({
  target: KIOSK_URL,
  changeOrigin: true,
}));

// 2. Route POS / Sales Traffic (Port 3001)
app.use(['/transactions', '/api/sales', '/pos'], createProxyMiddleware({
  target: POS_URL,
  changeOrigin: true,
}));

// 3. Route Inventory Traffic (Port 3002)
app.use(['/inventory', '/api/inventory', '/products', '/suppliers'], createProxyMiddleware({
  target: INVENTORY_URL,
  changeOrigin: true,
}));

// 4. Route Audit Trail / Activity Traffic (Port 3003)
app.use(['/activity', '/api/activity', '/audit'], createProxyMiddleware({
  target: AUDIT_URL,
  changeOrigin: true,
}));

// Fallback for default root or login (pointing to POS or main module on 3001)
app.use('/', createProxyMiddleware({
  target: INVENTORY_URL,
  changeOrigin: true,
}));

app.listen(PORT, () => {
  console.log(`MediFlow API Gateway running on http://localhost:${PORT}`);
});