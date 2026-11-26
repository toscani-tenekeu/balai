import { existsSync, lstatSync, readdirSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSetting, logActivity, setSetting } from './db.ts'
import { CONTAINER_AGE_DAYS, sortLeftovers, stoppedContainers, type Kept, type Selection } from './guards.ts'
import { Cancelled, runningJob, startJob, step } from './jobs.ts'
import { releaseSets, webRoots } from './sites.ts'
import { backend } from './pm.ts'
import { formatBytes, has, lines, readText, reason, run } from './sys.ts'

interface Measure {
  bytes: number | null
  note?: string
  /** Names of what would go and of what stays, for items that remove things someone may miss. */
  removes?: string[]
  keeps?: Kept[]
}

interface Task {
  id: string
  title: string
  description: string
  /** Selected by default: safe to run at any time with nothing to lose. */
  recommended: boolean
  kind: 'disk' | 'memory'
  available?: () => boolean
  measure: () => Promise<Measure>
  clean: () => Promise<{ ok: boolean; message?: string }>
}

/** Releases older than the live one and the one before it, on sites deployed as side-by-side releases. */
async function oldReleases(): Promise<{ site: string; dir: string }[]> {
  return releaseSets(await webRoots()).flatMap((set) => set.others.slice(1).map((dir) => ({ site: set.site, dir })))
}

const DAY = 86_400_000
const TMP_AGE_DAYS = 7
const JOURNAL_KEEP = '7d'

function homes(): string[] {
  const list = ['/root']
  try {
    for (const name of readdirSync('/home')) list.push(join('/home', name))
  } catch {
    // No /home on this system.
  }
  return list
}

function existing(paths: string[]): string[] {
  return paths.filter((path) => existsSync(path))
}

async function sizeOf(paths: string[]): Promise<number> {
  const present = existing(paths)
  if (!present.length) return 0
  const result = await run(['du', '-scxB1', '--', ...present], { timeout: 60_000 })
  const total = lines(result.stdout).at(-1)?.match(/^(\d+)\s+total$/)
  return total ? Number(total[1]) : 0
}

/** Size of what is inside the directories, not the directories themselves. */
async function contentSize(dirs: string[]): Promise<number> {
  const children = existing(dirs).flatMap((dir) => {
    try {
      return readdirSync(dir).map((name) => join(dir, name))
    } catch {
      return []
    }
  })
  return sizeOf(children)
}

function emptyDirs(dirs: string[]) {
  for (const dir of existing(dirs)) {
    for (const name of readdirSync(dir)) {
      rmSync(join(dir, name), { recursive: true, force: true })
    }
  }
}

/** Regular files under a directory that match, without following links or leaving the filesystem. */
function findFiles(
  root: string,
  match: (path: string, mtime: number) => boolean,
): { path: string; size: number; links: number }[] {
  const found: { path: string; size: number; links: number }[] = []
  let device: number
  try {
    device = lstatSync(root).dev
  } catch {
    return found
  }
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(dir, name)
      try {
        const stat = lstatSync(path)
        if (stat.dev !== device) continue
        if (stat.isDirectory()) stack.push(path)
        else if (stat.isFile() && match(path, Math.max(stat.mtimeMs, stat.atimeMs))) {
          found.push({ path, size: stat.blocks * 512, links: stat.nlink })
        }
      } catch {
        // Gone between listing and reading.
      }
    }
  }
  return found
}

function removeFiles(files: { path: string }[]) {
  for (const file of files) {
    try {
      unlinkSync(file.path)
    } catch {
      // Already removed or in use; the next run picks it up.
    }
  }
}

const sum = (files: { size: number }[]) => files.reduce((total, file) => total + file.size, 0)

const oldTemp = () => {
  const limit = Date.now() - TMP_AGE_DAYS * DAY
  return ['/tmp', '/var/tmp'].flatMap((dir) => findFiles(dir, (_, touched) => touched < limit))
}

