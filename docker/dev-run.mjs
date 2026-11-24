// Dev mode (docker-compose.dev.yml): runs one service (api, web or agent) from the source checkout
// mounted at /app and keeps it current, so a code change shows without a new image.
//   node docker/dev-run.mjs [<dir to watch>...] -- <command...>
//
// - Dependencies: node_modules is a volume shared by the three services. Before each start, when
//   pnpm-lock.yaml differs from the one it was installed from, `pnpm install --frozen-lockfile` runs
//   (one service at a time, under a lock; the others then find it done). With LINEDESK_DEV_INSTALL=wait
//   (the agent, whose checkout is read-only) it never installs, it waits for another service to.
// - A change in a watched directory (or to pnpm-lock.yaml) restarts the command: SIGTERM, SIGKILL after
//   STOP_GRACE_MS. The agent's running calls end there; the API's migrations run again when it starts.
// - The command exiting by itself (a crash) starts it again after 2 s, like the restart policy would.
// - SIGTERM to this process (docker stop) goes to the command, which gets the container's whole stop
//   grace period (the agent finishes its calls).
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, watch } from 'node:fs'

const ROOT = '/app'
const STAMP = `${ROOT}/node_modules/.linedesk-lock-sha`
const STOP_GRACE_MS = 5000
const DEBOUNCE_MS = 300
const WAIT_FOR_INSTALL = process.env.LINEDESK_DEV_INSTALL === 'wait'

const args = process.argv.slice(2)
const separator = args.indexOf('--')
if (separator < 0) throw new Error('usage: dev-run.mjs [<dir>...] -- <command...>')
const watchDirs = args.slice(0, separator)
const command = args.slice(separator + 1)

let child = null
let restartAfterExit = false
let stopping = false
let debounce = null

function log(message) {
  console.log(`[live ${new Date().toISOString().slice(11, 19)}] ${message}`)
}

function installDependencies() {
  const lock = createHash('sha256')
    .update(readFileSync(`${ROOT}/pnpm-lock.yaml`))
    .digest('hex')
  if (WAIT_FOR_INSTALL) return waitForInstall(lock)
  // Dev dependencies too (Vite, the type checker), whatever NODE_ENV says. The store is in the same
  // volume, so a later install only fetches what changed. Takes ~0.5 GB of memory on two cores.
  const script = `[ "$(cat ${STAMP} 2>/dev/null)" = ${lock} ] && exit 0
echo "[live] pnpm-lock.yaml changed: pnpm install --frozen-lockfile"
CI=true pnpm install --frozen-lockfile --prod=false --store-dir ${ROOT}/node_modules/.pnpm-store \\
  --config.confirmModulesPurge=false --reporter=append-only && echo ${lock} > ${STAMP}`
  const result = spawnSync('flock', [`${ROOT}/node_modules/.linedesk-install.lock`, 'sh', '-ec', script], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`pnpm install failed (${result.status ?? result.signal})`)
}

// A service with a read-only checkout (the agent) cannot install: pnpm writes the workspace packages'
// node_modules links into the checkout. It waits until another service has installed this lockfile.
function waitForInstall(lock) {
  let logged = false
  while (readStamp() !== lock) {
    if (!logged) log('waiting for another service to install the dependencies')
    logged = true
    spawnSync('sleep', ['2'])
  }
}

function readStamp() {
  try {
    return readFileSync(STAMP, 'utf8').trim()
  } catch {
    return null
  }
}

function start() {
  installDependencies()
  child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
  child.on('exit', onExit)
}

function onExit(code, signal) {
  child = null
  if (stopping) process.exit(0)
  if (restartAfterExit) {
    restartAfterExit = false
    return start()
  }
  log(`${command.join(' ')} exited (${signal ?? code}); starting it again in 2 s`)
  setTimeout(start, 2000)
}

function restart(reason) {
  log(`${reason}: restarting`)
  if (!child) return // it is starting again anyway
  restartAfterExit = true
  const stopped = child
  stopped.kill('SIGTERM')
  setTimeout(() => stopped.exitCode === null && stopped.signalCode === null && stopped.kill('SIGKILL'), STOP_GRACE_MS)
}

function onChange(path) {
  if (path.includes('node_modules') || path.endsWith('.test.ts')) return
  clearTimeout(debounce)
  debounce = setTimeout(() => restart(`${path} changed`), DEBOUNCE_MS)
}

// One watcher per directory: Node's recursive watch on Linux misses files that an editor or a merge
// replaces (write a temporary file, rename it over the old one) and can lag by seconds.
const watched = new Set()
function watchTree(dir) {
  if (watched.has(dir) || dir.includes('node_modules')) return
  watched.add(dir)
  const watcher = watch(`${ROOT}/${dir}`, (_event, file) => {
    if (!file) return
    const path = `${dir}/${file}`
    if (isDirectory(path)) watchTree(path) // a new directory
    onChange(path)
  })
  watcher.on('error', () => {
    watched.delete(dir) // the directory was removed
    watcher.close()
  })
  for (const entry of readdirSync(`${ROOT}/${dir}`, { withFileTypes: true })) {
    if (entry.isDirectory()) watchTree(`${dir}/${entry.name}`)
  }
}

function isDirectory(path) {
  try {
    return statSync(`${ROOT}/${path}`).isDirectory()
  } catch {
    return false
  }
}

for (const dir of watchDirs) watchTree(dir)
// A merge replaces the lockfile, so watch the directory it is in, not the file.
watch(ROOT, (_event, file) => file === 'pnpm-lock.yaml' && onChange(file))
// A new version of this file: stop the command and exit; Docker's restart policy starts the container
// again, with the new version.
watch(`${ROOT}/docker`, (_event, file) => {
  if (file !== 'dev-run.mjs' || stopping) return
  stopping = true
  restart('docker/dev-run.mjs changed, the container')
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true
    if (!child) process.exit(0)
    child.kill(signal)
  })
}

start()
