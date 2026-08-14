/**
 * dsh-vision build script.
 *
 * Emits the single host-half artifact the DSH loader expects:
 * - lib/index.js   host half, ESM (external @deepseek-ai/*; the profile's
 *                  node_modules resolves them at runtime)
 *
 * Build with:  node scripts/build.mjs   (or npm run build)
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  external: ['@deepseek-ai/*'],
  sourcemap: true,
  logLevel: 'info',
})

console.log('dsh-vision: lib/index.js built')
