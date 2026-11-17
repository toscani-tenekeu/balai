import { lstatSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { dirname, normalize } from 'node:path'
import { root } from './config.ts'
import { logActivity } from './db.ts'
import { lines, readText, reason, run } from './sys.ts'

export interface FoundFile {
  path: string
  size: number
  modified: number
  locked: boolean
}

/** Trees that belong to the operating system or to the package manager. */
const SYSTEM = [
  '/boot', '/dev', '/proc', '/sys', '/run', '/etc', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32',
  '/usr', '/snap', '/var/lib/dpkg', '/var/lib/apt', '/var/lib/systemd', '/var/lib/docker',
  '/var/lib/containerd', '/var/lib/snapd', '/var/lib/lxc', '/var/lib/lxd', '/var/lib/incus',
]

/** Folders that can be emptied piece by piece but never removed as a whole. */
const KEEP = [
  '/home', '/root', '/var', '/opt', '/srv', '/tmp', '/mnt', '/media', '/usr/local', '/lost+found',
  '/var/log', '/var/lib', '/var/cache', '/var/tmp', '/var/spool', '/var/www', '/var/backups', '/var/mail',
]

/** Never walked by a search: virtual filesystems and container storage. */
const SKIP = [
  '/proc', '/sys', '/dev', '/run', '/snap', '/var/lib/docker', '/var/lib/containerd', '/var/lib/snapd',
  '/var/lib/lxc', '/var/lib/lxd', '/var/lib/incus',
]

const within = (path: string, parent: string) =>
  parent === '/' || path === parent || path.startsWith(`${parent}/`)

/** Swap files in use: deleting one while it is active can bring the server down. */
function swapFiles(): string[] {
  return lines(readText('/proc/swaps')).slice(1).map((line) => line.split(/\s+/)[0]!).concat('/swapfile', '/swap.img')
}

/** True for files the panel refuses to delete. */
export function isSystemPath(path: string): boolean {
  if (within(path, root) || swapFiles().includes(path)) return true
  if (within(path, '/usr/local') && path !== '/usr/local') return false
  return SYSTEM.some((dir) => within(path, dir))
}

/** True for folders the panel refuses to delete. */
export function isKeptFolder(path: string): boolean {
  if (isSystemPath(path)) return true
  if (path.split('/').length <= 2) return true
  if (KEEP.includes(path) || ['/home', '/var'].includes(dirname(path))) return true
  return [...SYSTEM, ...KEEP, root].some((dir) => within(dir, path))
}

function clean(path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || path.length > 4096) return null
  const tidy = normalize(path)
  return tidy.length > 1 ? tidy.replace(/\/+$/, '') : tidy
}

const EXTENSION = /^[a-z0-9][a-z0-9.+_-]{0,19}$/i
const MAX_RESULTS = 1000

export interface SearchInput {
  path: string
  extensions: string[]
  minBytes: number
  olderThanDays: number
}

