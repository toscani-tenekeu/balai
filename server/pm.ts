// One backend per package manager, behind the same interface, so the rest of
// Balai does not need to know which Linux distribution it runs on.
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import { platform, type PackageManagerId } from './platform.ts'
import { has, lines, readText, run, type RunResult } from './sys.ts'

export interface Upgrade {
  name: string
  current: string
  next: string
  security: boolean
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

/** Sizes of the version an update installs, in bytes; null where the package manager does not say. */
export interface UpgradeSize {
  download: number | null
  installed: number | null
  /** Already downloaded, so nothing is fetched for it. */
  cached: boolean
}

export interface Simulation {
  ok: boolean
  /** Every package the removal would take away, the requested one included. */
  removed: string[]
  message: string
}

export interface Backend {
  id: PackageManagerId
  /** Single updates are not supported everywhere: Arch only supports upgrading everything at once. */
  canUpgradeOne: boolean
  /** Removing a package together with its configuration files. */
  canPurge: boolean
  /** Whether updates are marked as security fixes. */
  tracksSecurity: boolean
  env: Record<string, string>
  upgrades(): Promise<Upgrade[]>
  /** Download and installed sizes of the versions the updates bring. */
  sizes?(upgrades: Upgrade[]): Promise<Map<string, UpgradeSize>>
  /** Updates the manager will not install with a plain upgrade, such as apt's "kept back". */
  keptBack?(): Promise<string[]>
  refresh(): Promise<RunResult>
  indexAge(): Promise<number | null>
  reboot(): Promise<{ required: boolean; packages: string[] }>
  installed(): Promise<InstalledPackage[]>
  simulateRemove(name: string): Promise<Simulation>
  upgradeCommand(name: string | null): string[]
  removeCommand(name: string, purge: boolean): string[]
  /** Downloaded package files: where they are, and the command that clears them (deleted directly when absent). */
  cache: { roots: string[]; match: RegExp; clean?: string[] }
  /** Dependencies nothing needs any more. */
  autoremove: { list(): Promise<string[]>; clean(names: string[]): string[] } | null
  /** Settings files left behind by uninstalled packages. */
  leftovers: { list(): Promise<string[]>; clean(names: string[]): string[] } | null
}

// ---- Shared helpers ----------------------------------------------------------------

const KERNEL = os.release()

/** Packages the panel never removes, on any system: losing them breaks booting, logging in or managing packages. */
const BASE = new Set([
  'bash', 'busybox', 'coreutils', 'glibc', 'musl', 'libc6', 'systemd', 'openrc', 'sudo', 'util-linux', 'filesystem',
  'setup', 'basesystem', 'rpm', 'dnf', 'dnf5', 'yum', 'zypper', 'libzypp', 'pacman', 'apk-tools', 'alpine-base',
  'alpine-baselayout', 'alpine-keys', 'base', 'grub', 'grub2', 'shim', 'linux-firmware',
])
const KERNEL_PACKAGE = /^(kernel(-core|-modules|-default|-uek)?|linux(-lts|-zen|-hardened|-virt|-edge|-rpi)?)$/

function lockedByName(name: string, extra: Set<string>): boolean {
  const base = name.split(':')[0]!
  return BASE.has(base) || extra.has(base) || KERNEL_PACKAGE.test(base) || /^(grub2?|shim)(-|$)/.test(base)
}

/** A newer kernel is installed than the one running, or the running one was replaced. */
function kernelReboot(): boolean {
  for (const dir of ['/usr/lib/modules', '/lib/modules']) {
    let names: string[]
    try {
      names = readdirSync(dir).filter((name) => /^\d/.test(name))
    } catch {
      continue
    }
    if (!names.length) return false
    if (!names.includes(KERNEL)) return true
    const newest = [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
    return newest !== KERNEL
  }
  return false
}

function newestChange(paths: string[]): number | null {
  let newest = 0
  for (const path of paths) {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs)
    } catch {
      // Not on this system.
    }
  }
  return newest ? Math.round((Date.now() - newest) / 1000) : null
}

