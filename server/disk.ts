import { realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { lines, run } from './sys.ts'

export interface Entry {
  path: string
  name: string
  size: number
  directory: boolean
}

const PSEUDO = ['/proc', '/sys', '/dev', '/run']

export async function usage(input: string): Promise<{ path: string; parent: string | null; total: number; entries: Entry[] } | null> {
  let path: string
  try {
    path = realpathSync(input || '/')
    if (!statSync(path).isDirectory()) return null
  } catch {
    return null
  }
  if (PSEUDO.some((pseudo) => path === pseudo || path.startsWith(`${pseudo}/`))) return null

  // -x keeps the scan on one filesystem, so mounts and /proc are never walked.
  const result = await run(['du', '-x', '-a', '-B1', '--max-depth=1', '--', path], { timeout: 120_000 })
  let total = 0
  const entries: Entry[] = []

  for (const line of lines(result.stdout)) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const size = Number(line.slice(0, tab))
    const entryPath = line.slice(tab + 1)
    if (entryPath === path) {
      total = size
      continue
    }
    let directory = false
    try {
      directory = statSync(entryPath).isDirectory()
    } catch {
      // Removed while scanning; keep the size that was measured.
    }
    entries.push({ path: entryPath, name: entryPath.slice(path === '/' ? 1 : path.length + 1), size, directory })
  }

  entries.sort((a, b) => b.size - a.size)
  return { path, parent: path === '/' ? null : dirname(path), total, entries: entries.slice(0, 200) }
}
