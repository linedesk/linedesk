// Bundles the API server and the migration runner into apps/api/dist for the api image (Dockerfile, `api-bundle`):
// Node then loads a few dozen files at start instead of about 2,650 modules (LIN-526). Dev mode and the tests run the
// sources; so do the command-line scripts in the image (`node apps/api/src/setup-code.ts`).
//   node apps/api/scripts/bundle.ts           build apps/api/dist
//   node apps/api/scripts/bundle.ts --check   check that the files the bundle points at are in the image
//                                             (scripts/node-bundle.mts, checkBundle())
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBundle, keepImportMetaUrl, keepOwnMappingsIn } from '../../../scripts/node-bundle.mts'

const root = fileURLToPath(new URL('..', import.meta.url))
const outdir = path.join(root, 'dist')

async function bundle() {
  const { build } = await import('esbuild')
  await build({
    entryPoints: {
      server: path.join(root, 'src/server.ts'),
      migrate: path.join(root, '../../packages/db/src/migrate.ts'),
    },
    outdir,
    bundle: true,
    splitting: true, // the server's dynamic imports stay separate files, loaded when the server imports them
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    // Error stacks point at the sources (the entrypoint runs node with --enable-source-maps).
    sourcemap: true,
    sourcesContent: false,
    // CommonJS dependencies call require(); an ES module has none of its own.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    external: ['pg-native'], // optional in pg, not installed
    plugins: [keepImportMetaUrl(outdir)],
    logLevel: 'warning',
  })
  keepOwnMappingsIn(outdir)
}

if (process.argv.includes('--check')) checkBundle(outdir, 'API')
else await bundle()