/** Sizes like "1.5 MiB" (pacman) into bytes. */
function unitSize(text: string): number {
  const match = text.trim().match(/^([\d.,]+)\s*([KMGT]?)i?B$/i)
  if (!match) return 0
  const power = { '': 0, K: 1, M: 2, G: 3, T: 4 }[match[2]!.toUpperCase()] ?? 0
  return Math.round(Number(match[1]!.replace(',', '.')) * 1024 ** power)
}

/** The last meaningful lines of a failed command, for showing why. */
function why(result: RunResult, fallback: string): string {
  const text = lines(result.stderr).concat(lines(result.stdout)).filter((line) => !/^(Last metadata|Updating|Dependencies resolved)/.test(line))
  return text.slice(-2).join(' ') || fallback
}

// ---- rpm (dnf, yum, zypper) -----------------------------------------------------------

async function rpmInstalled(manual: (name: string) => boolean, extra: Set<string>): Promise<InstalledPackage[]> {
  const result = await run(['rpm', '-qa', '--qf', '%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{SIZE}\\t%{SUMMARY}\\n'], { timeout: 60_000 })
  const byName = new Map<string, InstalledPackage>()
  for (const line of result.stdout.split('\n')) {
    const [name, version, size, summary] = line.split('\t')
    if (!name || name === 'gpg-pubkey') continue
    const seen = byName.get(name)
    // Several kernels can be installed under one name: count them together.
    if (seen) {
      seen.size += Number(size) || 0
      seen.version = version! > seen.version ? version! : seen.version
      continue
    }
    byName.set(name, {
      name,
      version: version ?? '',
      size: Number(size) || 0,
      summary: summary ?? '',
      manual: manual(name),
      locked: lockedByName(name, extra),
    })
  }
  return [...byName.values()]
}

const rpmName = (nevra: string) => nevra.replace(/-[^-]+-[^-]+$/, '')

// ---- apt ----------------------------------------------------------------------------------

const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', APT_LISTCHANGES_FRONTEND: 'none', NEEDRESTART_SUSPEND: '1' }
const APT = [
  'apt-get', '-y', '-q',
  '-o', 'DPkg::Lock::Timeout=120',
  // Config files already on the server are kept, and no question is ever asked.
  '-o', 'Dpkg::Options::=--force-confdef',
  '-o', 'Dpkg::Options::=--force-confold',
]

