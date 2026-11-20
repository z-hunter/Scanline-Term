import { resolve } from 'node:path';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => {
  const experiment = command === 'serve' ? process.env.SCANLINE_SVS_EXPERIMENT : undefined;
  const textureStream = command === 'serve' && Boolean(process.env.SCANLINE_BROWSER_TEXTURE_STREAM_DLL);
  return {
    plugins: [react()],
    optimizeDeps: { entries: ['index.html'] },
    build: { assetsInlineLimit: 0 },
    ...(experiment && {
      resolve: {
        alias: {
          'scanline-virtual-screen/core': resolve(experiment, 'src/core/index.ts'),
          'scanline-virtual-screen/terminal': resolve(experiment, 'src/terminal/index.ts'),
          'scanline-virtual-screen/react/styles.css': resolve(experiment, 'src/react/styles.css'),
          'scanline-virtual-screen/react': resolve(experiment, 'src/react/index.ts'),
        },
        dedupe: ['react', '@xterm/xterm'],
      },
    }),
    ...((experiment || textureStream) && {
      server: {
        ...(experiment && { fs: { allow: [searchForWorkspaceRoot(process.cwd()), resolve(experiment)] } }),
        watch: null,
      },
    }),
  };
});
