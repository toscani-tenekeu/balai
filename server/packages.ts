import { logActivity } from './db.ts'
import { backend, type InstalledPackage, type Upgrade } from './pm.ts'
import { reason } from './sys.ts'

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
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...backend?.env },
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