const apt: Backend = {
  id: 'apt',
  canUpgradeOne: true,
  canPurge: true,
  tracksSecurity: true,
  env: APT_ENV,
  async upgrades() {
    const result = await run(['apt', 'list', '--upgradable'], { timeout: 60_000 })
    const list: Upgrade[] = []
    for (const line of lines(result.stdout)) {
      const match = line.match(/^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/)
      if (match) list.push({ name: match[1]!, next: match[3]!, current: match[4]!, security: match[2]!.includes('-security') })
    }
    return list
  },
  async sizes(upgrades) {
    const sizes = new Map<string, UpgradeSize>()
    for (let index = 0; index < upgrades.length; index += 300) {
      const batch = upgrades.slice(index, index + 300)
      const result = await run(['apt-cache', 'show', '--no-all-versions', ...batch.map((item) => `${item.name}=${item.next}`)], { timeout: 60_000 })
      for (const block of result.stdout.split(/\n\s*\n/)) {
        const field = (key: string) => block.match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1]?.trim() ?? ''
        const name = field('Package')
        if (!name || sizes.has(name)) continue
        const file = decodeURIComponent(field('Filename').split('/').pop() ?? '')
        sizes.set(name, {
          download: Number(field('Size')) || null,
          installed: (Number(field('Installed-Size')) || 0) * 1024 || null,
          cached: !!file && existsSync(`/var/cache/apt/archives/${file}`),
        })
      }
    }
    return sizes
  },
  async keptBack() {
    const result = await run(['apt-get', '-s', '-o', 'Debug::NoLocking=1', 'upgrade'], { timeout: 60_000, env: APT_ENV })
    const text = result.stdout.split('\n')
    const start = text.findIndex((line) => /kept back:$/.test(line))
    if (start < 0) return []
    const names: string[] = []
    for (const line of text.slice(start + 1)) {
      if (!line.startsWith(' ')) break
      names.push(...line.trim().split(/\s+/))
    }
    return names
  },
  refresh: () => run(['apt-get', 'update', '-q'], { timeout: 180_000, env: APT_ENV }),
  indexAge: async () => newestChange(['/var/lib/apt/periodic/update-success-stamp', '/var/cache/apt/pkgcache.bin']),
  async reboot() {
    return { required: existsSync('/var/run/reboot-required'), packages: lines(readText('/var/run/reboot-required.pkgs')) }
  },
  async installed() {
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
      const base = name.split(':')[0]!
      list.push({
        name,
        version: version ?? '',
        size: (Number(size) || 0) * 1024,
        summary: summary ?? '',
        manual: chosen.has(name) || chosen.has(base),
        locked:
          essential === 'yes' || ['required', 'important'].includes(priority ?? '') || base.includes(KERNEL) ||
          /^(grub|shim|linux-image-(generic|virtual|amd64|arm64|cloud)$)/.test(base),
      })
    }
    return list
  },
  async simulateRemove(name) {
    const result = await run(['apt-get', '-s', 'remove', name], { timeout: 60_000, env: APT_ENV })
    if (!result.ok) return { ok: false, removed: [], message: why(result, 'apt could not work out the removal.') }
    const removed = lines(result.stdout).map((line) => line.match(/^Remv (\S+)/)?.[1]).filter((item): item is string => !!item)
    return { ok: true, removed, message: '' }
  },
  upgradeCommand: (name) => (name === null ? [...APT, 'upgrade'] : [...APT, 'install', '--only-upgrade', name]),
  removeCommand: (name, purge) => [...APT, purge ? 'purge' : 'remove', name],
  cache: { roots: ['/var/cache/apt/archives'], match: /\.deb$/, clean: ['apt-get', 'clean'] },
  autoremove: {
    async list() {
      const result = await run(['apt-get', '-s', 'autoremove'], { timeout: 60_000, env: APT_ENV })
      return lines(result.stdout).map((line) => line.match(/^Remv (\S+)/)?.[1]).filter((item): item is string => !!item)
    },
    clean: () => [...APT, 'autoremove', '--purge'],
  },
  leftovers: {
    async list() {
      const result = await run(['dpkg-query', '-W', '-f=${db:Status-Abbrev}\\t${binary:Package}\\n'], { timeout: 30_000 })
      return result.stdout.split('\n').filter((line) => line.startsWith('rc')).map((line) => line.split('\t')[1]!).filter(Boolean)
    },
    clean: (names) => ['dpkg', '--purge', ...names],
  },
}

// ---- dnf and yum (Fedora, RHEL, Rocky, AlmaLinux, CentOS Stream, Oracle Linux, Amazon Linux) -----

const isDnf5 = () => has('dnf5') || /dnf5/.test(readText('/usr/bin/dnf'))

/** Package names in dnf's "Removing:" tables (the tables of `remove` and `autoremove` with --assumeno). */
function dnfRemoved(output: string): string[] {
  const names: string[] = []
  let inside = false
  for (const line of output.split('\n')) {
    if (/^Removing/i.test(line.trim()) && line.trim().endsWith(':')) {
      inside = true
      continue
    }
    if (/^(Transaction Summary|Installing|Upgrading|Downgrading|Reinstalling)/i.test(line.trim())) inside = false
    if (!inside) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 3 && /^(x86_64|aarch64|noarch|i686|ppc64le|s390x)$/.test(parts[1]!)) names.push(parts[0]!)
  }
  return names
}

