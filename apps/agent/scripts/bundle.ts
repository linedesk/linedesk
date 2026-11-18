// Bundles the voice agent worker into apps/agent/dist for the agent image (Dockerfile, `agent-bundle`): the worker and
// every process it keeps warm for a call loaded about 2,000 modules from the sources, about 7 s of CPU each, on every
// start and again after every call (LIN-569). Dev mode, the tests and the command-line scripts in the image
// (`node src/call-test.ts`) run the sources.
//   node apps/agent/scripts/bundle.ts           build apps/agent/dist
//   node apps/agent/scripts/bundle.ts --check   check that the files the bundle points at are in the image
//
// The LiveKit Agents SDK is in the bundle too, with its job process (ipc/job_proc_lazy_main.js) as a second entry: the
// SDK starts that file next to its own code (job_proc_executor.js, `new URL('./job_proc_lazy_main…', import.meta.url)`),
// so both keep the bundle's URL. The job process then imports the worker bundle (the agent), and both share one copy of
// the SDK (the job context lives in it).
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBundle, keepImportMetaUrl, keepOutside, keepOwnMappingsIn } from '../../../scripts/node-bundle.mts'

const root = fileURLToPath(new URL('..', import.meta.url))
const outdir = path.join(root, 'dist')

/** Native binaries, or files and worker threads found next to the package's code: loaded from node_modules. */
const OUTSIDE = /^(@livekit\/rtc-node|@livekit\/av|onnxruntime-node|sharp|pino|pino-pretty|fluent-ffmpeg)$/

async function bundle() {
  const { build } = await import('esbuild')
  const worker = path.join(root, 'src/worker.ts')
  const sdk = realpathSync(path.join(root, 'node_modules/@livekit/agents/dist'))
  await build({
    entryPoints: { worker, job_proc_lazy_main: path.join(sdk, 'ipc/job_proc_lazy_main.js') },
    outdir,
    bundle: true,
    splitting: true, // shared code (the SDK) in chunks both entries import
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    // Error stacks point at the sources (the image runs node with --enable-source-maps).
    sourcemap: true,
    sourcesContent: false,
    // CommonJS dependencies call require(); an ES module has none of its own.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    plugins: [
      keepOutside(outdir, OUTSIDE),
      // The worker passes its own file to the SDK as the agent; the SDK starts the job process next to its code.
      keepImportMetaUrl(outdir, new Set([worker, path.join(sdk, 'ipc/job_proc_executor.js')])),
    ],
    logLevel: 'warning',
  })
  keepOwnMappingsIn(outdir)
}

if (process.argv.includes('--check')) checkBundle(outdir, 'agent')
else await bundle()