export async function searchFiles(input: SearchInput) {
  const extensions = [...new Set(input.extensions.map((item) => item.trim().replace(/^[*.]+/, '').toLowerCase()))]
    .filter(Boolean)
  if (extensions.length > 20 || extensions.some((item) => !EXTENSION.test(item))) {
    return { ok: false as const, message: 'Extensions can only contain letters, digits, dots and dashes.' }
  }
  const minBytes = Math.max(0, Math.floor(input.minBytes) || 0)
  const days = Math.max(0, Math.floor(input.olderThanDays) || 0)
  if (!extensions.length && !minBytes) {
    return { ok: false as const, message: 'Give at least one extension or a minimum size.' }
  }

  let path: string
  try {
    path = realpathSync(clean(input.path) ?? '/')
    if (!statSync(path).isDirectory()) throw new Error('not a folder')
  } catch {
    return { ok: false as const, message: 'That folder does not exist.' }
  }
  if (SKIP.some((dir) => within(path, dir))) {
    return { ok: false as const, message: 'That folder is managed by the system and is not searched.' }
  }

  const args = ['find', path]
  const skipped = SKIP.filter((dir) => within(dir, path))
  if (skipped.length) {
    args.push('(')
    skipped.forEach((dir, index) => args.push(...(index ? ['-o'] : []), '-path', dir))
    args.push(')', '-prune', '-o')
  }
  args.push('-type', 'f')
  if (extensions.length) {
    args.push('(')
    extensions.forEach((item, index) => args.push(...(index ? ['-o'] : []), '-iname', `*.${item}`))
    args.push(')')
  }
  if (minBytes) args.push('-size', `+${minBytes - 1}c`)
  if (days) args.push('-mtime', `+${days - 1}`)
  args.push('-printf', '%s\\t%T@\\t%p\\0')

  const result = await run(args, { timeout: 180_000 })
  // find exits with 1 when a folder vanished or could not be read; the rest of the output is still good.
  if (result.code !== 0 && !result.stdout) {
    return { ok: false as const, message: result.code === -1 ? 'The search could not start.' : 'Nothing could be read in that folder.' }
  }

  const files: FoundFile[] = []
  let total = 0
  for (const record of result.stdout.split('\0')) {
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const size = Number(record.slice(0, first))
    const file = record.slice(second + 1)
    total += size
    files.push({
      path: file,
      size,
      modified: Math.round(Number(record.slice(first + 1, second)) * 1000),
      locked: isSystemPath(file),
    })
  }
  files.sort((a, b) => b.size - a.size)

  return {
    ok: true as const,
    path,
    extensions,
    count: files.length,
    total,
    truncated: files.length > MAX_RESULTS,
    files: files.slice(0, MAX_RESULTS),
  }
}

export function deleteFiles(input: unknown[]) {
  const failed: { path: string; message: string }[] = []
  const deleted: string[] = []
  let freed = 0

  for (const raw of input.slice(0, 5000)) {
    const path = clean(raw)
    if (!path) continue
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Not a file.')
      if (isSystemPath(path)) throw new Error('System file, left in place.')
      unlinkSync(path)
      deleted.push(path)
      if (stat.isFile() && stat.nlink === 1) freed += stat.blocks * 512
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const message =
        code === 'ENOENT' ? 'Already gone.'
        : code === 'EACCES' || code === 'EPERM' ? 'Permission denied.'
        : error instanceof Error ? error.message : 'Could not be deleted.'
      failed.push({ path, message })
    }
  }

  if (deleted.length) {
    logActivity({
      area: 'files',
      action: deleted.length === 1 ? 'Deleted file' : `Deleted ${deleted.length} files`,
      target: deleted.length === 1 ? deleted[0] : dirname(deleted[0]!),
      detail: deleted.length === 1 ? '' : deleted.join('\n'),
      freed,
    })
  }
  return { ok: failed.length === 0, deleted: deleted.length, freed, failed: failed.slice(0, 50) }
}

function isMountPoint(path: string): boolean {
  try {
    return lstatSync(path).dev !== lstatSync(dirname(path)).dev
  } catch {
    return false
  }
}

export async function deleteFolder(input: unknown): Promise<{ ok: boolean; message: string; freed: number }> {
  const path = clean(input)
  if (!path) return { ok: false, message: 'Invalid path.', freed: 0 }
  try {
    if (!lstatSync(path).isDirectory()) return { ok: false, message: 'Not a folder.', freed: 0 }
  } catch {
    return { ok: false, message: 'That folder does not exist.', freed: 0 }
  }
  if (isKeptFolder(path)) return { ok: false, message: 'The system needs this folder. It was left in place.', freed: 0 }
  if (isMountPoint(path)) return { ok: false, message: 'This folder is a mounted disk. Unmount it first.', freed: 0 }

  const measured = await run(['du', '-sxB1', '--', path], { timeout: 120_000 })
  const size = Number(lines(measured.stdout).at(-1)?.split('\t')[0]) || 0
  const result = await run(['rm', '-rf', '--one-file-system', '--', path], { timeout: 600_000 })
  const message = result.ok ? `Deleted ${path}` : reason(result, 'The folder could not be deleted.')
  logActivity({
    area: 'files',
    action: result.ok ? 'Deleted folder' : 'Delete failed',
    target: path,
    detail: result.ok ? '' : message,
    ok: result.ok,
    freed: result.ok ? size : 0,
  })
  return { ok: result.ok, message, freed: result.ok ? size : 0 }
}