function dnfLike(id: 'dnf' | 'yum'): Backend {
  const env = { LC_ALL: 'C' }
  const protectedNames = () => {
    const names = new Set<string>()
    for (const dir of ['/etc/dnf/protected.d', '/etc/yum/protected.d']) {
      try {
        for (const file of readdirSync(dir)) for (const name of lines(readText(`${dir}/${file}`))) if (!name.startsWith('#')) names.add(name)
      } catch {
        // No protected list on this system.
      }
    }
    return names
  }
  return {
    id,
    canUpgradeOne: true,
    canPurge: false,
    tracksSecurity: true,
    env,
    async upgrades() {
      const [check, advisories] = await Promise.all([
        run([id, '-q', 'check-update'], { timeout: 180_000 }),
        run(isDnf5() ? ['dnf', '-q', 'advisory', 'list', '--security'] : [id, '-q', 'updateinfo', 'list', '--security'], { timeout: 180_000 }),
      ])
      // check-update exits with 100 when there are updates.
      const found: { name: string; arch: string; next: string }[] = []
      for (const line of check.stdout.split('\n')) {
        if (/^(Obsoleting|Security:)/.test(line)) break
        const match = line.match(/^(\S+)\.(x86_64|aarch64|noarch|i686|ppc64le|s390x)\s+(\S+)\s+\S+/)
        // The epoch ("1:") is left out, as in the installed version shown next to it.
        if (match) found.push({ name: match[1]!, arch: match[2]!, next: match[3]!.replace(/^\d+:/, '') })
      }
      const security = new Set(
        lines(advisories.stdout)
          .map((line) => line.split(/\s+/).at(-1) ?? '')
          .map((nevra) => rpmName(nevra.replace(/\.(x86_64|aarch64|noarch|i686|ppc64le|s390x)$/, ''))),
      )
      const current = new Map<string, string>()
      if (found.length) {
        const query = await run(['rpm', '-q', '--qf', '%{NAME}\\t%{VERSION}-%{RELEASE}\\n', ...new Set(found.map((item) => item.name))], { timeout: 60_000 })
        for (const line of lines(query.stdout)) {
          const [name, version] = line.split('\t')
          if (name && version) current.set(name, version)
        }
      }
      return found.map((item) => ({ name: item.name, next: item.next, current: current.get(item.name) ?? '', security: security.has(item.name) }))
    },
    async sizes(upgrades) {
      const sizes = new Map<string, UpgradeSize>()
      if (!upgrades.length || !has('dnf')) return sizes
      // dnf5 needs the line end written out and does not read \\t, so the fields are split by spaces.
      const format = `%{name} %{downloadsize} %{installsize}${isDnf5() ? '\\n' : ''}`
      const result = await run(['dnf', '-q', 'repoquery', '--upgrades', '--latest-limit', '1', '--queryformat', format], { timeout: 180_000 })
      for (const line of lines(result.stdout)) {
        const [name, download, installed] = line.split(/\s+/)
        if (name && !sizes.has(name)) sizes.set(name, { download: Number(download) || null, installed: Number(installed) || null, cached: false })
      }
      return sizes
    },
    refresh: () => run([id, '-q', 'makecache', '--refresh'], { timeout: 300_000 }),
    indexAge: async () => newestChange(['/var/cache/dnf', '/var/cache/libdnf5', '/var/cache/yum']),
    async reboot() {
      const command = has('needs-restarting') ? ['needs-restarting', '-r'] : isDnf5() ? ['dnf', 'needs-restarting', '-r'] : null
      if (command) {
        const result = await run(command, { timeout: 60_000 })
        // Exit 1 means a restart is needed, 0 that it is not; anything else means the check is unavailable.
        if (result.code === 0 || result.code === 1) return { required: result.code === 1, packages: [] }
      }
      return { required: kernelReboot(), packages: [] }
    },
    async installed() {
      const userInstalled = await run(
        isDnf5() ? ['dnf', '-q', 'repoquery', '--userinstalled', '--queryformat', '%{name}\\n'] : [id, '-q', 'repoquery', '--userinstalled', '--qf', '%{name}'],
        { timeout: 120_000 },
      )
      const chosen = new Set(lines(userInstalled.stdout))
      return rpmInstalled((name) => (userInstalled.ok && chosen.size ? chosen.has(name) : true), protectedNames())
    },
    async simulateRemove(name) {
      const result = await run([id, 'remove', '--assumeno', name], { timeout: 120_000 })
      const removed = dnfRemoved(result.stdout)
      if (removed.length) return { ok: true, removed, message: '' }
      const text = result.stdout + result.stderr
      if (/protected/i.test(text)) return { ok: true, removed: [name], message: '' }
      return { ok: false, removed: [], message: why(result, `${id} could not work out the removal.`) }
    },
    upgradeCommand: (name) => (name === null ? [id, '-y', 'upgrade'] : [id, '-y', 'upgrade', name]),
    removeCommand: (name) => [id, '-y', 'remove', name],
    cache: { roots: ['/var/cache/dnf', '/var/cache/libdnf5', '/var/cache/yum'], match: /\.rpm$/, clean: [id, 'clean', 'packages'] },
    autoremove: {
      async list() {
        const result = await run([id, 'autoremove', '--assumeno'], { timeout: 120_000 })
        return dnfRemoved(result.stdout)
      },
      clean: () => [id, '-y', 'autoremove'],
    },
    leftovers: null,
  }
}

