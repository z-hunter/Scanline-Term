import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

describe('Vite SVS development resolution', () => {
  let server: ViteDevServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('serves the installed SVS package with the Lua palette registry API', async () => {
    server = await createServer({
      configFile: './vite.config.ts',
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true },
      watch: null,
    });
    expect(server.config.optimizeDeps.entries).toEqual(['index.html']);
    const settingsPath = path.resolve('src/crt/settings.ts');
    const resolved = await server.pluginContainer.resolveId('scanline-virtual-screen/core', settingsPath);
    const resolvedPath = resolved!.id.split('?')[0];
    const packageRoot = path.resolve('node_modules/scanline-virtual-screen');
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const packagePath = path.resolve(packageRoot, packageJson.exports['./core'].import);

    expect(realpathSync(resolvedPath)).toBe(realpathSync(packagePath));
    const core = await import(pathToFileURL(resolvedPath).href);
    expect(core.getCustomColorProfiles).toEqual(expect.any(Function));
    expect(core.replaceCustomColorProfiles).toEqual(expect.any(Function));
  });
});
