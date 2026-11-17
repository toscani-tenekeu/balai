import os from 'node:os'
import { config } from './config.ts'
import { db, prune } from './db.ts'
import { lines, readText, run } from './sys.ts'

export interface Filesystem {
  source: string
  type: string
  mount: string
  size: number
  used: number
  available: number
  percent: number
  inodesPercent: number | null
}

interface CpuTimes {
  idle: number
  total: number
}

function cpuTimes(): CpuTimes {
  const first = readText('/proc/stat').split('\n')[0] ?? ''
  const values = first.split(/\s+/).slice(1).map(Number)
  const idle = (values[3] ?? 0) + (values[4] ?? 0)
  const total = values.slice(0, 8).reduce((sum, value) => sum + (value || 0), 0)
  return { idle, total }
}

let previous = cpuTimes()
let cpuPercent = 0

function sampleCpu() {
  const current = cpuTimes()
  const total = current.total - previous.total
  const idle = current.idle - previous.idle
  if (total > 0) cpuPercent = Math.max(0, Math.min(100, (1 - idle / total) * 100))
  previous = current
}

export function memory() {
  const info = new Map<string, number>()
  for (const line of lines(readText('/proc/meminfo'))) {
    const match = line.match(/^(\w+):\s+(\d+)/)
    if (match) info.set(match[1]!, Number(match[2]) * 1024)
  }
  const total = info.get('MemTotal') ?? 0
  const available = info.get('MemAvailable') ?? 0
  const swapTotal = info.get('SwapTotal') ?? 0
  const swapFree = info.get('SwapFree') ?? 0
  return {
    total,
    available,
    used: total - available,
    cached: (info.get('Cached') ?? 0) + (info.get('Buffers') ?? 0) + (info.get('SReclaimable') ?? 0),
    percent: total ? ((total - available) / total) * 100 : 0,
    swapTotal,
    swapUsed: swapTotal - swapFree,
    swapPercent: swapTotal ? ((swapTotal - swapFree) / swapTotal) * 100 : 0,
  }
}

const SKIPPED = ['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'efivarfs', 'fuse.snapfuse']

export async function filesystems(): Promise<Filesystem[]> {
  const exclude = SKIPPED.flatMap((type) => ['-x', type])
  const [space, inodes] = await Promise.all([
    run(['df', '-B1', '--output=source,fstype,size,used,avail,target', ...exclude]),
    run(['df', '--output=target,ipcent', ...exclude]),
  ])

  const inodeUse = new Map<string, number>()
  for (const line of lines(inodes.stdout).slice(1)) {
    const match = line.match(/^(.*\S)\s+(\d+)%$/)
    if (match) inodeUse.set(match[1]!, Number(match[2]))
  }

  const seen = new Set<string>()
  const result: Filesystem[] = []
  for (const line of lines(space.stdout).slice(1)) {
    const parts = line.split(/\s+/)
    if (parts.length < 6) continue
    const [source, type, size, used, available] = parts as [string, string, string, string, string]
    const mount = parts.slice(5).join(' ')
    if (seen.has(source) || mount.startsWith('/boot/efi') || Number(size) === 0) continue
    seen.add(source)
    const usable = Number(used) + Number(available)
    result.push({
      source,
      type,
      mount,
      size: Number(size),
      used: Number(used),
      available: Number(available),
      percent: usable ? (Number(used) / usable) * 100 : 0,
      inodesPercent: inodeUse.get(mount) ?? null,
    })
  }
  return result
}

function osName(): string {
  const match = readText('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)"?/m)
  return match?.[1] ?? 'Linux'
}

export async function overview() {
  const cpus = os.cpus()
  const [one, five, fifteen] = os.loadavg() as [number, number, number]
  return {
    host: {
      name: os.hostname(),
      os: osName(),
      kernel: os.release(),
      arch: os.arch(),
      uptime: os.uptime(),
    },
    cpu: {
      model: cpus[0]?.model.trim() ?? 'Unknown',
      cores: cpus.length,
      percent: cpuPercent,
      load: [one, five, fifteen],
    },
    memory: memory(),
    filesystems: await filesystems(),
  }
}

export function history(hours: number) {
  const since = Date.now() - hours * 3_600_000
  return db
    .query<{ at: number; cpu: number; mem: number; disk: number; load: number }, [number]>(
      'SELECT at, cpu, mem, disk, load FROM samples WHERE at >= ? ORDER BY at',
    )
    .all(since)
}

async function record() {
  const root = (await filesystems()).find((fs) => fs.mount === '/')
  db.query('INSERT OR REPLACE INTO samples (at, cpu, mem, disk, load) VALUES (?, ?, ?, ?, ?)').run(
    Date.now(),
    Math.round(cpuPercent * 10) / 10,
    Math.round(memory().percent * 10) / 10,
    Math.round((root?.percent ?? 0) * 10) / 10,
    Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
  )
}

export function startSampling() {
  setInterval(sampleCpu, 5_000)
  setTimeout(() => void record(), 6_000)
  setInterval(() => void record(), config.sampleEverySeconds * 1000)
  prune()
  setInterval(prune, 3_600_000)
}
