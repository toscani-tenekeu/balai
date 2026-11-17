import { existsSync, lstatSync, readdirSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSetting, logActivity, setSetting } from './db.ts'
import { memory } from './metrics.ts'
import { has, lines, reason, run } from './sys.ts'

interface Measure {
  bytes: number | null
  note?: string
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
function findFiles(root: string, match: (path: string, mtime: number) => boolean): { path: string; size: number }[] {
  const found: { path: string; size: number }[] = []
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
          found.push({ path, size: stat.blocks * 512 })
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

const ROTATED = /\.(gz|xz|bz2|zst|old|\d+)$/
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

async function leftoverConfigs(): Promise<string[]> {
  const result = await run(['dpkg-query', '-W', '-f=${db:Status-Abbrev}\\t${binary:Package}\\n'], { timeout: 30_000 })
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('rc'))
    .map((line) => line.split('\t')[1]!)
    .filter(Boolean)
}

async function stoppedContainers(): Promise<string[]> {
  const result = await run(['docker', 'ps', '-a', '--filter', 'status=exited', '--filter', 'status=dead', '--format', '{{.ID}}'])
  return lines(result.stdout)
}

async function unusedImages(): Promise<number> {
  const result = await run(['docker', 'system', 'df', '--format', '{{.Type}}\t{{.Reclaimable}}'])
  const images = lines(result.stdout).find((line) => line.startsWith('Images'))
  return images ? parseSize(images.split('\t')[1] ?? '') : 0
}

const count = (items: unknown[], word: string) => `${items.length} ${word}${items.length === 1 ? '' : 's'}`

const apt = (args: string[], timeout = 300_000) =>
  run(['apt-get', ...args], { timeout, env: { DEBIAN_FRONTEND: 'noninteractive' } })

const tasks: Task[] = [
  {
    id: 'apt-cache',
    title: 'Package download cache',
    description: 'Installer files apt has already used. They are downloaded again if ever needed.',
    recommended: true,
    kind: 'disk',
    measure: async () => ({ bytes: await contentSize(['/var/cache/apt/archives']) }),
    clean: async () => {
      const result = await apt(['clean'])
      return { ok: result.ok, message: result.ok ? undefined : reason(result, 'apt-get clean failed.') }
    },
  },
  {
    id: 'apt-autoremove',
    title: 'Unused packages',
    description: 'Packages that were installed as dependencies and that nothing needs any more, including old kernels.',
    recommended: true,
    kind: 'disk',
    measure: async () => {
      const result = await apt(['-s', 'autoremove'], 60_000)
      const count = lines(result.stdout).filter((line) => line.startsWith('Remv ')).length
      return { bytes: null, note: count === 1 ? '1 package' : `${count} packages` }
    },
    clean: async () => {
      const result = await apt(['-y', 'autoremove', '--purge'])
      return { ok: result.ok, message: result.ok ? undefined : reason(result, 'apt-get autoremove failed.') }
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
    description: 'Archived copies in /var/log such as syslog.1 and auth.log.2.gz. Logs still being written are kept.',
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
      'Containers that have exited. Anything written inside them that is not in a volume is lost, so check that none is only paused on purpose.',
    recommended: false,
    kind: 'disk',
    available: () => has('docker'),
    measure: async () => ({ bytes: null, note: count(await stoppedContainers(), 'container') }),
    clean: async () => {
      const result = await run(['docker', 'container', 'prune', '-f'], { timeout: 300_000 })
      return { ok: result.ok, message: result.ok ? undefined : reason(result, 'docker prune failed.') }
    },
  },
  {
    id: 'docker-images',
    title: 'Unused Docker images',
    description: 'Every image that no container uses, tagged or not. They are downloaded or built again when needed.',
    recommended: false,
    kind: 'disk',
    available: () => has('docker'),
    measure: async () => ({ bytes: await unusedImages() }),
    clean: async () => {
      const result = await run(['docker', 'image', 'prune', '-a', '-f'], { timeout: 600_000 })
      return { ok: result.ok, message: result.ok ? undefined : reason(result, 'docker prune failed.') }
    },
  },
  {
    id: 'leftover-config',
    title: 'Settings of removed packages',
    description: 'Configuration files left behind by packages that were uninstalled. Reinstalling one starts from its defaults.',
    recommended: false,
    kind: 'disk',
    measure: async () => ({ bytes: null, note: count(await leftoverConfigs(), 'package') }),
    clean: async () => {
      const names = await leftoverConfigs()
      if (!names.length) return { ok: true }
      const result = await run(['dpkg', '--purge', ...names], { timeout: 300_000, env: { DEBIAN_FRONTEND: 'noninteractive' } })
      return { ok: result.ok, message: result.ok ? undefined : reason(result, 'dpkg --purge failed.') }
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
    measure: async () => ({ bytes: await contentSize(toolCaches()) }),
    clean: async () => {
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
    id: 'page-cache',
    title: 'Memory page cache',
    description:
      'Asks the kernel to drop cached file data from memory. Linux frees this on its own when needed, so this is rarely useful and disk reads are slower for a while afterwards.',
    recommended: false,
    kind: 'memory',
    measure: async () => ({ bytes: memory().cached, note: 'memory' }),
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
      }
    }),
  )
}

let running = false

export async function runCleanup(ids: string[]) {
  if (running) return { ok: false, message: 'A cleanup is already running.', results: [], freed: 0 }
  running = true
  try {
    const results = []
    for (const task of active().filter((candidate) => ids.includes(candidate.id))) {
      const before = await task.measure()
      let outcome: { ok: boolean; message?: string }
      try {
        outcome = await task.clean()
      } catch (error) {
        outcome = { ok: false, message: error instanceof Error ? error.message : 'Cleanup failed.' }
      }
      const after = await task.measure()
      const freed =
        task.kind === 'disk' && before.bytes !== null && after.bytes !== null
          ? Math.max(0, before.bytes - after.bytes)
          : 0
      logActivity({
        area: 'cleanup',
        action: outcome.ok ? 'Cleaned' : 'Cleanup failed',
        target: task.title,
        detail: outcome.message ?? '',
        ok: outcome.ok,
        freed,
      })
      results.push({ id: task.id, title: task.title, ok: outcome.ok, message: outcome.message ?? null, freed })
    }
    return {
      ok: results.every((result) => result.ok),
      message: '',
      results,
      freed: results.reduce((total, result) => total + result.freed, 0),
    }
  } finally {
    running = false
  }
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
  await runCleanup(tasks.filter((task) => task.recommended).map((task) => task.id))
}

/** Once a week, cleans the items that are always safe to remove. */
export function startScheduledCleanup() {
  setInterval(() => void scheduled(), 3_600_000)
}
