import { existsSync } from 'node:fs'
import { logActivity } from './db.ts'
import { lines, readText, reason, run } from './sys.ts'

export interface Upgrade {
  name: string
  current: string
  next: string
  security: boolean
}

export interface PackageState {
  upgrades: Upgrade[]
  rebootRequired: boolean
  rebootPackages: string[]
  indexAge: number | null
  checkedAt: number
}

let cache: PackageState | null = null

async function indexAge(): Promise<number | null> {
  for (const path of ['/var/lib/apt/periodic/update-success-stamp', '/var/cache/apt/pkgcache.bin']) {
    const file = Bun.file(path)
    if (await file.exists()) return Math.round((Date.now() - file.lastModified) / 1000)
  }
  return null
}

export async function packageState(fresh = false): Promise<PackageState> {
  if (cache && !fresh && Date.now() - cache.checkedAt < 300_000) return cache

  const result = await run(['apt', 'list', '--upgradable'], { timeout: 60_000 })
  const upgrades: Upgrade[] = []
  for (const line of lines(result.stdout)) {
    const match = line.match(/^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/)
    if (!match) continue
    upgrades.push({
      name: match[1]!,
      next: match[3]!,
      current: match[4]!,
      security: match[2]!.includes('-security'),
    })
  }

  cache = {
    upgrades: upgrades.sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name)),
    rebootRequired: existsSync('/var/run/reboot-required'),
    rebootPackages: lines(readText('/var/run/reboot-required.pkgs')),
    indexAge: await indexAge(),
    checkedAt: Date.now(),
  }
  return cache
}

export async function refreshIndex(): Promise<{ ok: boolean; message: string }> {
  const result = await run(['apt-get', 'update', '-q'], {
    timeout: 180_000,
    env: { DEBIAN_FRONTEND: 'noninteractive' },
  })
  const message = result.ok ? 'Package lists are up to date.' : reason(result, 'apt-get update failed.')
  logActivity({ area: 'packages', action: 'Refreshed package lists', detail: result.ok ? '' : message, ok: result.ok })
  cache = null
  return { ok: result.ok, message }
}
