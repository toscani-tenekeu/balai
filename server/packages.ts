import { logActivity } from './db.ts'
import { backend, type InstalledPackage, type Upgrade } from './pm.ts'
import { getJob, runningJob, startJob } from './jobs.ts'
import { eachLine, reason, spawn } from './sys.ts'

export type { InstalledPackage, Upgrade } from './pm.ts'

export interface PackageState {
  upgrades: Upgrade[]
  rebootRequired: boolean
  rebootPackages: string[]
  indexAge: number | null
  checkedAt: number
  /** The package manager in use, or null when this system's is not supported. */
  manager: string | null
  canUpgradeOne: boolean
  canPurge: boolean
  tracksSecurity: boolean
}

let cache: PackageState | null = null

export async function packageState(fresh = false): Promise<PackageState> {
  if (cache && !fresh && Date.now() - cache.checkedAt < 300_000) return cache
  if (!backend) {
    return {
      upgrades: [], rebootRequired: false, rebootPackages: [], indexAge: null, checkedAt: Date.now(),
      manager: null, canUpgradeOne: false, canPurge: false, tracksSecurity: false,
    }
  }
  const [upgrades, reboot, indexAge] = await Promise.all([backend.upgrades(), backend.reboot(), backend.indexAge()])
  cache = {
    upgrades: upgrades.sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name)),
    rebootRequired: reboot.required,
    rebootPackages: reboot.packages,
    indexAge,
    checkedAt: Date.now(),
    manager: backend.id,
    canUpgradeOne: backend.canUpgradeOne,
    canPurge: backend.canPurge,
    tracksSecurity: backend.tracksSecurity,
  }
  return cache
}

const UNSUPPORTED = 'Balai does not know the package manager of this system.'

export async function refreshIndex(): Promise<{ ok: boolean; message: string }> {
  if (!backend) return { ok: false, message: UNSUPPORTED }
  const result = await backend.refresh()
  const message = result.ok ? 'Package lists are up to date.' : reason(result, 'The package lists could not be refreshed.')
  logActivity({ area: 'packages', action: 'Refreshed package lists', detail: result.ok ? '' : message, ok: result.ok })
  cache = null
  return { ok: result.ok, message }
}

const PACKAGE = /^[A-Za-z0-9][A-Za-z0-9+._@-]{0,99}(:[a-z0-9-]+)?$/

export async function installedPackages(): Promise<InstalledPackage[]> {
  if (!backend) return []
  return (await backend.installed()).sort((a, b) => a.name.localeCompare(b.name))
}

/** What removing a package would take with it, worked out by the package manager without changing anything. */
export async function removalPlan(name: string) {
  if (!backend) return { ok: false as const, message: UNSUPPORTED }
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

  const simulation = await backend.simulateRemove(name)
  if (!simulation.ok) return { ok: false as const, message: simulation.message }

  const removed = simulation.removed.length ? simulation.removed : [name]
  const blocked = removed.filter((item) => find(item)?.locked)
  const warnings: string[] = []
  if (removed.some((item) => /^(openssh(-server)?|ssh|dropbear)$/.test(item))) {
    warnings.push('This removes the SSH server. You will no longer be able to connect to this server remotely.')
  }
  if (removed.some((item) => /^(sudo|ufw|firewalld|nftables|iptables|cron|cronie|chrony|systemd-timesyncd|netplan\.io|ifupdown|network-manager|NetworkManager|cloud-init|wicked)$/.test(item))) {
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
  id: string
  title: string
  running: boolean
  ok: boolean | null
  output: string[]
  startedAt: number
  finishedAt: number | null
}

let last: string | null = null

/** The latest package task, in the shape the Packages page reads. */
export function packageJob(): Job | null {
  const found = last ? getJob(last)?.job : null
  if (!found) return null
  return {
    id: found.id,
    title: found.title,
    running: found.state === 'running',
    ok: found.state === 'running' ? null : found.state === 'done',
    output: found.output,
    startedAt: found.startedAt,
    finishedAt: found.finishedAt,
  }
}

export const packageJobRunning = () => runningJob('packages') !== null

/** dpkg's percentage counter, which would fill the output with noise. */
const PROGRESS = /^\(Reading database \.\.\. \d*%?$/

/** Package work can take minutes, so it runs as a task and the interface follows its output. */
function start(title: string, cmd: string[], entry: { action: string; target?: string }): { ok: boolean; message: string } {
  if (packageJobRunning()) return { ok: false, message: 'Another package operation is still running.' }
  const job = startJob(
    {
      kind: 'packages',
      title,
      link: '/packages',
      cancellable: false,
      keep: 'Stopping the package manager halfway can leave packages half installed, so this task runs to the end.',
    },
    async (handle) => {
      let ok = false
      try {
        const proc = spawn(cmd, { timeout: 1_800_000, env: backend?.env })
        const keep = (line: string) => {
          if (PROGRESS.test(line)) return
          handle.log(line)
          handle.job.now = line.slice(0, 200)
        }
        const [, , code] = await Promise.all([eachLine(proc.stdout, keep), eachLine(proc.stderr, keep), proc.exited])
        ok = code === 0
      } catch (error) {
        handle.log(error instanceof Error ? error.message : String(error))
      }
      cache = null
      logActivity({
        area: 'packages',
        action: ok ? entry.action : `${entry.action}: failed`,
        target: entry.target,
        detail: ok ? '' : handle.job.output.slice(-8).join('\n'),
        ok,
      })
      if (!ok) throw new Error(handle.job.output.at(-1) ?? `${title} failed.`)
      return { message: `${title}: done.` }
    },
  )
  last = job.id
  return { ok: true, message: `${title} started.` }
}

export async function upgradePackages(name: string | null) {
  if (!backend) return { ok: false, message: UNSUPPORTED }
  if (name === null) return start('Installing all updates', backend.upgradeCommand(null), { action: 'Installed all updates' })
  if (!backend.canUpgradeOne) return { ok: false, message: 'This system only supports installing all updates at once.' }
  if (!PACKAGE.test(name)) return { ok: false, message: 'Invalid package name.' }
  return start(`Updating ${name}`, backend.upgradeCommand(name), { action: 'Updated package', target: name })
}

export async function removePackage(name: string, purge: boolean) {
  const plan = await removalPlan(name)
  if (!plan.ok) return { ok: false, message: plan.message }
  if (plan.blocked.length) {
    return { ok: false, message: `The system needs ${plan.blocked.slice(0, 3).join(', ')}. Nothing was removed.` }
  }
  const withSettings = purge && backend!.canPurge
  return start(`Uninstalling ${name}`, backend!.removeCommand(name, withSettings), {
    action: withSettings ? 'Uninstalled package and its settings' : 'Uninstalled package',
    target: name,
  })
}
