import { existsSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, normalize } from 'node:path'
import {
  allowAttempt, checkPassword, checkSetupToken, createSession, endSession, ensureAdmin,
  finishSetup, isAuthed, sessionCookie, setPassword, setupFile, setupPending,
} from './auth.ts'
import { cleanupSchedule, listCleanup, setCleanupSchedule, startCleanup, startScheduledCleanup } from './cleanup.ts'
import { config } from './config.ts'
import { db, logActivity } from './db.ts'
import { usage } from './disk.ts'
import { deleteFiles, imagePreview, startDeleteFolder, startSearch, startUsageCheck } from './files.ts'
import { appDetail, containerAction, listApps } from './apps.ts'
import { health } from './health.ts'
import { serviceHints } from './hints.ts'
import { Cancelled, cancelJob, clearFinished, getJob, listJobs, scope } from './jobs.ts'
import { history, overview, startSampling } from './metrics.ts'
import {
  installedPackages, packageJob, packageState, refreshIndex, removalPlan, removePackage, updatePlan, upgradePackages,
} from './packages.ts'
import { listListeners } from './ports.ts'
import { listProcesses, signalProcess } from './processes.ts'
import { listServices, serviceAction, serviceLogs } from './services.ts'
import { applyUpdate, checkForUpdate, setAutoUpdate, startUpdateChecks, updateState } from './update.ts'

if (process.platform !== 'linux') {
  console.error('Balai only runs on Linux.')
  process.exit(1)
}

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...HEADERS, 'Cache-Control': 'no-store', ...extra } })
}

const fail = (message: string, status = 400) => json({ ok: false, message }, status)

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text()
    if (text.length > 2_000_000) return {}
    const parsed: unknown = JSON.parse(text || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A browser on another site must never be able to trigger an action here. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.get('host')
  } catch {
    return false
  }
}

function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10 && value.length <= 200
}

/**
 * The visitor's address. Behind a reverse proxy on this machine every request comes from 127.0.0.1,
 * so the address the proxy forwards is used, and only when the request really comes from the proxy.
 */
function clientAddress(req: Request, peer: string): string {
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
  if (!local) return peer
  const forwarded = req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',').at(-1)
  return forwarded?.trim() || peer
}

