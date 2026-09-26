import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const localSvs = fileURLToPath(new URL('../Scanline-Virtual-Screen/dist', import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: command === 'serve' && existsSync(localSvs) ? { alias: { 'scanline-virtual-screen': localSvs } } : undefined,
  build: { assetsInlineLimit: 0 },
}));
