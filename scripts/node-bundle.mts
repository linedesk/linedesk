// Shared by the bundles that make the API and the voice agent start fast (apps/api/scripts/bundle.ts,
// apps/agent/scripts/bundle.ts; LIN-526, LIN-569): Node loads a few dozen files instead of thousands of modules.
// No esbuild import here: the images run `--check` without esbuild, so the plugin types below are only the parts used.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))

type OnLoadResult = { contents: string; loader: 'ts' | 'js'; resolveDir: string } | undefined
/** esbuild's message shape, as far as these plugins use it. */
type Message = { text?: string }
type OnResolveResult = { path?: string; external?: boolean; errors?: Message[] } | undefined
type PluginBuild = {
  onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<OnLoadResult>): void
  onResolve(
    options: { filter: RegExp },
    callback: (args: {
      path: string
      kind: string
      importer: string
      resolveDir: string
      pluginData: unknown
    }) => Promise<OnResolveResult>,
  ): void
  // esbuild's own signature: `kind` is its ImportKind, passed through from onResolve unchanged.
  resolve(path: string, options?: object): Promise<{ path: string; errors: Message[] }>
}
export type Plugin = { name: string; setup(build: PluginBuild): void }

/** Bundle code: `import.meta.url` replaced by the URL of the source file, relative to the bundle (see keepImportMetaUrl). */
const relativeUrl = /new URL\("([^"]+)", import\.meta\.url\)/g
/** A package left outside the bundle and imported by its path (see keepOutside). */
const relativeImport = /(?:from |import\()"(\.\.?\/[^"]+)"/g

/**
 * Code that finds files next to itself (locales, voice previews, migrations, Sentry's loader hook, the agent SDK's
 * sound files) keeps the `import.meta.url` of its source file, relative to the bundle; so do the
 * `import.meta.url === argv[1]` checks of scripts that are also modules. Files in `inBundle` keep the bundle's own URL.
 * A plain text replace: it also rewrites `import.meta.url` in comments and strings, which is harmless there.
 */
export function keepImportMetaUrl(outdir: string, inBundle: ReadonlySet<string> = new Set()): Plugin {
  return {
    name: 'keep-import-meta-url',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async args => {
        if (inBundle.has(args.path)) return undefined
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
}

/**
 * Packages that stay outside the bundle (native binaries, files and worker threads found next to their code), imported
 * by their path in node_modules relative to the bundle: a bare name would be looked up from the bundle's folder, where
 * pnpm has not linked them.
 */
export function keepOutside(outdir: string, packages: RegExp): Plugin {
  return {
    name: 'keep-outside',
    setup(build) {
      build.onResolve({ filter: packages }, async args => {
        if (args.pluginData === 'keep-outside') return undefined
        const { kind, importer, resolveDir } = args
        const found = await build.resolve(args.path, { kind, importer, resolveDir, pluginData: 'keep-outside' })
        if (found.errors.length) return { errors: found.errors }
        const relative = path.relative(outdir, found.path).split(path.sep).join('/')
        return { path: relative.startsWith('.') ? relative : `./${relative}`, external: true }
      })
    },
  }
}

/**
 * Checks that every file the bundle points at outside itself is in the image: the source files of modules that keep
 * their own `import.meta.url` and the packages kept outside. Not the files those modules read next to them (locales,
 * voice previews, migrations): those come with the same COPY of the sources.
 */
export function checkBundle(outdir: string, name: string) {
  const missing: string[] = []
  for (const file of readdirSync(outdir).filter(name => name.endsWith('.mjs'))) {
    const code = readFileSync(path.join(outdir, file), 'utf8')
    for (const [, target] of [...code.matchAll(relativeUrl), ...code.matchAll(relativeImport)]) {
      if (target && !existsSync(path.resolve(outdir, target))) missing.push(`${file}: ${target}`)
    }
  }
  if (missing.length) {
    console.error(`The ${name} bundle reads files that are not in the image:\n${missing.join('\n')}`)
    process.exit(1)
  }
}

/** Source maps of every bundle file in `outdir`: only our own code (keepOwnMappings). */
export function keepOwnMappingsIn(outdir: string) {
  for (const file of readdirSync(outdir).filter(name => name.endsWith('.map'))) keepOwnMappings(path.join(outdir, file))
}

// Source maps: only our own code (apps/, packages/). The dependencies' mappings were most of the 8.6 MB of maps, and
// Node parses all of a file's map on the first error stack (--enable-source-maps): about 80 MiB more, which with
// Sentry on took the API past its 256 MiB limit (LIN-526). A frame in a dependency then shows the bundle file; it must
// never show one of our files, so where our code ends a segment with only its column (no source) ends the mapping
// there instead of stretching it over the dependency's code; the dependency's other segments go. Dependencies' own source maps (esbuild
// chains them) point into node_modules too and go the same way.
type SourceMap = { sources: string[]; sourcesContent?: (string | null)[]; names: string[]; mappings: string }

export function keepOwnMappings(file: string) {
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
