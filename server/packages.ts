import { getSetting, logActivity, setSetting } from './db.ts'
import { filesystems } from './metrics.ts'
import { backend, type InstalledPackage, type Upgrade, type UpgradeSize } from './pm.ts'
import { getJob, runningJob, startJob } from './jobs.ts'
import { heldPackages, packageFiles } from './pkginfo.ts'
import { eachLine, formatBytes, lines, reason, run, spawn } from './sys.ts'

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
function start(
  title: string,
  cmd: string[],
  entry: { action: string; target?: string },
  estimate: number | null = null,
): { ok: boolean; message: string } {
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
      planCache = null
      if (ok && estimate) learn(estimate / learned().factor, (Date.now() - handle.job.startedAt) / 1000)
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
  if (name !== null && !backend.canUpgradeOne) return { ok: false, message: 'This system only supports installing all updates at once.' }
  if (name !== null && !PACKAGE.test(name)) return { ok: false, message: 'Invalid package name.' }
  const plan = await updatePlan(name).catch(() => null)
  const estimate = plan?.ok ? plan.seconds : null
  if (name === null) return start('Installing all updates', backend.upgradeCommand(null), { action: 'Installed all updates' }, estimate)
  return start(`Updating ${name}`, backend.upgradeCommand(name), { action: 'Updated package', target: name }, estimate)
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

// ---- Update plan --------------------------------------------------------------------

export interface PlanPackage {
  name: string
  download: number | null
  /** Installed size after the update minus before; null when unknown. */
  change: number | null
  cached: boolean
  restart: boolean
  risk: Risk
}

export interface Risk {
  level: 'safe' | 'caution' | 'blocked'
  reasons: string[]
}

export interface DiskImpact {
  mount: string
  free: number
  size: number
  /** Free space once the update is installed, and at the lowest point while it runs. */
  after: number
  during: number
  uses: string[]
}

export interface UpdatePlan {
  ok: true
  name: string | null
  count: number
  packages: PlanPackage[]
  download: number
  cachedBytes: number
  change: number
  /** Packages whose sizes the package manager did not report. */
  unknown: number
  disks: DiskImpact[]
  seconds: number
  /** How many earlier updates on this server the time estimate is based on. */
  learnedFrom: number
  restart: string[]
  keptBack: string[]
  warnings: string[]
  /** Updates that "install all" leaves out, and those worth a look first. */
  blocked: number
  risky: number
}

/** Updates to these usually only take full effect after a restart of the server. */
const NEEDS_RESTART = /^(linux-(image|modules|headers)|linux(-lts|-zen|-hardened|-virt)?$|kernel(-core|-modules|-default)?$|libc6$|glibc$|systemd$|dbus|libssl|openssl$|microcode|intel-ucode|amd-ucode|linux-firmware)/

const CACHE_DIR: Record<string, string> = {
  apt: '/var/cache/apt/archives',
  dnf: '/var/cache/dnf',
  yum: '/var/cache/yum',
  zypper: '/var/cache/zypp',
  pacman: '/var/cache/pacman/pkg',
  apk: '/var/cache/apk',
}
/** Managers that remove downloaded packages once installed, by default. */
const DROPS_CACHE = new Set(['dnf', 'yum', 'zypper', 'apk'])

/** Seconds a run takes before the learned correction: downloading, then unpacking and configuring each package. */
function baseSeconds(download: number, packages: number, installed: number): number {
  return 8 + download / (5 * 1024 ** 2) + packages * 1.5 + installed / (40 * 1024 ** 2)
}

function learned(): { factor: number; runs: number } {
  const factor = Number(getSetting('pkg_time_factor')) || 1
  const runs = Number(getSetting('pkg_time_runs')) || 0
  return { factor, runs }
}

/** After an update, moves the estimate towards what this server really took. */
function learn(predicted: number, actual: number) {
  if (predicted <= 0 || actual <= 0) return
  const { factor, runs } = learned()
  const seen = Math.min(5, Math.max(0.2, actual / predicted))
  const next = runs ? factor * 0.6 + seen * 0.4 : seen
  setSetting('pkg_time_factor', String(Math.round(next * 1000) / 1000))
  setSetting('pkg_time_runs', String(runs + 1))
}

const mountOf = <T extends { mount: string }>(path: string, mounts: T[]): T | undefined =>
  mounts.filter((fs) => fs.mount === '/' || path === fs.mount || path.startsWith(`${fs.mount}/`)).sort((a, b) => b.mount.length - a.mount.length)[0]

let planCache: { key: string; at: number; plan: UpdatePlan } | null = null

/** What installing one update, or all of them, will take: download, disk space, time and restarts. */
export async function updatePlan(name: string | null): Promise<UpdatePlan | { ok: false; message: string }> {
  if (!backend) return { ok: false, message: UNSUPPORTED }
  if (name !== null && !PACKAGE.test(name)) return { ok: false, message: 'Invalid package name.' }
  const state = await packageState()
  const key = `${name}|${state.checkedAt}`
  if (planCache?.key === key && Date.now() - planCache.at < 120_000) return planCache.plan

  const upgrades: Upgrade[] = name === null ? state.upgrades : state.upgrades.filter((item) => item.name === name)
  if (name !== null && !upgrades.length) return { ok: false, message: 'There is no update for that package.' }

  const [sizes, installed, keptBack, disks] = await Promise.all([
    backend.sizes?.(upgrades).catch(() => new Map<string, UpgradeSize>()) ?? Promise.resolve(new Map<string, UpgradeSize>()),
    installedPackages(),
    name === null && backend.keptBack ? backend.keptBack().catch(() => []) : Promise.resolve([] as string[]),
    filesystems(),
  ])
  const current = new Map(installed.flatMap((item) => [[item.name, item.size], [item.name.split(':')[0]!, item.size]] as const))

  const packages: PlanPackage[] = upgrades.map((item) => {
    const size = sizes.get(item.name) ?? sizes.get(item.name.split(':')[0]!)
    const before = current.get(item.name) ?? current.get(item.name.split(':')[0]!)
    return {
      name: item.name,
      download: size?.download ?? null,
      change: size?.installed != null && before != null ? size.installed - before : null,
      cached: size?.cached ?? false,
      restart: NEEDS_RESTART.test(item.name),
      risk: { level: 'safe', reasons: [] },
    }
  })

  await assessRisks(upgrades, packages, keptBack)

  const download = packages.reduce((sum, item) => sum + (!item.cached ? item.download ?? 0 : 0), 0)
  const cachedBytes = packages.reduce((sum, item) => sum + (item.cached ? item.download ?? 0 : 0), 0)
  const change = packages.reduce((sum, item) => sum + (item.change ?? 0), 0)
  const unknown = packages.filter((item) => item.download === null && item.change === null).length
  const installedBytes = upgrades.reduce((sum, item) => sum + (sizes.get(item.name)?.installed ?? 0), 0)

  // Programs land on the disk holding /usr; downloads wait on the disk holding the package cache.
  const usr = mountOf('/usr', disks)
  const cache = mountOf(CACHE_DIR[backend.id] ?? '/var/cache', disks)
  const impact = new Map<string, DiskImpact>()
  const touch = (fs: (typeof disks)[number] | undefined, use: string, during: number, after: number) => {
    if (!fs) return
    const entry = impact.get(fs.mount) ?? { mount: fs.mount, free: fs.available, size: fs.size, after: fs.available, during: fs.available, uses: [] }
    entry.uses.push(use)
    entry.after -= after
    entry.during -= during
    impact.set(fs.mount, entry)
  }
  touch(usr, 'programs', Math.max(0, change), change)
  touch(cache, 'downloads', download, DROPS_CACHE.has(backend.id) ? 0 : download)

  const { factor, runs } = learned()
  const seconds = Math.round(baseSeconds(download, upgrades.length, installedBytes) * factor)

  const warnings: string[] = []
  for (const disk of impact.values()) {
    if (disk.during < 0) warnings.push(`${disk.mount} does not have enough free space: about ${formatBytes(-disk.during)} more is needed.`)
    else if (disk.size && disk.during / disk.size < 0.05) warnings.push(`${disk.mount} will be almost full while updating. Free some space first.`)
  }
  if (unknown) warnings.push(`${unknown === upgrades.length ? 'The package manager does not report sizes' : `No sizes for ${unknown} of the packages`}, so the totals are lower than the real ones.`)

  const plan: UpdatePlan = {
    ok: true,
    name,
    count: upgrades.length,
    packages,
    download,
    cachedBytes,
    change,
    unknown,
    disks: [...impact.values()],
    seconds,
    learnedFrom: runs,
    restart: packages.filter((item) => item.restart).map((item) => item.name),
    keptBack,
    warnings,
    blocked: packages.filter((item) => item.risk.level === 'blocked').length,
    risky: packages.filter((item) => item.risk.level === 'caution').length,
  }
  planCache = { key, at: Date.now(), plan }
  return plan
}

// ---- Update risks ------------------------------------------------------------------------------

/** The first number of a version, without the epoch: "1:2.4.58-1" → 2. */
function major(version: string): { epoch: number; major: number | null } {
  const epoch = Number(version.match(/^(\d+):/)?.[1] ?? 0)
  // Only "major.minor" versions say something by their first number; "293ubuntu1" is a counter.
  const value = version.replace(/^\d+:/, '').match(/^(\d+)\.\d/)?.[1]
  return { epoch, major: value === undefined ? null : Number(value) }
}

const DATABASE = /^(postgresql(-\d+)?|mysql-server|mysql-community-server|mariadb-server|mongodb(-org)?(-server)?|redis-server|redis)$/

/** What an update could break, worked out from the package manager and what runs on the server. */
async function assessRisks(upgrades: Upgrade[], packages: PlanPackage[], keptBack: string[]) {
  const held = await heldPackages().catch(() => new Set<string>())
  const running = new Set(
    // Only programs that keep running; one-off startup tasks (ldconfig and the like) do not count.
    lines((await run(['systemctl', 'list-units', '--type=service', '--state=running', '--no-legend', '--plain', '--no-pager'])).stdout)
      .map((line) => line.split(/\s+/)[0]!),
  )
  for (const [index, upgrade] of upgrades.entries()) {
    const entry = packages[index]!
    const blocked: string[] = []
    const caution: string[] = []
    const base = upgrade.name.split(':')[0]!

    if (held.has(base) || held.has(upgrade.name)) {
      blocked.push('It is held at its current version, so updates leave it alone until the hold is lifted.')
    }
    if (keptBack.includes(base)) {
      const simulated = await run(['apt-get', '-s', '-o', 'Debug::NoLocking=1', 'install', '--only-upgrade', base], { timeout: 60_000, env: backend?.env })
      const removes = lines(simulated.stdout).map((line) => line.match(/^Remv (\S+)/)?.[1]).filter((name): name is string => !!name)
      const adds = lines(simulated.stdout)
        .map((line) => line.match(/^Inst (\S+) \((?!.*\[)/)?.[1])
        .filter((name): name is string => !!name && name !== base)
      if (removes.length) blocked.push(`Installing it would remove ${removes.slice(0, 5).join(', ')}${removes.length > 5 ? ` and ${removes.length - 5} more` : ''}.`)
      else if (adds.length) caution.push(`It needs new packages (${adds.slice(0, 4).join(', ')}), so a normal update leaves it out. Update it on its own.`)
      else caution.push('The package manager holds it back from a normal update. Update it on its own to see what changes.')
    }

    const before = major(upgrade.current)
    const after = major(upgrade.next)
    const jump = before.epoch !== after.epoch || (before.major !== null && after.major !== null && after.major > before.major)
    if (jump && before.major !== null && after.major !== null) {
      if (DATABASE.test(base)) caution.push(`Database version ${before.major} → ${after.major}: stored data may need converting. Read its upgrade notes first.`)
      else caution.push(`Major version ${before.major} → ${after.major}: settings or behaviour may change. Read its release notes first.`)
    }

    // A service the package installs that is running now restarts during the update.
    const files = await packageFiles(base).catch(() => [] as string[])
    const services = [...new Set(files.filter((file) => /\/systemd\/system\/[^/]+\.service$/.test(file)).map((file) => file.split('/').pop()!))]
      .filter((service) => running.has(service))
    if (services.length) caution.push(`Restarts ${services.map((service) => service.replace(/\.service$/, '')).join(', ')} while installing: unavailable for a moment.`)

    if (entry.restart) caution.push('Takes full effect only after the server restarts.')

    entry.risk = blocked.length
      ? { level: 'blocked', reasons: [...blocked, ...caution] }
      : caution.length
        ? { level: 'caution', reasons: caution }
        : { level: 'safe', reasons: [] }
  }
}