async function api(req: Request, url: URL, address: string): Promise<Response> {
  const path = url.pathname.slice('/api'.length)
  const route = `${req.method} ${path}`

  if (req.method !== 'GET' && !sameOrigin(req)) return fail('Cross-site request refused.', 403)

  // Open routes
  if (route === 'GET /session') {
    return json({ signedIn: isAuthed(req), setupPending: setupPending() })
  }

  if (route === 'POST /setup') {
    if (!allowAttempt(address)) return fail('Too many attempts. Wait a minute and try again.', 429)
    const data = await body(req)
    if (typeof data.token !== 'string' || !checkSetupToken(data.token)) {
      return fail('This setup link is no longer valid. Sign in with your password instead.', 403)
    }
    if (!validPassword(data.password)) return fail('Use a password of at least 10 characters.')
    await setPassword(data.password)
    logActivity({ area: 'account', action: 'Setup completed' })
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, createSession()) })
  }

  if (route === 'POST /login') {
    if (!allowAttempt(address)) return fail('Too many attempts. Wait a minute and try again.', 429)
    const data = await body(req)
    if (typeof data.password !== 'string' || !(await checkPassword(data.password))) {
      return fail('Wrong password.', 401)
    }
    finishSetup()
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, createSession()) })
  }

  if (!isAuthed(req)) return fail('Sign in to continue.', 401)

  // Signed-in routes
  if (route === 'POST /logout') {
    endSession(req)
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, null) })
  }

  if (route === 'POST /password') {
    const data = await body(req)
    if (typeof data.current !== 'string' || !(await checkPassword(data.current))) {
      return fail('The current password is not correct.', 403)
    }
    if (!validPassword(data.password)) return fail('Use a password of at least 10 characters.')
    await setPassword(data.password)
    logActivity({ area: 'account', action: 'Password changed' })
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, createSession()) })
  }

  if (route === 'GET /overview') return json(await overview())
  if (route === 'GET /health') return json(await health())

  if (route === 'GET /history') {
    const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 24))
    return json(history(hours))
  }

  if (route === 'GET /processes') return json(await listProcesses())

  const signal = path.match(/^\/processes\/(\d+)\/(stop|kill)$/)
  if (req.method === 'POST' && signal) {
    const result = signalProcess(Number(signal[1]), signal[2]!)
    return json(result, result.ok ? 200 : 400)
  }

  if (route === 'GET /services') return json(await listServices())
  if (route === 'GET /services/hints') return json(await serviceHints())

  const service = path.match(/^\/services\/([^/]+)\/(\w+)$/)
  if (service) {
    const name = decodeURIComponent(service[1]!)
    if (req.method === 'GET' && service[2] === 'logs') return json(await serviceLogs(name))
    if (req.method === 'POST') {
      const result = await serviceAction(name, service[2]!)
      return json(result, result.ok ? 200 : 400)
    }
  }

  if (route === 'GET /cleanup') return json(await listCleanup())

  if (route === 'POST /cleanup') {
    const data = await body(req)
    const ids = Array.isArray(data.ids) ? data.ids.filter((id): id is string => typeof id === 'string') : []
    const started = startCleanup(ids)
    return started.ok ? json({ ok: true, job: started.job }) : json({ ok: false, message: started.message, job: started.job }, 409)
  }

  if (route === 'GET /disk') {
    const result = await usage(url.searchParams.get('path') ?? '/')
    return result ? json(result) : fail('That folder cannot be read.', 404)
  }

  if (route === 'GET /packages') return json(await packageState(url.searchParams.has('fresh')))

  if (route === 'POST /packages/refresh') {
    const result = await refreshIndex()
    return json(result, result.ok ? 200 : 502)
  }

  if (route === 'GET /packages/installed') return json(await installedPackages())
  if (route === 'GET /packages/job') return json({ job: packageJob() })

  if (route === 'GET /packages/plan') {
    const plan = await updatePlan(url.searchParams.get('name'))
    return json(plan, plan.ok ? 200 : 400)
  }

  if (route === 'GET /packages/removal') {
    const plan = await removalPlan(url.searchParams.get('name') ?? '')
    return json(plan, plan.ok ? 200 : 400)
  }

  if (route === 'POST /packages/upgrade') {
    const data = await body(req)
    const result = await upgradePackages(typeof data.name === 'string' ? data.name : null)
    return json(result, result.ok ? 200 : 409)
  }

  if (route === 'POST /packages/remove') {
    const data = await body(req)
    if (typeof data.name !== 'string') return fail('Invalid package name.')
    const result = await removePackage(data.name, data.purge === true)
    return json(result, result.ok ? 200 : 409)
  }

  if (route === 'POST /files/search') {
    const data = await body(req)
    const started = startSearch({
      path: typeof data.path === 'string' ? data.path : '/',
      extensions: (typeof data.ext === 'string' ? data.ext : '').split(/[\s,;]+/),
      minBytes: Number(data.min) || 0,
      olderThanDays: Number(data.days) || 0,
    })
    return started.ok ? json({ ok: true, job: started.job }) : fail(started.message)
  }

  if (route === 'POST /files/usage') {
    const data = await body(req)
    const job = Array.isArray(data.paths) ? startUsageCheck(data.paths) : null
    return job ? json({ ok: true, job }) : fail('Nothing to check.')
  }

  if (route === 'GET /files/preview') {
    const image = imagePreview(url.searchParams.get('path'))
    if (!image) return fail('No preview for this file.', 404)
    return new Response(Bun.file(image.file), {
      headers: {
        ...HEADERS,
        'Content-Type': image.type,
        'Cache-Control': 'private, max-age=60',
        // An SVG opened on its own must not run scripts with the panel's rights.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    })
  }

  if (route === 'POST /files/delete') {
    const data = await body(req)
    if (!Array.isArray(data.paths) || !data.paths.length) return fail('Nothing selected.')
    return json(deleteFiles(data.paths))
  }

  if (route === 'POST /files/delete-folder') {
    const started = startDeleteFolder((await body(req)).path)
    return started.ok ? json({ ok: true, job: started.job }) : fail(started.message)
  }

  if (route === 'GET /apps') return json(await listApps())
  if (route === 'GET /apps/detail') {
    const detail = await appDetail(url.searchParams.get('id') ?? '')
    return detail ? json(detail) : fail('That app is no longer installed.', 404)
  }
  const container = path.match(/^\/apps\/containers\/([^/]+)\/(start|stop|restart)$/)
  if (container && req.method === 'POST') {
    const result = await containerAction(decodeURIComponent(container[1]!), container[2]!)
    return json(result, result.ok ? 200 : 400)
  }

  if (route === 'GET /jobs') return json(listJobs())
  if (route === 'POST /jobs/clear') {
    clearFinished()
    return json(listJobs())
  }
  const task = path.match(/^\/jobs\/([0-9a-f-]{36})(\/cancel)?$/)
  if (task && req.method === 'GET' && !task[2]) {
    const found = getJob(task[1]!)
    return found ? json(found) : fail('This task is no longer listed.', 404)
  }
  if (task && req.method === 'POST' && task[2]) {
    const result = cancelJob(task[1]!)
    return json(result, result.ok ? 200 : 409)
  }

  if (route === 'GET /cleanup/schedule') return json(cleanupSchedule())
  if (route === 'POST /cleanup/schedule') {
    setCleanupSchedule((await body(req)).enabled === true)
    return json(cleanupSchedule())
  }

  if (route === 'GET /update') return json(updateState())
  if (route === 'POST /update/check') return json(await checkForUpdate())
  if (route === 'POST /update/apply') {
    const result = await applyUpdate()
    return json(result, result.ok ? 200 : 500)
  }
  if (route === 'POST /update/auto') {
    setAutoUpdate((await body(req)).enabled === true)
    return json(updateState())
  }

  if (route === 'GET /ports') return json(await listListeners())

  if (route === 'GET /activity') {
    const rows = db
      .query('SELECT id, at, area, action, target, detail, ok, freed FROM activity ORDER BY id DESC LIMIT 300')
      .all()
    const total = db.query<{ freed: number | null }, []>('SELECT SUM(freed) AS freed FROM activity').get()
    return json({ rows, freed: total?.freed ?? 0 })
  }

  return fail('Not found.', 404)
}

async function asset(url: URL): Promise<Response> {
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  const file = join(config.webDir, requested)
  const inside = file.startsWith(config.webDir)
  const exists = inside && requested !== '/' && (await Bun.file(file).exists())
  if (requested.startsWith('/assets/') && !exists) {
    return new Response('Not found.', { status: 404, headers: HEADERS })
  }
  const target = exists ? file : join(config.webDir, 'index.html')
  const immutable = target.includes('/assets/')
  return new Response(Bun.file(target), {
    headers: { ...HEADERS, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
  })
}

if (!existsSync(join(config.webDir, 'index.html'))) {
  console.error('The web interface has not been built yet. Run: bun run build')
  process.exit(1)
}

startSampling()
startScheduledCleanup()

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  // Measuring a large folder or searching the whole disk can take a while.
  idleTimeout: 240,
  async fetch(req, srv) {
    const url = new URL(req.url)
    try {
      if (url.pathname.startsWith('/api/')) {
        const address = clientAddress(req, srv.requestIP(req)?.address ?? 'unknown')
        // Programs run to answer a GET stop when the browser stops waiting for the answer.
        if (req.method === 'GET') return await scope.run({ signal: req.signal, job: null }, () => api(req, url, address))
        return await api(req, url, address)
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail('Not found.', 404)
      return await asset(url)
    } catch (error) {
      // The browser left before the answer was ready.
      if (error instanceof Cancelled) return new Response(null, { status: 499 })
      console.error(error)
      return fail('Something went wrong on the server.', 500)
    }
  },
})

startUpdateChecks()

function publicUrl(): string {
  if (config.url) return config.url.replace(/\/+$/, '')
  let host = server.hostname ?? 'localhost'
  if (host === '0.0.0.0' || host === '::') {
    const addresses = Object.values(networkInterfaces()).flat()
    host = addresses.find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address ?? 'localhost'
  }
  return `http://${host}:${server.port}`
}

console.log(`Balai is listening on ${publicUrl()}`)

const firstRun = await ensureAdmin()
if (firstRun) {
  const text = [
    'Balai is ready.',
    '',
    `Setup link:      ${publicUrl()}/setup?token=${firstRun.token}`,
    `Admin password:  ${firstRun.password}`,
    '',
    'Open the link once to choose your own password, or sign in with the one above.',
    '',
  ].join('\n')
  writeFileSync(setupFile, text, { mode: 0o600 })
  console.log(`\n${text}`)
}
if (process.getuid?.() !== 0) console.log('Not running as root: cleaning and service actions will be limited.')