// ---- zypper (openSUSE, SUSE) --------------------------------------------------------------

/** Rows of zypper's "a | b | c" tables. */
const zypperRows = (output: string) =>
  output.split('\n').filter((line) => line.includes('|') && !/^[-+|]+$/.test(line.trim())).map((line) => line.split('|').map((cell) => cell.trim()))

const zypper: Backend = {
  id: 'zypper',
  canUpgradeOne: true,
  canPurge: false,
  tracksSecurity: false,
  env: {},
  async upgrades() {
    const result = await run(['zypper', '-n', '-q', 'list-updates'], { timeout: 180_000 })
    return zypperRows(result.stdout)
      .filter((row) => row[0] === 'v' && row.length >= 6)
      .map((row) => ({ name: row[2]!, current: row[3]!, next: row[4]!, security: false }))
  },
  refresh: () => run(['zypper', '-n', 'refresh'], { timeout: 300_000 }),
  indexAge: async () => newestChange(['/var/cache/zypp/raw', '/var/cache/zypp/solv']),
  async reboot() {
    if (has('zypper')) {
      const result = await run(['zypper', 'needs-rebooting'], { timeout: 60_000 })
      // 102: a restart is needed; 0: it is not.
      if (result.code === 102 || result.code === 0) return { required: result.code === 102, packages: [] }
    }
    return { required: kernelReboot(), packages: [] }
  },
  async installed() {
    const auto = new Set(lines(readText('/var/lib/zypp/AutoInstalled')))
    return rpmInstalled((name) => !auto.has(name), new Set())
  },
  async simulateRemove(name) {
    const result = await run(['zypper', '-n', 'remove', '--dry-run', '--clean-deps', name], { timeout: 120_000 })
    const text = result.stdout.split('\n')
    const start = text.findIndex((line) => /going to be REMOVED:/.test(line))
    if (start < 0) return { ok: false, removed: [], message: why(result, 'zypper could not work out the removal.') }
    const removed: string[] = []
    for (const line of text.slice(start + 1)) {
      if (!line.trim()) break
      removed.push(...line.trim().split(/\s+/))
    }
    return { ok: true, removed, message: '' }
  },
  upgradeCommand: (name) => (name === null ? ['zypper', '-n', 'update'] : ['zypper', '-n', 'update', name]),
  removeCommand: (name) => ['zypper', '-n', 'remove', '--clean-deps', name],
  cache: { roots: ['/var/cache/zypp/packages'], match: /\.rpm$/, clean: ['zypper', '-n', 'clean'] },
  autoremove: {
    async list() {
      const result = await run(['zypper', '-n', '-q', 'packages', '--unneeded'], { timeout: 120_000 })
      return [...new Set(zypperRows(result.stdout).filter((row) => row[0]?.startsWith('i')).map((row) => row[2]!).filter(Boolean))]
    },
    clean: (names) => ['zypper', '-n', 'remove', '--clean-deps', ...names],
  },
  leftovers: null,
}

// ---- pacman (Arch, Manjaro) ----------------------------------------------------------------

