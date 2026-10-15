// Bundles each Lambda handler into a single ESM file with esbuild.
// Output: backend/dist/<function>/index.mjs  (SAM CodeUri points at these folders)
import { build } from 'esbuild';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const functions = ['api', 'worker', 'authorizer'];

await rm(path.join(root, 'dist'), { recursive: true, force: true });

for (const fn of functions) {
  const outdir = path.join(root, 'dist', fn);
  await mkdir(outdir, { recursive: true });
  const result = await build({
    entryPoints: [path.join(root, 'src', 'handlers', `${fn}.ts`)],
    outfile: path.join(outdir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    sourcemap: 'linked',
    metafile: true,
    // Some CommonJS dependencies call require(); give ESM bundles a working require.
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  });
  // Tell Node in Lambda that index.mjs is ESM (the extension already does; package.json documents it).
  await writeFile(path.join(outdir, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
  const bytes = Object.values(result.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
  console.log(`built ${fn.padEnd(10)} ${(bytes / 1024).toFixed(0)} KiB`);
}
