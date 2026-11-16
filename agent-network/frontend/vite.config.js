import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the UI runs on :5173 and proxies API calls to the backend on :4000.
// In production the backend serves the built files itself, so there is no proxy and no CORS.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
});
