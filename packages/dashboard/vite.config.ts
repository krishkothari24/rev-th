import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Port 5173 is the default, made explicit here because config.ts's
// DASHBOARD_ORIGIN default (backend CORS) is hardcoded to
// http://localhost:5173 — this keeps the two in sync on purpose.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
});
