import { readdirSync, readlinkSync, statSync } from 'node:fs'
import os from 'node:os'
import { filesystems, memory } from './metrics.ts'
import { packageState } from './packages.ts'
import { listProcesses } from './processes.ts'
import { failedUnits } from './services.ts'
import { has, lines, readText, run } from './sys.ts'

export type Status = 'ok' | 'warning' | 'critical'

export interface Check {
  id: string
  title: string
  status: Status
  detail: string
  /** Page where the problem can be looked at or fixed. */
  link: string | null
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

async function diskChecks(): Promise<Check[]> {
  const checks: Check[] = []
  for (const fs of await filesystems()) {
    const percent = Math.round(fs.percent)
    checks.push({
      id: `disk:${fs.mount}`,
      title: `Disk space on ${fs.mount}`,
      status: percent >= 95 ? 'critical' : percent >= 85 ? 'warning' : 'ok',
      detail: `${percent}% used, ${gib(fs.available)} free`,
      link: '/cleanup',
    })
    if (fs.inodesPercent !== null && fs.inodesPercent >= 85) {
      checks.push({
        id: `inodes:${fs.mount}`,
        title: `File count on ${fs.mount}`,
        status: fs.inodesPercent >= 95 ? 'critical' : 'warning',
        detail: `${fs.inodesPercent}% of inodes used. Too many small files, even with space left.`,
        link: '/disk',
      })
    }
  }
  return checks
}

function memoryChecks(): Check[] {
  const mem = memory()
  const free = mem.total ? (mem.available / mem.total) * 100 : 100
  const checks: Check[] = [
    {
      id: 'memory',
      title: 'Memory',
      status: free < 5 ? 'critical' : free < 10 ? 'warning' : 'ok',
      detail: `${gib(mem.available)} of ${gib(mem.total)} available`,
      link: '/processes',
    },
  ]
  if (mem.swapTotal > 0) {
    checks.push({
      id: 'swap',
      title: 'Swap',
      status: mem.swapPercent >= 80 ? 'critical' : mem.swapPercent >= 50 ? 'warning' : 'ok',
      detail: `${Math.round(mem.swapPercent)}% in use`,
      link: '/processes',
    })
  }
  return checks
}

function loadCheck(): Check {
  const cores = os.cpus().length || 1
  const five = os.loadavg()[1] ?? 0
  return {
    id: 'load',
    title: 'System load',
    status: five > cores * 2 ? 'critical' : five > cores ? 'warning' : 'ok',
    detail: `${five.toFixed(2)} over 5 minutes on ${plural(cores, 'core')}`,
    link: '/processes',
  }
}

async function serviceCheck(): Promise<Check> {
  const failed = await failedUnits()
  return {
    id: 'services',
    title: 'Services',
    status: failed.length ? 'critical' : 'ok',
    detail: failed.length ? `Failed: ${failed.slice(0, 4).join(', ')}${failed.length > 4 ? '…' : ''}` : 'No failed units',
    link: '/services',
  }
}

async function zombieCheck(): Promise<Check> {
  const zombies = (await listProcesses()).filter((proc) => proc.state.startsWith('Z'))
  return {
    id: 'zombies',
    title: 'Zombie processes',
    status: zombies.length >= 10 ? 'warning' : 'ok',
    detail: zombies.length ? `${plural(zombies.length, 'zombie')} waiting to be reaped` : 'None',
    link: '/processes',
  }
}

async function updateChecks(): Promise<Check[]> {
  const state = await packageState()
  if (!state.manager) return []
  const security = state.upgrades.filter((upgrade) => upgrade.security).length
  const total = state.upgrades.length
  return [
    {
      id: 'updates',
      title: 'Package updates',
      status: security ? 'warning' : 'ok',
      detail: total
        ? `${plural(total, 'update')} available${security ? `, ${security} for security` : ''}`
        : 'Everything is up to date',
      link: '/packages',
    },
    {
      id: 'reboot',
      title: 'Restart',
      status: state.rebootRequired ? 'warning' : 'ok',
      detail: state.rebootRequired ? 'A restart is needed to finish installing updates' : 'Not needed',
      link: '/packages',
    },
  ]
}

async function oomCheck(): Promise<Check | null> {
  if (!has('journalctl')) return null
  const result = await run(
    ['journalctl', '-k', '--since', '-24h', '-g', 'Out of memory', '-q', '--no-pager', '-o', 'cat'],
    { timeout: 20_000 },
  )
  const kills = lines(result.stdout).length
  return {
    id: 'oom',
    title: 'Out-of-memory kills',
    status: kills ? 'warning' : 'ok',
    detail: kills ? `${plural(kills, 'kill')} by the kernel in the last 24 hours` : 'None in the last 24 hours',
    link: '/processes',
  }
}

async function clockCheck(): Promise<Check | null> {
  if (!has('timedatectl')) return null
  const result = await run(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value'])
  const value = result.stdout.trim()
  if (!result.ok || !value) return null
  return {
    id: 'clock',
    title: 'Clock',
    status: value === 'yes' ? 'ok' : 'warning',
    detail: value === 'yes' ? 'Synchronised' : 'Not synchronised with a time server',
    link: null,
  }
}

/** Space that a deleted file keeps using until the program holding it open is restarted. */
function heldSpaceCheck(): Check | null {
  const seen = new Set<string>()
  const perProgram = new Map<string, number>()
  let total = 0
  let pids: string[]
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch {
    return null
  }
  for (const pid of pids) {
    let fds: string[]
    try {
      fds = readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`)
        if (!target.endsWith(' (deleted)') || !target.startsWith('/') || /^\/(dev|run|memfd|SYSV)/.test(target)) continue
        const stat = statSync(`/proc/${pid}/fd/${fd}`)
        const key = `${stat.dev}:${stat.ino}`
        if (!stat.isFile() || stat.nlink > 0 || seen.has(key)) continue
        seen.add(key)
        const size = stat.blocks * 512
        total += size
        const name = readText(`/proc/${pid}/comm`).trim() || pid
        perProgram.set(name, (perProgram.get(name) ?? 0) + size)
      } catch {
        // The descriptor was closed in the meantime.
      }
    }
  }
  if (total < 200 * 1024 ** 2) return null
  const [program] = [...perProgram.entries()].sort((a, b) => b[1] - a[1])[0]!
  return {
    id: 'held-space',
    title: 'Space held by deleted files',
    status: total >= 2 * 1024 ** 3 ? 'critical' : 'warning',
    detail: `${gib(total)} belongs to files that were deleted while still open, mostly by ${program}. Restarting that program frees it.`,
    link: '/services',
  }
}

const ORDER: Record<Status, number> = { critical: 0, warning: 1, ok: 2 }

export async function health() {
  const groups = await Promise.all([
    diskChecks(),
    memoryChecks(),
    loadCheck(),
    serviceCheck(),
    zombieCheck(),
    updateChecks(),
    oomCheck(),
    clockCheck(),
    heldSpaceCheck(),
  ])
  const checks = groups.flat().filter((check): check is Check => check !== null)
  checks.sort((a, b) => ORDER[a.status] - ORDER[b.status])
  const status: Status = checks.some((check) => check.status === 'critical')
    ? 'critical'
    : checks.some((check) => check.status === 'warning')
      ? 'warning'
      : 'ok'
  return { status, checks }
}