// Rotated copies: syslog.1, auth.log.2.gz, and the dated ones of Red Hat and SUSE (messages-20261101).
const ROTATED = /(\.(gz|xz|bz2|zst|old|\d+)|-\d{8}(\.\w+)?)$/
const rotatedLogs = () =>
  findFiles('/var/log', (path) => !path.startsWith('/var/log/journal/') && ROTATED.test(path))

function parseSize(text: string): number {
  const match = text.trim().match(/^([\d.]+)\s*([kKMGT]?)i?B?/)
  if (!match) return 0
  const power = { '': 0, k: 1, K: 1, M: 2, G: 3, T: 4 }[match[2] ?? ''] ?? 0
  return Number(match[1]) * 1024 ** power
}

async function journalSize(): Promise<number> {
  const result = await run(['journalctl', '--disk-usage'])
  const match = result.stdout.match(/take up ([\d.]+\s*[KMGT]?)/)
  return match ? parseSize(match[1]!) : 0
}

async function dockerReclaimable(): Promise<number> {
  const [images, system] = await Promise.all([
    run(['docker', 'images', '--filter', 'dangling=true', '--format', '{{.Size}}']),
    run(['docker', 'system', 'df', '--format', '{{.Type}}\t{{.Reclaimable}}']),
  ])
  let bytes = lines(images.stdout).reduce((total, size) => total + parseSize(size), 0)
  const cache = lines(system.stdout).find((line) => line.startsWith('Build Cache'))
  if (cache) bytes += parseSize(cache.split('\t')[1] ?? '')
  return bytes
}

const BIG_LOG = 100 * 1024 ** 2
const bigLogs = () =>
  findFiles('/var/log', (path) => !path.startsWith('/var/log/journal/') && !ROTATED.test(path))
    .filter((file) => file.size >= BIG_LOG)

/** Download caches of language tools. Each one is refilled on the next install. */
const TOOL_CACHES = [
  '.npm/_cacache', '.bun/install/cache', '.cache/pip', '.cache/yarn', '.cache/pnpm', '.cache/composer',
  '.composer/cache', '.cache/go-build', '.cargo/registry/cache', '.gradle/caches', '.cache/pypoetry/cache',
]
const toolCaches = () => homes().flatMap((home) => TOOL_CACHES.map((dir) => join(home, dir)))

interface SnapRevision {
  name: string
  revision: string
  file: string
}

async function oldSnaps(): Promise<SnapRevision[]> {
  const result = await run(['snap', 'list', '--all'], { timeout: 30_000 })
  return lines(result.stdout)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 6 && parts.at(-1)!.split(',').includes('disabled'))
    .map((parts) => ({
      name: parts[0]!,
      revision: parts[2]!,
      file: `/var/lib/snapd/snaps/${parts[0]}_${parts[2]}.snap`,
    }))
}

/**
 * Images no container uses, measured from the images and containers themselves. `docker system df`
 * cannot be trusted here: with the containerd image store it calls every image reclaimable, even
 * those running containers use, so the size shown never went down after cleaning.
 */
async function unusedImages(): Promise<number> {
  const listed = await run(['docker', 'image', 'ls', '-aq', '--no-trunc'])
  const ids = [...new Set(lines(listed.stdout))]
  if (!ids.length) return 0
  const containers = lines((await run(['docker', 'ps', '-aq'])).stdout)
  const used = new Set(
    containers.length ? lines((await run(['docker', 'inspect', '--format', '{{.Image}}', ...containers])).stdout) : [],
  )
  const unused = ids.filter((id) => !used.has(id))
  if (!unused.length) return 0
  const sizes = await run(['docker', 'image', 'inspect', '--format', '{{.Size}}', ...unused], { timeout: 60_000 })
  return lines(sizes.stdout).reduce((total, size) => total + (Number(size) || 0), 0)
}

/** Memory the kernel can really give back: cached file data no program has mapped, plus reclaimable kernel caches. */
export function droppableCache(): number {
  const info = new Map<string, number>()
  for (const line of lines(readText('/proc/meminfo'))) {
    const match = line.match(/^([\w()]+):\s+(\d+)/)
    if (match) info.set(match[1]!, Number(match[2]) * 1024)
  }
  const file = (info.get('Active(file)') ?? 0) + (info.get('Inactive(file)') ?? 0)
  const pinned = (info.get('Mapped') ?? 0) + (info.get('Dirty') ?? 0) + (info.get('Writeback') ?? 0)
  return Math.max(0, file - pinned) + (info.get('SReclaimable') ?? 0)
}

