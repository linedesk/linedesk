// Bundles the API server and the migration runner into apps/api/dist for the api image (Dockerfile, `api-bundle`):
// Node then loads a few dozen files at start instead of about 2,650 modules (LIN-526). Dev mode and the tests run the
// sources; so do the command-line scripts in the image (`node apps/api/src/setup-code.ts`).
//   node apps/api/scripts/bundle.ts           build apps/api/dist
//   node apps/api/scripts/bundle.ts --check   check that the source file of every module that keeps its own
//                                             `import.meta.url` is in the image (see check())
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const outdir = path.join(root, 'dist')
const repo = path.resolve(root, '../..')
const relativeUrl = /new URL\("([^"]+)", import\.meta\.url\)/g

// Code that finds files next to itself (locales, voice previews, migrations, Sentry's loader hook) keeps the
// `import.meta.url` of its source file, relative to the bundle; so do the `import.meta.url === argv[1]` checks of
// scripts that are also modules. A plain text replace: it also rewrites `import.meta.url` in comments and strings,
// which is harmless there.
const keepImportMetaUrl: Plugin = {
  name: 'keep-import-meta-url',
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async args => {
      const source = await readFile(args.path, 'utf8')
      if (!source.includes('import.meta.url')) return undefined
      const from = path.relative(outdir, args.path).split(path.sep).join('/')
      return {
        contents: source.replaceAll('import.meta.url', `new URL(${JSON.stringify(from)}, import.meta.url).href`),
        loader: /\.[cm]?ts$/.test(args.path) ? 'ts' : 'js',
        resolveDir: path.dirname(args.path),
      }
    })
  },
}

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
    plugins: [keepImportMetaUrl],
    logLevel: 'warning',
  })
  for (const file of readdirSync(outdir).filter(name => name.endsWith('.map'))) keepOwnMappings(path.join(outdir, file))
}

// Source maps: only our own code (apps/, packages/). The dependencies' mappings were most of the 8.6 MB of maps, and
// Node parses all of a file's map on the first error stack (--enable-source-maps): about 80 MiB more, which with
// Sentry on took the API past its 256 MiB limit (LIN-526). A frame in a dependency then shows the bundle file; it must
// never show one of our files, so where our code ends a segment with only its column (no source) ends the mapping
// there instead of stretching it over the dependency's code; the dependency's other segments go. Dependencies' own source maps (esbuild
// chains them) point into node_modules too and go the same way.
type SourceMap = { sources: string[]; sourcesContent?: (string | null)[]; names: string[]; mappings: string }

function keepOwnMappings(file: string) {
  const map = JSON.parse(readFileSync(file, 'utf8')) as SourceMap
  const ownSource = map.sources.map(source => {
    const relative = path
      .relative(repo, path.resolve(path.dirname(file), source))
      .split(path.sep)
      .join('/')
    return /^(apps|packages)\//.test(relative) && !relative.includes('node_modules/')
  })
  const sourceIndex = new Map<number, number>()
  const nameIndex = new Map<number, number>()
  const sources: string[] = []
  const sourcesContent: (string | null)[] = []
  const names: string[] = []
  const previous = { source: 0, line: 0, column: 0, name: 0 } // decoding: absolute values so far
  const written = { source: 0, line: 0, column: 0, name: 0 } // encoding: the last values written
  let mapped = false // whether the last segment written maps to a source
  const lines = map.mappings.split(';').map(line => {
    let generatedColumn = 0
    let writtenColumn = 0
    const segments: string[] = []
    for (const segment of line.split(',').filter(Boolean)) {
      const fields = decodeVlq(segment)
      generatedColumn += fields[0] ?? 0
      let own = false
      if (fields.length >= 4) {
        previous.source += fields[1] ?? 0
        previous.line += fields[2] ?? 0
        previous.column += fields[3] ?? 0
        if (fields.length >= 5) previous.name += fields[4] ?? 0
        own = ownSource[previous.source] ?? false
      }
      // A run of unmapped code needs only its first segment (Node then maps none of it).
      if (!own && !mapped) continue
      const out = [generatedColumn - writtenColumn]
      writtenColumn = generatedColumn
      mapped = own
      if (own) {
        let source = sourceIndex.get(previous.source)
        if (source === undefined) {
          source = sources.push(map.sources[previous.source] ?? '') - 1
          sourcesContent.push(map.sourcesContent?.[previous.source] ?? null)
          sourceIndex.set(previous.source, source)
        }
        out.push(source - written.source, previous.line - written.line, previous.column - written.column)
        Object.assign(written, { source, line: previous.line, column: previous.column })
        if (fields.length >= 5) {
          let name = nameIndex.get(previous.name)
          if (name === undefined) {
            name = names.push(map.names[previous.name] ?? '') - 1
            nameIndex.set(previous.name, name)
          }
          out.push(name - written.name)
          written.name = name
        }
      }
      segments.push(encodeVlq(out))
    }
    return segments.join(',')
  })
  // A file of dependencies only: no map at all, so Node reads none.
  if (!sources.length) {
    rmSync(file)
    const code = file.replace(/\.map$/, '')
    writeFileSync(code, readFileSync(code, 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n'))
    return
  }
  const kept: SourceMap = { ...map, sources, names, mappings: lines.join(';') }
  if (map.sourcesContent) kept.sourcesContent = sourcesContent
  else delete kept.sourcesContent
  writeFileSync(file, JSON.stringify(kept))
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decodeVlq(segment: string): number[] {
  const values: number[] = []
  let value = 0
  let shift = 0
  for (const char of segment) {
    const digit = BASE64.indexOf(char)
    value += (digit & 31) << shift
    if (digit & 32) shift += 5
    else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1)
      value = 0
      shift = 0
    }
  }
  return values
}

function encodeVlq(values: number[]): string {
  let out = ''
  for (const value of values) {
    let rest = value < 0 ? (-value << 1) | 1 : value << 1
    do {
      let digit = rest & 31
      rest >>>= 5
      if (rest > 0) digit |= 32
      out += BASE64[digit]
    } while (rest > 0)
  }
  return out
}

// Only checks that the source file of each module that keeps its own `import.meta.url` is in the image, not the files
// that module reads relative to it (locales, voice previews, migrations): those come with the same COPY of apps/api and
// packages, and the API reads them at start or on first use.
function check() {
  const missing: string[] = []
  for (const file of readdirSync(outdir).filter(name => name.endsWith('.mjs'))) {
    for (const [, target] of readFileSync(path.join(outdir, file), 'utf8').matchAll(relativeUrl)) {
      if (target && !existsSync(path.resolve(outdir, target))) missing.push(`${file}: ${target}`)
    }
  }
  if (missing.length) {
    console.error(`The API bundle reads files that are not in the image:\n${missing.join('\n')}`)
    process.exit(1)
  }
}

if (process.argv.includes('--check')) check()
else await bundle()