const holdPackages = () => {
  const line = readText('/etc/pacman.conf').match(/^\s*HoldPkg\s*=\s*(.+)$/m)
  return new Set(line ? line[1]!.trim().split(/\s+/) : [])
}

const pacman: Backend = {
  id: 'pacman',
  // Arch supports upgrading everything at once only; single upgrades leave the system half-updated.
  canUpgradeOne: false,
  canPurge: true,
  tracksSecurity: false,
  env: {},
  async upgrades() {
    // checkupdates (pacman-contrib) uses its own copy of the package database, so nothing is half-synced.
    let result = has('checkupdates') ? await run(['checkupdates'], { timeout: 180_000 }) : null
    // checkupdates exits with 2 when there is nothing to update and 1 when it cannot run.
    if (!result || result.code === 1) result = await run(['pacman', '-Qu'], { timeout: 60_000 })
    return lines(result.stdout)
      .map((line) => line.match(/^(\S+)\s+(\S+)\s+->\s+(\S+)/))
      .filter((match): match is RegExpMatchArray => !!match)
      .map((match) => ({ name: match[1]!, current: match[2]!, next: match[3]!, security: false }))
  },
  async refresh() {
    if (has('checkupdates')) {
      const result = await run(['checkupdates'], { timeout: 180_000 })
      if (result.code !== 1) return { ...result, ok: true }
    }
    // Only full upgrades are offered on Arch, so syncing the database cannot leave a partial upgrade behind.
    return run(['pacman', '-Sy', '--noconfirm'], { timeout: 300_000 })
  },
  async sizes(upgrades) {
    const sizes = new Map<string, UpgradeSize>()
    if (!upgrades.length) return sizes
    const result = await run(['pacman', '-Si', ...upgrades.map((item) => item.name)], { timeout: 60_000 })
    for (const block of result.stdout.split(/\n\s*\n/)) {
      const field = (key: string) => block.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? ''
      const name = field('Name')
      if (!name || sizes.has(name)) continue
      const version = field('Version')
      let cached = false
      try {
        cached = readdirSync('/var/cache/pacman/pkg').some((file) => file.startsWith(`${name}-${version}-`) && !file.endsWith('.sig'))
      } catch {
        // No package cache.
      }
      sizes.set(name, { download: unitSize(field('Download Size')) || null, installed: unitSize(field('Installed Size')) || null, cached })
    }
    return sizes
  },
  indexAge: async () => newestChange(['/var/lib/pacman/sync']),
  reboot: async () => ({ required: kernelReboot(), packages: [] }),
  async installed() {
    const result = await run(['pacman', '-Qi'], { timeout: 60_000 })
    const hold = holdPackages()
    const list: InstalledPackage[] = []
    for (const block of result.stdout.split(/\n\s*\n/)) {
      const field = (key: string) => block.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? ''
      const name = field('Name')
      if (!name) continue
      list.push({
        name,
        version: field('Version'),
        size: unitSize(field('Installed Size')),
        summary: field('Description'),
        manual: field('Install Reason').startsWith('Explicitly'),
        locked: lockedByName(name, hold),
      })
    }
    return list
  },
  async simulateRemove(name) {
    const result = await run(['pacman', '-Rs', '--print', '--print-format', '%n', name], { timeout: 60_000 })
    if (!result.ok) return { ok: false, removed: [], message: why(result, 'pacman could not work out the removal.') }
    return { ok: true, removed: lines(result.stdout), message: '' }
  },
  upgradeCommand: () => ['pacman', '-Syu', '--noconfirm'],
  removeCommand: (name, purge) => ['pacman', purge ? '-Rns' : '-Rs', '--noconfirm', name],
  cache: {
    roots: ['/var/cache/pacman/pkg'],
    match: /\.pkg\.tar(\.\w+)?$/,
    // paccache keeps the newest copy of each package, so a broken update can still be rolled back.
    clean: has('paccache') ? ['paccache', '-rk1'] : ['pacman', '-Sc', '--noconfirm'],
  },
  autoremove: {
    async list() {
      const result = await run(['pacman', '-Qdtq'], { timeout: 60_000 })
      return lines(result.stdout)
    },
    clean: (names) => ['pacman', '-Rns', '--noconfirm', ...names],
  },
  leftovers: null,
}