/**
 * Space that emptying the folders really frees. A file also linked from elsewhere (Bun links its cache into
 * each project's node_modules) keeps its space until every link is gone, so it is not counted.
 */
function freeableSize(dirs: string[]): number {
  let total = 0
  for (const dir of existing(dirs)) {
    for (const file of findFiles(dir, () => true)) if (file.links === 1) total += file.size
  }
  return total
}

const count = (items: unknown[], word: string) => `${items.length} ${word}${items.length === 1 ? '' : 's'}`

/** A count for the size column, with the names behind it. */
const selection = ({ removes, keeps }: Selection, word: string): Measure => ({
  bytes: null,
  note: keeps.length ? `${count(removes, word)}, ${keeps.length} kept` : count(removes, word),
  removes,
  keeps,
})

const pm = backend
const pmEnv = pm?.env ?? {}
const pmFailed = (result: { ok: boolean; stderr: string; stdout: string; code: number }, what: string) =>
  ({ ok: result.ok, message: result.ok ? undefined : reason(result, `${what} failed.`) })

/** Downloaded package files, wherever this system's package manager keeps them. */
const cachedPackages = () => (pm ? pm.cache.roots.flatMap((root) => findFiles(root, (path) => pm.cache.match.test(path))) : [])

const tasks: Task[] = [
  {
    id: 'package-cache',
    title: 'Package download cache',
    description: 'Installer files the package manager has already used. They are downloaded again if ever needed.',
    recommended: true,
    kind: 'disk',
    available: () => pm !== null,
    measure: async () => ({ bytes: sum(cachedPackages()) }),
    clean: async () => {
      if (pm?.cache.clean) {
        const result = await run(pm.cache.clean, { timeout: 300_000, env: pmEnv })
        if (!result.ok) return pmFailed(result, pm.cache.clean[0]!)
      }
      // Whatever the command left (or everything, where there is none) is removed directly.
      removeFiles(cachedPackages())
      return { ok: true }
    },
  },
  {
    id: 'unused-packages',
    title: 'Unused packages',
    description: 'Packages that were installed as dependencies and that nothing needs any more, including old kernels where the system marks them so.',
    recommended: true,
    kind: 'disk',
    available: () => pm?.autoremove != null,
    measure: async () => selection({ removes: await pm!.autoremove!.list(), keeps: [] }, 'package'),
    clean: async () => {
      const names = await pm!.autoremove!.list()
      if (!names.length) return { ok: true }
      const command = pm!.autoremove!.clean(names)
      return pmFailed(await run(command, { timeout: 600_000, env: pmEnv }), command[0]!)
    },
  },
  {
    id: 'journal',
    title: 'System journal',
    description: 'Keeps the last 7 days of systemd journal entries and removes everything older.',
    recommended: true,
    kind: 'disk',
    available: () => has('journalctl'),
    measure: async () => ({ bytes: await journalSize(), note: 'current size' }),
    clean: async () => {
      const result = await run(['journalctl', '--rotate', `--vacuum-time=${JOURNAL_KEEP}`], { timeout: 120_000 })
      return { ok: result.ok, message: result.ok ? undefined : reason(result, 'journalctl failed.') }
    },
  },
  {
    id: 'rotated-logs',
    title: 'Rotated log files',
    description: 'Archived copies in /var/log such as syslog.1, messages-20260101 or auth.log.2.gz. Logs still being written are kept.',
    recommended: true,
    kind: 'disk',
    measure: async () => ({ bytes: sum(rotatedLogs()) }),
    clean: async () => {
      removeFiles(rotatedLogs())
      return { ok: true }
    },
  },
  {
    id: 'temp',
    title: 'Old temporary files',
    description: `Files in /tmp and /var/tmp that have not been touched for ${TMP_AGE_DAYS} days.`,
    recommended: true,
    kind: 'disk',
    measure: async () => ({ bytes: sum(oldTemp()) }),
    clean: async () => {
      removeFiles(oldTemp())
      return { ok: true }
    },
  },
  {
    id: 'crash',
    title: 'Crash reports',
    description: 'Dumps left in /var/crash after a program crashed.',
    recommended: true,
    kind: 'disk',
    available: () => existsSync('/var/crash'),
    measure: async () => ({ bytes: await contentSize(['/var/crash']) }),
    clean: async () => {
      emptyDirs(['/var/crash'])
      return { ok: true }
    },
  },
  {
    id: 'core-dumps',
    title: 'Core dumps',
    description: 'Memory images systemd saved when a program crashed. Only useful to someone debugging that crash.',
    recommended: true,
    kind: 'disk',
    available: () => existsSync('/var/lib/systemd/coredump'),
    measure: async () => ({ bytes: await contentSize(['/var/lib/systemd/coredump']) }),
    clean: async () => {
      emptyDirs(['/var/lib/systemd/coredump'])
      return { ok: true }
    },
  },
  {
    id: 'snap-old',
    title: 'Old snap revisions',
    description: 'Earlier versions of snap packages kept after an update. The version in use stays.',
    recommended: true,
    kind: 'disk',
    available: () => has('snap'),
    measure: async () => ({ bytes: await sizeOf((await oldSnaps()).map((snap) => snap.file)) }),
    clean: async () => {
      for (const snap of await oldSnaps()) {
        const result = await run(['snap', 'remove', snap.name, `--revision=${snap.revision}`], { timeout: 300_000 })
        if (!result.ok) return { ok: false, message: reason(result, 'snap remove failed.') }
      }
      return { ok: true }
    },
  },
  {
    id: 'trash',
    title: 'Trash',
    description: 'Deleted files still waiting in each user’s trash folder.',
    recommended: true,
    kind: 'disk',
    measure: async () => ({ bytes: await contentSize(homes().map((home) => join(home, '.local/share/Trash'))) }),
    clean: async () => {
      emptyDirs(homes().map((home) => join(home, '.local/share/Trash')))
      return { ok: true }
    },
  },
  {
    id: 'docker',
    title: 'Docker leftovers',
    description: 'Untagged images and build cache. Containers, volumes and images in use are not touched.',
    recommended: true,
    kind: 'disk',
    available: () => has('docker'),
    measure: async () => ({ bytes: await dockerReclaimable() }),
    clean: async () => {
      const images = await run(['docker', 'image', 'prune', '-f'], { timeout: 300_000 })
      const builder = await run(['docker', 'builder', 'prune', '-f'], { timeout: 300_000 })
      const failed = [images, builder].find((result) => !result.ok)
      return { ok: !failed, message: failed ? reason(failed, 'docker prune failed.') : undefined }
    },
  },
  {
    id: 'docker-containers',
    title: 'Stopped Docker containers',
    description:
      `Containers that stopped at least ${CONTAINER_AGE_DAYS} days ago and are not meant to run again. Those with a restart policy or belonging to a Compose project are kept. Anything written inside a removed container that is not in a volume is lost.`,
    recommended: false,
    kind: 'disk',
    available: () => has('docker'),
    measure: async () => selection(await stoppedContainers(), 'container'),
    clean: async () => {
      // Looked at again now, and removed by name: `docker container prune` would take every stopped one.
      const { ids } = await stoppedContainers()
      if (!ids.length) return { ok: true }
      // Without --force, Docker refuses any that has started in the meantime.
      const result = await run(['docker', 'rm', ...ids], { timeout: 300_000 })
      return { ok: result.ok, message: result.ok ? undefined : reason(result, 'docker prune failed.') }
    },
  },
  {
    id: 'docker-images',
    title: 'Unused Docker images',
    description: 'Every image that no container uses, tagged or not. Downloaded ones are fetched again when needed; ones built on this server have to be built again.',
    recommended: false,
    kind: 'disk',
    available: () => has('docker'),
    measure: async () => ({ bytes: await unusedImages() }),
    clean: async () => {
      const result = await run(['docker', 'image', 'prune', '-a', '-f'], { timeout: 600_000 })
      if (!result.ok) return { ok: false, message: reason(result, 'docker prune failed.') }
      const left = await unusedImages()
      return left ? { ok: false, message: `${formatBytes(left)} of images could not be removed.` } : { ok: true }
    },
  },
  {
    id: 'leftover-config',
    title: 'Settings of removed packages',
    description: 'Configuration files left behind by packages that were uninstalled. Reinstalling one starts from its defaults. Packages whose removal could delete data or stop a service still on this server are kept.',
    recommended: false,
    kind: 'disk',
    available: () => pm?.leftovers != null,
    measure: async () => selection(sortLeftovers(await pm!.leftovers!.list()), 'package'),
    clean: async () => {
      const names = sortLeftovers(await pm!.leftovers!.list()).removes
      if (!names.length) return { ok: true }
      const command = pm!.leftovers!.clean(names)
      return pmFailed(await run(command, { timeout: 300_000, env: pmEnv }), command[0]!)
    },
  },
  {
    id: 'big-logs',
    title: 'Oversized log files',
    description:
      'Empties logs in /var/log that have grown past 100 MB. The programs keep writing to them, but what they logged so far is gone.',
    recommended: false,
    kind: 'disk',
    measure: async () => ({ bytes: sum(bigLogs()) }),
    clean: async () => {
      for (const file of bigLogs()) {
        try {
          truncateSync(file.path, 0)
        } catch {
          // Removed or rotated in the meantime.
        }
      }
      return { ok: true }
    },
  },
  {
    id: 'tool-cache',
    title: 'Developer tool caches',
    description:
      'Downloads kept by npm, Bun, pip, Yarn, pnpm, Composer, Go, Cargo and Gradle. The next install or build fetches what it needs again.',
    recommended: false,
    kind: 'disk',
    measure: async () => ({ bytes: freeableSize(toolCaches()) }),
    clean: async () => {
      // A build running at the same time (npm ci, bun install) may start filling a cache again at once; that is expected.
      emptyDirs(toolCaches())
      return { ok: true }
    },
  },
  {
    id: 'user-cache',
    title: 'User caches',
    description:
      'Everything in each user’s ~/.cache folder. Programs rebuild what they need, but tools that keep downloads there will fetch them again.',
    recommended: false,
    kind: 'disk',
    measure: async () => ({ bytes: await contentSize(homes().map((home) => join(home, '.cache'))) }),
    clean: async () => {
      emptyDirs(homes().map((home) => join(home, '.cache')))
      return { ok: true }
    },
  },
  {
    id: 'old-releases',
    title: 'Old website releases',
    description:
      'Earlier releases of sites deployed side by side (releases/…, with a "current" link). The live release and the one before it, kept for going back, stay.',
    recommended: false,
    kind: 'disk',
    measure: async () => {
      const old = await oldReleases()
      return { bytes: await sizeOf(old.map((item) => item.dir)), note: old.length ? `${old.length} on ${[...new Set(old.map((item) => item.site))].join(', ')}` : undefined }
    },
    clean: async () => {
      for (const item of await oldReleases()) {
        const result = await run(['rm', '-rf', '--one-file-system', '--', item.dir], { timeout: 600_000 })
        if (!result.ok) return { ok: false, message: reason(result, `${item.dir} could not be deleted.`) }
      }
      return { ok: true }
    },
  },
  {
    id: 'page-cache',
    title: 'Memory page cache',
    description:
      'Asks the kernel to drop cached file data from memory. Linux frees this on its own when needed, so this is rarely useful and disk reads are slower for a while afterwards.',
    recommended: false,
    kind: 'memory',
    measure: async () => ({ bytes: droppableCache(), note: 'memory' }),
    clean: async () => {
      await run(['sync'], { timeout: 60_000 })
      try {
        writeFileSync('/proc/sys/vm/drop_caches', '3')
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not drop caches.' }
      }
    },
  },
]

