import { existsSync } from 'node:fs'
import os from 'node:os'
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

export interface InstalledPackage {
  name: string
  version: string
  size: number
  summary: string
  /** Chosen by someone, as opposed to pulled in as a dependency. */
  manual: boolean
  /** Part of the base system; the panel will not remove it. */
  locked: boolean
}

const PACKAGE = /^[a-z0-9][a-z0-9+.-]{1,99}(:[a-z0-9-]+)?$/
const BASE_PRIORITIES = ['required', 'important']
const KERNEL = os.release()

function lockedName(name: string): boolean {
  const base = name.split(':')[0]!
  return base.includes(KERNEL) || /^(grub|shim|linux-image-(generic|virtual|amd64|arm64|cloud)$)/.test(base)
}

export async function installedPackages(): Promise<InstalledPackage[]> {
  const [query, manual] = await Promise.all([
    run([
      'dpkg-query', '-W',
      '-f=${binary:Package}\\t${Version}\\t${Installed-Size}\\t${db:Status-Abbrev}\\t${Essential}\\t${Priority}\\t${binary:Summary}\\n',
    ], { timeout: 30_000 }),
    run(['apt-mark', 'showmanual'], { timeout: 30_000 }),
  ])
  const chosen = new Set(lines(manual.stdout))
  const list: InstalledPackage[] = []
  for (const line of query.stdout.split('\n')) {
    const [name, version, size, status, essential, priority, summary] = line.split('\t')
    if (!name || !status?.startsWith('ii')) continue
    list.push({
      name,
      version: version ?? '',
      size: (Number(size) || 0) * 1024,
      summary: summary ?? '',
      manual: chosen.has(name) || chosen.has(name.split(':')[0]!),
      locked: essential === 'yes' || BASE_PRIORITIES.includes(priority ?? '') || lockedName(name),
    })
  }
  return list.sort((a, b) => a.name.localeCompare(b.name))
}

const APT = [
  'apt-get', '-y', '-q',
  '-o', 'DPkg::Lock::Timeout=120',
  '-o', 'Dpkg::Options::=--force-confdef',
  '-o', 'Dpkg::Options::=--force-confold',
]
// Config files already on the server are kept, and no question is ever asked.
const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', APT_LISTCHANGES_FRONTEND: 'none', NEEDRESTART_SUSPEND: '1' }

/** What removing a package would take with it, worked out by apt without changing anything. */
export async function removalPlan(name: string) {
  if (!PACKAGE.test(name)) return { ok: false as const, message: 'Invalid package name.' }
  const installed = await installedPackages()
  // dpkg names some packages with their architecture (libc6:amd64) and apt does not, so both forms are indexed.
  const byName = new Map(installed.flatMap((item) => [[item.name.split(':')[0]!, item], [item.name, item]] as const))
  const find = (item: string) => byName.get(item) ?? byName.get(item.split(':')[0]!)
  const target = find(name)
  if (!target) return { ok: false as const, message: 'That package is not installed.' }
  if (target.locked) {
    return { ok: true as const, name, removed: [name], size: target.size, blocked: [name], warnings: [] }
  }

  const result = await run(['apt-get', '-s', 'remove', name], { timeout: 60_000 })
  if (!result.ok) return { ok: false as const, message: reason(result, 'apt could not work out the removal.') }

  const removed = lines(result.stdout)
    .map((line) => line.match(/^Remv (\S+)/)?.[1])
    .filter((item): item is string => Boolean(item))
  const blocked = removed.filter((item) => find(item)?.locked ?? lockedName(item))
  const warnings: string[] = []
  if (removed.some((item) => /^openssh-server|^ssh$/.test(item))) {
    warnings.push('This removes the SSH server. You will no longer be able to connect to this server remotely.')
  }
  if (removed.some((item) => /^(sudo|ufw|nftables|iptables|cron|systemd-timesyncd|netplan\.io|ifupdown|network-manager|cloud-init)$/.test(item))) {
    warnings.push('This removes a tool the system relies on for access, networking or scheduled tasks.')
  }

  return {
    ok: true as const,
    name,
    removed,
    size: removed.reduce((total, item) => total + (find(item)?.size ?? 0), 0),
    blocked,
    warnings,
  }
}

export interface Job {
  id: number
  title: string
  running: boolean
  ok: boolean | null
  output: string[]
  startedAt: number
  finishedAt: number | null
}

let job: Job | null = null
let jobs = 0

export const packageJob = () => job
export const packageJobRunning = () => job?.running === true

/** dpkg's percentage counter, which would fill the output with noise. */
const PROGRESS = /^\(Reading database \.\.\. \d*%?$/

async function collect(stream: ReadableStream<Uint8Array>, output: string[]) {
  const decoder = new TextDecoder()
  let rest = ''
  for await (const chunk of stream) {
    const parts = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n|\r/)
    rest = parts.pop() ?? ''
    for (const part of parts) if (part.trim() && !PROGRESS.test(part)) output.push(part)
    if (output.length > 400) output.splice(0, output.length - 400)
  }
  if (rest.trim()) output.push(rest)
}

/** Package work can take minutes, so it runs in the background and the interface follows its output. */
function start(title: string, cmd: string[], entry: { action: string; target?: string }): { ok: boolean; message: string } {
  if (job?.running) return { ok: false, message: 'Another package operation is still running.' }
  const current: Job = { id: ++jobs, title, running: true, ok: null, output: [], startedAt: Date.now(), finishedAt: null }
  job = current

  void (async () => {
    let ok = false
    try {
      const proc = Bun.spawn(cmd, {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 1_800_000,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...APT_ENV },
      })
      const [, , code] = await Promise.all([
        collect(proc.stdout, current.output),
        collect(proc.stderr, current.output),
        proc.exited,
      ])
      ok = code === 0
    } catch (error) {
      current.output.push(error instanceof Error ? error.message : String(error))
    }
    current.running = false
    current.ok = ok
    current.finishedAt = Date.now()
    cache = null
    logActivity({
      area: 'packages',
      action: ok ? entry.action : `${entry.action}: failed`,
      target: entry.target,
      detail: ok ? '' : current.output.slice(-8).join('\n'),
      ok,
    })
  })()

  return { ok: true, message: `${title} started.` }
}

export async function upgradePackages(name: string | null) {
  if (name === null) return start('Installing all updates', [...APT, 'upgrade'], { action: 'Installed all updates' })
  if (!PACKAGE.test(name)) return { ok: false, message: 'Invalid package name.' }
  return start(`Updating ${name}`, [...APT, 'install', '--only-upgrade', name], { action: 'Updated package', target: name })
}

export async function removePackage(name: string, purge: boolean) {
  const plan = await removalPlan(name)
  if (!plan.ok) return { ok: false, message: plan.message }
  if (plan.blocked.length) {
    return { ok: false, message: `The system needs ${plan.blocked.slice(0, 3).join(', ')}. Nothing was removed.` }
  }
  return start(`Uninstalling ${name}`, [...APT, purge ? 'purge' : 'remove', name], {
    action: purge ? 'Uninstalled package and its settings' : 'Uninstalled package',
    target: name,
  })
}
