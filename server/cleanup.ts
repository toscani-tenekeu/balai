import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logActivity } from './db.ts'
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