const active = () => tasks.filter((task) => task.available?.() ?? true)

export async function listCleanup() {
  return Promise.all(
    active().map(async (task) => {
      const measured = await task.measure()
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        recommended: task.recommended,
        kind: task.kind,
        bytes: measured.bytes,
        note: measured.note ?? null,
        removes: measured.removes ?? [],
        keeps: measured.keeps ?? [],
      }
    }),
  )
}

/** Cleans the chosen items one after the other, as a task the interface follows and can cancel. */
export function startCleanup(ids: string[], automatic = false) {
  const running = runningJob('cleanup')
  if (running) return { ok: false as const, message: 'A cleanup is already running.', job: running }
  const chosen = active().filter((candidate) => ids.includes(candidate.id))
  if (!chosen.length) return { ok: false as const, message: 'Nothing selected.', job: null }

  const job = startJob(
    {
      kind: 'cleanup',
      title: automatic ? 'Weekly cleanup' : chosen.length === 1 ? `Cleaning ${chosen[0]!.title.toLowerCase()}` : `Cleaning ${chosen.length} items`,
      link: '/cleanup',
      unit: 'items',
      total: chosen.length,
      steps: chosen.map((task) => ({ title: task.title, state: 'waiting' as const, detail: null })),
    },
    async (handle) => {
      const results = []
      for (const [index, task] of chosen.entries()) {
        let before: Measure = { bytes: null }
        let outcome: { ok: boolean; message?: string }
        try {
          outcome = await step(handle, index, async () => {
            before = await task.measure()
            handle.check()
            const done = await task.clean()
            if (!done.ok) throw new Error(done.message ?? 'Cleanup failed.')
            return done
          })
        } catch (error) {
          if (error instanceof Cancelled || handle.cancelled) throw error
          outcome = { ok: false, message: error instanceof Error ? error.message : 'Cleanup failed.' }
        }
        const after = await task.measure()
        const freed =
          task.kind === 'disk' && before.bytes !== null && after.bytes !== null ? Math.max(0, before.bytes - after.bytes) : 0
        const item = handle.job.steps[index]!
        const released = task.kind === 'memory' && before.bytes !== null && after.bytes !== null ? Math.max(0, before.bytes - after.bytes) : 0
        if (outcome.ok) item.detail = task.kind === 'disk' ? `${formatBytes(freed)} freed` : `${formatBytes(released)} of memory released`
        handle.job.done = index + 1
        logActivity({
          area: 'cleanup',
          action: outcome.ok ? (automatic ? 'Cleaned automatically' : 'Cleaned') : 'Cleanup failed',
          target: task.title,
          detail: outcome.message ?? '',
          ok: outcome.ok,
          freed,
        })
        if (!outcome.ok) handle.job.errors.push(`${task.title}: ${outcome.message ?? 'failed'}`)
        results.push({ id: task.id, title: task.title, ok: outcome.ok, message: outcome.message ?? null, freed, released })
      }
      const freed = results.reduce((total, result) => total + result.freed, 0)
      return { message: `Cleanup finished, ${formatBytes(freed)} freed.`, result: { results, freed } }
    },
  )
  return { ok: true as const, message: '', job }
}

const WEEK = 7 * DAY

export function cleanupSchedule() {
  const enabled = getSetting('auto_clean') === '1'
  const last = Number(getSetting('auto_clean_at')) || null
  return { enabled, lastRun: Number(getSetting('auto_clean_ran')) || null, nextRun: enabled && last ? last + WEEK : null }
}

export function setCleanupSchedule(enabled: boolean) {
  setSetting('auto_clean', enabled ? '1' : '0')
  // The first automatic run comes a week after switching it on.
  if (enabled) setSetting('auto_clean_at', String(Date.now()))
}

async function scheduled() {
  const { enabled, nextRun } = cleanupSchedule()
  if (!enabled || !nextRun || Date.now() < nextRun) return
  setSetting('auto_clean_at', String(Date.now()))
  setSetting('auto_clean_ran', String(Date.now()))
  startCleanup(tasks.filter((task) => task.recommended).map((task) => task.id), true)
}

/** Once a week, cleans the items that are always safe to remove. */
export function startScheduledCleanup() {
  setInterval(() => void scheduled(), 3_600_000)
}