// ---- apk (Alpine) ------------------------------------------------------------------------------

/** "busybox-1.36.1-r29" into its name. */
const apkName = (full: string) => full.replace(/-\d[^-]*-r\d+$/, '')

const apk: Backend = {
  id: 'apk',
  canUpgradeOne: true,
  canPurge: true,
  tracksSecurity: false,
  env: {},
  async upgrades() {
    const result = await run(['apk', 'version', '-l', '<'], { timeout: 60_000 })
    return lines(result.stdout)
      .map((line) => line.match(/^(\S+)\s+<\s+(\S+)/))
      .filter((match): match is RegExpMatchArray => !!match)
      .map((match) => {
        const name = apkName(match[1]!)
        return { name, current: match[1]!.slice(name.length + 1), next: match[2]!, security: false }
      })
  },
  refresh: () => run(['apk', 'update'], { timeout: 300_000 }),
  indexAge: async () => newestChange(['/var/cache/apk', '/lib/apk/db/installed']),
  reboot: async () => ({ required: kernelReboot(), packages: [] }),
  async installed() {
    const listed = await run(['apk', 'info', '-v'], { timeout: 60_000 })
    const names = lines(listed.stdout).filter((line) => !line.startsWith('WARNING')).map(apkName)
    // Named explicitly, apk prints "<name>-<version> installed size:" with the value on the next line.
    const [sizes, descriptions] = await Promise.all([
      run(['apk', 'info', '-s', ...names], { timeout: 60_000 }),
      run(['apk', 'info', '-d', ...names], { timeout: 60_000 }),
    ])
    // `apk info -s/-d` print "<pkg> installed size:" / "<pkg> description:" followed by the value on the next line.
    const paired = (text: string) => {
      const map = new Map<string, string>()
      const all = text.split('\n')
      for (let index = 0; index < all.length; index++) {
        const match = all[index]!.match(/^(\S+) (installed size|description):$/)
        if (match) map.set(match[1]!, (all[index + 1] ?? '').trim())
      }
      return map
    }
    const size = paired(sizes.stdout)
    const description = paired(descriptions.stdout)
    const world = new Set(lines(readText('/etc/apk/world')).map((entry) => entry.split(/[<>=~]/)[0]!))
    const extra = new Set(['openrc', 'alpine-conf', 'libc-utils'])
    return lines(listed.stdout).filter((line) => !line.startsWith('WARNING')).map((full) => {
      const name = apkName(full)
      return {
        name,
        version: full.slice(name.length + 1),
        size: unitSize(size.get(full) ?? ''),
        summary: description.get(full) ?? '',
        manual: world.has(name),
        locked: lockedByName(name, extra),
      }
    })
  },
  async simulateRemove(name) {
    const result = await run(['apk', 'del', '--simulate', name], { timeout: 60_000 })
    const removed = lines(result.stdout).map((line) => line.match(/^\(\d+\/\d+\) Purging (\S+)/)?.[1]).filter((item): item is string => !!item)
    if (removed.length) return { ok: true, removed, message: '' }
    const text = result.stdout + result.stderr
    if (/required by/i.test(text)) return { ok: false, removed: [], message: `Other installed packages need ${name}, so apk keeps it.` }
    return { ok: false, removed: [], message: why(result, 'apk could not work out the removal.') }
  },
  upgradeCommand: (name) => (name === null ? ['apk', 'upgrade'] : ['apk', 'upgrade', name]),
  removeCommand: (name, purge) => ['apk', 'del', ...(purge ? ['--purge'] : []), name],
  cache: { roots: ['/var/cache/apk'], match: /\.apk$/ },
  autoremove: null,
  leftovers: null,
}

const BACKENDS: Record<PackageManagerId, Backend> = { apt, dnf: dnfLike('dnf'), yum: dnfLike('yum'), zypper, pacman, apk }

/** The package manager of this system, or null when Balai does not know it. */
export const backend: Backend | null = platform.manager ? BACKENDS[platform.manager] : null
