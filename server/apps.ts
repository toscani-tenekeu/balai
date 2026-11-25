import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { logActivity } from './db.ts'
import { listListeners, type Listener } from './ports.ts'
import { installedPackages, packageState, removalPlan } from './packages.ts'
import { heldPackages, ownersOf, packageFiles, requiredBy, shippedWithSystem, sourcesOf } from './pkginfo.ts'
import { platform } from './platform.ts'
import type { InstalledPackage } from './pm.ts'
import { webProxies, webRoots } from './sites.ts'
import { formatBytes, has, lines, reason, run } from './sys.ts'

/**
 * Apps: what is installed on the server, grouped the way a person thinks of it rather than package
 * by package. An app is a set of packages built from one source (all of Docker, all of PHP), a service
 * of your own (a site running from /opt), a snap, or a Docker container.
 */

export type Group = 'user' | 'default' | 'system'
export type Kind = 'package' | 'service' | 'container' | 'snap'

export interface AppSummary {
  id: string
  name: string
  kind: Kind
  group: Group
  summary: string
  size: number | null
  running: boolean | null
  packages: string[]
  units: string[]
  ports: number[]
  sites: string[]
  updates: number
  /** Libraries, fonts and build headers: installed for other programs rather than used directly. */
  library: boolean
}

export interface Verdict {
  level: 'needed' | 'blocked' | 'caution' | 'safe'
  title: string
  reasons: string[]
  steps: string[]
}

export interface Folder {
  path: string
  role: 'program' | 'settings' | 'data' | 'logs' | 'cache'
  size: number | null
}

export interface UnitInfo {
  name: string
  description: string
  active: string
  enabled: string
  memory: number | null
  since: number | null
  user: string
  command: string
  directory: string
}

export interface AppDetail extends AppSummary {
  verdict: Verdict
  packageList: { name: string; version: string; size: number; summary: string; manual: boolean; system: boolean }[]
  removes: string[]
  freed: number | null
  neededBy: { name: string; app: string | null }[]
  unitList: UnitInfo[]
  listeners: Listener[]
  siteList: { name: string; url: string; how: string }[]
  folders: Folder[]
  upgrades: { name: string; current: string; next: string; security: boolean }[]
  held: string[]
  git: { remote: string; branch: string; commit: string; date: number | null } | null
  timers: { name: string; next: number | null; last: number | null; result: string }[]
  container: { image: string; state: string; created: number | null; restart: string; mounts: string[]; project: string | null } | null
}

// ---- Gathering ---------------------------------------------------------------------------------

interface UnitRecord {
  name: string
  path: string
  description: string
  active: string
  enabled: string
  memory: number | null
  since: number | null
  user: string
  command: string
  directory: string
  pid: number
}

const systemd = platform.init === 'systemd' && has('systemctl')

/** Units that belong to the machine itself rather than to an app. */
const PLUMBING = /^(getty@|serial-getty@|user@|user-runtime-dir@|systemd-|dbus|polkit|accounts-daemon|rtkit|ModemManager|NetworkManager|wpa_supplicant|udisks2|multipathd|snap\.|session-|init\.scope)/

async function units(): Promise<UnitRecord[]> {
  if (!systemd) return []
  const listed = await run(['systemctl', 'list-units', '--type=service', '--all', '--no-legend', '--plain', '--no-pager'])
  const files = await run(['systemctl', 'list-unit-files', '--type=service', '--state=enabled', '--no-legend', '--plain', '--no-pager'])
  const names = new Set<string>()
  for (const line of lines(listed.stdout)) {
    const [name, load, active] = line.split(/\s+/)
    if (name?.endsWith('.service') && load === 'loaded' && (active === 'active' || active === 'failed' || active === 'activating')) names.add(name)
  }
  for (const line of lines(files.stdout)) {
    const [name] = line.split(/\s+/)
    if (name?.endsWith('.service') && !name.includes('@.')) names.add(name)
  }
  const wanted = [...names].filter((name) => !PLUMBING.test(name))
  const records: UnitRecord[] = []
  for (let index = 0; index < wanted.length; index += 60) {
    const batch = wanted.slice(index, index + 60)
    const shown = await run([
      'systemctl', 'show', '--no-pager',
      '-p', 'Id,FragmentPath,Description,ActiveState,UnitFileState,MemoryCurrent,ActiveEnterTimestamp,User,ExecStart,WorkingDirectory,MainPID',
      ...batch,
    ], { timeout: 30_000 })
    for (const block of shown.stdout.split(/\n\s*\n/)) {
      const field = (key: string) => block.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? ''
      const name = field('Id')
      if (!name) continue
      const memory = Number(field('MemoryCurrent'))
      const since = Date.parse(field('ActiveEnterTimestamp'))
      records.push({
        name,
        path: field('FragmentPath'),
        description: field('Description'),
        active: field('ActiveState'),
        enabled: field('UnitFileState'),
        memory: Number.isFinite(memory) && memory < 2 ** 60 ? memory : null,
        since: Number.isFinite(since) ? since : null,
        user: field('User') || 'root',
        command: field('ExecStart').match(/argv\[\]=([^;]*)/)?.[1]?.trim() ?? '',
        directory: field('WorkingDirectory').replace(/^!/, ''),
        pid: Number(field('MainPID')) || 0,
      })
    }
  }
  return records
}

interface Container {
  name: string
  image: string
  state: string
  ports: number[]
  size: number | null
}

async function containers(): Promise<Container[]> {
  if (!has('docker')) return []
  const out = await run(['docker', 'ps', '-a', '--size', '--format', '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Ports}}\t{{.Size}}'], { timeout: 30_000 })
  return lines(out.stdout).map((line) => {
    const [name, image, state, ports, size] = line.split('\t')
    const published = [...(ports ?? '').matchAll(/:(\d+)->/g)].map((match) => Number(match[1]))
    const virtual = (size ?? '').match(/virtual ([\d.]+)\s*([kKMGT]?B)/)
    return { name: name!, image: image ?? '', state: state ?? '', ports: [...new Set(published)], size: virtual ? sizeOf(virtual[1]!, virtual[2]!) : null }
  })
}

function sizeOf(value: string, unit: string): number {
  const power = { B: 0, KB: 1, kB: 1, MB: 2, GB: 3, TB: 4 }[unit] ?? 0
  return Math.round(Number(value) * 1000 ** power)
}

interface Snap {
  name: string
  version: string
  size: number
  notes: string
}

async function snaps(): Promise<Snap[]> {
  if (!has('snap')) return []
  const out = await run(['snap', 'list'], { timeout: 30_000 })
  return lines(out.stdout).slice(1).map((line) => {
    const [name, version, revision, , , notes] = line.split(/\s+/)
    let size = 0
    try {
      size = statSync(`/var/lib/snapd/snaps/${name}_${revision}.snap`).size
    } catch {
      // Size unknown.
    }
    return { name: name!, version: version ?? '', size, notes: notes ?? '' }
  })
}

interface World {
  installed: InstalledPackage[]
  byName: Map<string, InstalledPackage>
  sources: Map<string, string>
  shipped: Set<string>
  units: UnitRecord[]
  unitOwner: Map<string, string>
  listeners: Listener[]
  proxies: Awaited<ReturnType<typeof webProxies>>
  containers: Container[]
  snaps: Snap[]
  upgrades: Awaited<ReturnType<typeof packageState>>['upgrades']
}

let worldCache: { at: number; world: World } | null = null

async function world(): Promise<World> {
  if (worldCache && Date.now() - worldCache.at < 60_000) return worldCache.world
  const [installed, sources, unitList, listeners, proxies, containerList, snapList, state] = await Promise.all([
    installedPackages(),
    sourcesOf(),
    units(),
    listListeners(),
    webProxies(),
    containers(),
    snaps(),
    packageState(),
  ])
  const shipped = await shippedWithSystem(installed)
  const owners = await ownersOf(unitList.map((unit) => unit.path).filter(Boolean))
  const unitOwner = new Map<string, string>()
  for (const unit of unitList) {
    const owner = owners.get(unit.path)
    if (owner) unitOwner.set(unit.name, owner)
  }
  const byName = new Map(installed.flatMap((item) => [[item.name, item], [item.name.split(':')[0]!, item]] as const))
  const value: World = {
    installed, byName, sources, shipped, units: unitList, unitOwner, listeners, proxies,
    containers: containerList, snaps: snapList, upgrades: state.upgrades,
  }
  worldCache = { at: Date.now(), world: value }
  return value
}

/** Folders of your own apps; system folders are never offered as an app's own. */
const OWN_ROOTS = /^\/(opt|srv|home|root|var\/www)\//

function appFolder(unit: UnitRecord): string | null {
  if (unit.directory && OWN_ROOTS.test(`${unit.directory}/`) && existsSync(unit.directory)) return unit.directory
  const program = unit.command.split(/\s+/).find((part) => OWN_ROOTS.test(part))
  if (!program) return null
  let dir = dirname(program)
  // Climb to the folder that holds the project (the one with a package.json, .git…).
  for (let current = dir; OWN_ROOTS.test(`${current}/`) && current.split('/').length > 2; current = dirname(current)) {
    if (['.git', 'package.json', 'composer.json', 'pyproject.toml', 'go.mod'].some((marker) => existsSync(`${current}/${marker}`))) {
      dir = current
      break
    }
  }
  return existsSync(dir) ? dir : null
}

const pretty = (name: string) => name.replace(/\.service$/, '')

function sitesFor(ports: number[], w: World): string[] {
  return [...new Set(w.proxies.filter((proxy) => ports.includes(proxy.port)).map((proxy) => proxy.site))]
}

/** Every app on the server, in the three groups. */
export async function listApps(): Promise<AppSummary[]> {
  const w = await world()
  const apps: AppSummary[] = []
  const unitsByOwner = new Map<string, UnitRecord[]>()
  for (const unit of w.units) {
    const owner = w.unitOwner.get(unit.name)
    if (!owner) continue
    if (!unitsByOwner.has(owner)) unitsByOwner.set(owner, [])
    unitsByOwner.get(owner)!.push(unit)
  }
  const portsOf = (unitNames: string[]) =>
    [...new Set(w.listeners.filter((item) => item.unit && unitNames.includes(item.unit)).map((item) => item.port))].sort((a, b) => a - b)

  // Packages someone chose to install, gathered by the source they come from.
  const groups = new Map<string, InstalledPackage[]>()
  for (const item of w.installed) {
    const base = item.name.split(':')[0]!
    if (!item.manual && !unitsByOwner.has(base)) continue
    const source = w.sources.get(item.name) ?? w.sources.get(base) ?? base
    if (!groups.has(source)) groups.set(source, [])
    groups.get(source)!.push(item)
  }
  for (const [source, items] of groups) {
    const names = items.map((item) => item.name.split(':')[0]!)
    const main = items.find((item) => item.name.split(':')[0] === source) ?? items[0]!
    const unitList = names.flatMap((name) => unitsByOwner.get(name) ?? [])
    const unitNames = unitList.map((unit) => unit.name)
    const ports = portsOf(unitNames)
    const group: Group = items.some((item) => item.locked)
      ? 'system'
      : names.every((name) => w.shipped.has(name))
        ? 'default'
        : 'user'
    apps.push({
      id: `pkg:${source}`,
      name: items.length === 1 ? names[0]! : source,
      kind: 'package',
      group,
      summary: main.summary,
      size: items.reduce((total, item) => total + item.size, 0),
      running: unitList.length ? unitList.some((unit) => unit.active === 'active') : null,
      packages: names,
      units: unitNames,
      ports,
      sites: sitesFor(ports, w),
      updates: w.upgrades.filter((upgrade) => names.includes(upgrade.name.split(':')[0]!)).length,
      library: !unitList.length && names.every((name) => LIBRARY.test(name)),
    })
  }

  // Services of your own: a unit no package installed.
  for (const unit of w.units) {
    if (w.unitOwner.has(unit.name) || !unit.path) continue
    const ports = portsOf([unit.name])
    apps.push({
      id: `svc:${unit.name}`,
      name: pretty(unit.name),
      kind: 'service',
      group: 'user',
      summary: unit.description,
      size: null,
      running: unit.active === 'active',
      packages: [],
      units: [unit.name],
      ports,
      sites: sitesFor(ports, w),
      updates: 0,
      library: false,
    })
  }

  for (const container of w.containers) {
    apps.push({
      id: `ctr:${container.name}`,
      name: container.name,
      kind: 'container',
      group: 'user',
      summary: `Docker container from ${container.image}`,
      size: container.size,
      running: container.state === 'running',
      packages: [],
      units: [],
      ports: container.ports,
      sites: sitesFor(container.ports, w),
      updates: 0,
      library: false,
    })
  }

  for (const snap of w.snaps) {
    // Bases and the runtime snaps other snaps are built on.
    const base = /^(core\d*|snapd|bare|gnome-[\d-]+|gtk-common-themes|mesa-[\d-]+|kde-[\w-]+|gtk2-common-themes)$/.test(snap.name) || snap.notes.includes('base')
    apps.push({
      id: `snap:${snap.name}`,
      name: snap.name,
      kind: 'snap',
      group: base ? 'system' : snap.name === 'lxd' || snap.name === 'amazon-ssm-agent' ? 'default' : 'user',
      summary: `Snap package, version ${snap.version}`,
      size: snap.size,
      running: null,
      packages: [],
      units: [],
      ports: [],
      sites: [],
      updates: 0,
      library: false,
    })
  }

  // The web server itself runs every site.
  const allSites = [...new Set([...(await webRoots()).map((root) => root.site), ...w.proxies.map((proxy) => proxy.site)])].sort()
  for (const app of apps) if (app.packages.some((name) => /^(nginx|apache2|httpd|caddy)$/.test(name))) app.sites = allSites

  return apps.sort((a, b) => a.name.localeCompare(b.name))
}

// ---- One app in detail --------------------------------------------------------------------------

const LIBRARY = /^(lib|fonts-|xfonts-|python3-|perl-|ruby-|node-|php-[a-z]+$|.*-dev$|.*-doc$|.*-common$|.*-data$)/

/** Folders a package keeps its own things in, read from the files it installed. */
const PACKAGE_FOLDER = /^\/(etc|var\/lib|var\/log|var\/cache|usr\/share|usr\/lib|opt|srv)\/[^/]+$/
const SHARED = new Set([
  '/etc/systemd', '/etc/default', '/etc/init.d', '/etc/logrotate.d', '/etc/cron.d', '/etc/cron.daily', '/etc/cron.weekly',
  '/etc/cron.hourly', '/etc/cron.monthly', '/etc/apparmor.d', '/etc/profile.d', '/etc/sudoers.d', '/etc/security', '/etc/pam.d',
  '/etc/sysctl.d', '/etc/modprobe.d', '/etc/udev', '/etc/ufw', '/etc/bash_completion.d', '/etc/X11', '/etc/ssl', '/etc/alternatives',
  '/etc/ld.so.conf.d', '/etc/update-motd.d', '/etc/dbus-1', '/etc/polkit-1', '/etc/network', '/etc/init',
  '/var/lib/dpkg', '/var/lib/systemd', '/var/lib/ucf', '/var/lib/polkit-1', '/var/lib/apt', '/var/lib/pam', '/var/log/journal',
  '/usr/share/doc', '/usr/share/man', '/usr/share/locale', '/usr/share/lintian', '/usr/share/bash-completion', '/usr/share/zsh',
  '/usr/share/fish', '/usr/share/icons', '/usr/share/applications', '/usr/share/pixmaps', '/usr/share/info', '/usr/share/menu',
  '/usr/share/mime', '/usr/share/perl5', '/usr/share/fonts', '/usr/share/polkit-1', '/usr/share/dbus-1', '/usr/share/metainfo',
  '/usr/share/apport', '/usr/share/glib-2.0', '/usr/share/gir-1.0', '/usr/share/python3', '/usr/lib/systemd', '/usr/lib/python3',
  '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib/tmpfiles.d', '/usr/lib/sysusers.d', '/usr/lib/udev',
  '/usr/lib/sysctl.d', '/usr/lib/modules', '/usr/lib/firmware', '/usr/lib/locale', '/usr/lib/debug', '/usr/lib/python3.12',
  '/usr/lib/jvm', '/usr/lib/node_modules', '/usr/lib/girepository-1.0', '/usr/lib/kernel', '/usr/lib/apparmor', '/usr/lib/os-release',
])

const ROLE: [RegExp, Folder['role']][] = [
  [/^\/etc\//, 'settings'],
  [/^\/var\/lib\//, 'data'],
  [/^\/var\/log\//, 'logs'],
  [/^\/var\/cache\//, 'cache'],
]
const roleOf = (path: string): Folder['role'] => ROLE.find(([pattern]) => pattern.test(path))?.[1] ?? 'program'

async function folderSizes(paths: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  const present = paths.filter((path) => existsSync(path))
  if (!present.length) return sizes
  const out = await run(['du', '-sxB1', '--', ...present], { timeout: 120_000 })
  for (const line of lines(out.stdout)) {
    const [size, path] = line.split('\t')
    if (path) sizes.set(path, Number(size) || 0)
  }
  return sizes
}

async function gitInfo(dir: string): Promise<AppDetail['git']> {
  if (!existsSync(`${dir}/.git`)) return null
  const git = ['git', '-c', 'safe.directory=*', '-C', dir]
  const [remote, branch, commit] = await Promise.all([
    run([...git, 'remote', 'get-url', 'origin']),
    run([...git, 'rev-parse', '--abbrev-ref', 'HEAD']),
    run([...git, 'log', '-1', '--format=%h %ct %s']),
  ])
  const [hash, time, ...subject] = commit.stdout.trim().split(' ')
  return {
    // Tokens sometimes sit in remote addresses; they are never shown.
    remote: remote.stdout.trim().replace(/\/\/[^@/]+@/, '//'),
    branch: branch.stdout.trim(),
    commit: hash ? `${hash} ${subject.join(' ')}` : '',
    date: time ? Number(time) * 1000 : null,
  }
}

async function timersFor(names: string[]): Promise<AppDetail['timers']> {
  if (!systemd || !names.length) return []
  const out = await run(['systemctl', 'list-timers', '--all', '--no-legend', '--output=json'], { timeout: 30_000 })
  let parsed: { unit?: string; activates?: string; next?: number; last?: number }[] = []
  try {
    parsed = JSON.parse(out.stdout || '[]')
  } catch {
    return []
  }
  const bases = names.map((name) => pretty(name))
  const found = parsed.filter((timer) =>
    bases.some((base) => timer.unit?.startsWith(base) || timer.activates === `${base}.service` || timer.activates?.startsWith(`${base}-`)),
  )
  const results = await Promise.all(
    found.map(async (timer) => {
      const shown = await run(['systemctl', 'show', '-p', 'Result', '--value', timer.activates ?? ''])
      return {
        name: timer.unit ?? '',
        next: timer.next ? Math.round(timer.next / 1000) : null,
        last: timer.last ? Math.round(timer.last / 1000) : null,
        result: shown.stdout.trim(),
      }
    }),
  )
  return results
}

export async function appDetail(id: string): Promise<AppDetail | null> {
  const all = await listApps()
  const app = all.find((item) => item.id === id)
  if (!app) return null
  const w = await world()
  const detail: AppDetail = {
    ...app,
    verdict: { level: 'safe', title: '', reasons: [], steps: [] },
    packageList: [],
    removes: [],
    freed: null,
    neededBy: [],
    unitList: [],
    listeners: [],
    siteList: [],
    folders: [],
    upgrades: [],
    held: [],
    git: null,
    timers: [],
    container: null,
  }
  const unitRecords = w.units.filter((unit) => app.units.includes(unit.name))
  detail.unitList = unitRecords.map(({ path: _path, pid: _pid, ...unit }) => unit)
  detail.listeners = w.listeners.filter((item) => (item.unit && app.units.includes(item.unit)) || app.ports.includes(item.port))
  detail.siteList = w.proxies
    .filter((proxy) => app.ports.includes(proxy.port))
    .map((proxy) => ({ name: proxy.site, url: `${proxy.scheme}://${proxy.site}${proxy.path.startsWith('/') ? proxy.path : '/'}`, how: `forwards ${proxy.path} to port ${proxy.port}` }))

  // The web server itself serves every site.
  if (app.packages.some((name) => /^(nginx|apache2|httpd|caddy)$/.test(name))) {
    const roots = await webRoots()
    const names = new Set([...roots.map((root) => root.site), ...w.proxies.map((proxy) => proxy.site)])
    detail.siteList = [...names].sort().map((name) => ({ name, url: `https://${name}/`, how: 'served by this web server' }))
    detail.sites = [...names]
  }

  if (app.kind === 'package') {
    detail.packageList = app.packages.map((name) => {
      const item = w.byName.get(name)
      return { name, version: item?.version ?? '', size: item?.size ?? 0, summary: item?.summary ?? '', manual: item?.manual ?? false, system: item?.locked ?? false }
    })
    detail.upgrades = w.upgrades.filter((upgrade) => app.packages.includes(upgrade.name.split(':')[0]!))
    const held = await heldPackages()
    detail.held = app.packages.filter((name) => held.has(name))

    // What depends on it, from outside the app.
    const dependents = await requiredBy(app.packages)
    const outside = new Set<string>()
    for (const list of dependents.values()) for (const name of list) if (!app.packages.includes(name)) outside.add(name)
    const appOf = (name: string) => all.find((item) => item.kind === 'package' && item.packages.includes(name))?.name ?? null
    detail.neededBy = [...outside]
      .filter((name) => w.byName.has(name))
      .map((name) => ({ name, app: appOf(name) }))
      .sort((a, b) => Number(b.app !== null) - Number(a.app !== null) || a.name.localeCompare(b.name))

    // Its own folders.
    const files = (await Promise.all(app.packages.map((name) => packageFiles(name)))).flat()
    // Shared trees (/usr/share/vim, /usr/lib/python3…) only count when the folder carries the app's name.
    const tokens = new Set(app.packages.flatMap((name) => [name, name.split('-')[0]!]).concat(app.name.split('-')[0]!).filter((token) => token.length > 2))
    const named = (path: string) => [...tokens].some((token) => path.split('/').pop()!.includes(token))
    const own = [...new Set(files.filter((file) => PACKAGE_FOLDER.test(file) && !SHARED.has(file)))]
      .filter((path) => /^\/(etc|var)\//.test(path) || named(path))
      .filter((path) => {
        try {
          return statSync(path).isDirectory()
        } catch {
          return false
        }
      })
      .slice(0, 30)
    // Data and logs are often created at run time rather than shipped: look for them by name too.
    for (const name of app.packages) {
      for (const candidate of [`/var/lib/${name}`, `/var/log/${name}`, `/var/cache/${name}`, `/etc/${name}`]) {
        if (!own.includes(candidate) && existsSync(candidate)) own.push(candidate)
      }
    }
    const sizes = await folderSizes(own)
    detail.folders = own.map((path) => ({ path, role: roleOf(path), size: sizes.get(path) ?? null })).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))

    // What removing the main package takes with it.
    const main = app.packages.find((name) => !w.byName.get(name)?.locked) ?? app.packages[0]!
    const plan = await removalPlan(main)
    if (plan.ok) {
      detail.removes = plan.removed
      detail.freed = plan.size
    }
    detail.verdict = packageVerdict(detail, plan.ok ? plan : null)
  }

  if (app.kind === 'service') {
    const unit = unitRecords[0]
    const folder = unit ? appFolder(unit) : null
    if (folder) {
      const sizes = await folderSizes([folder])
      detail.folders = [{ path: folder, role: 'program', size: sizes.get(folder) ?? null }]
      detail.size = sizes.get(folder) ?? null
      detail.git = await gitInfo(folder)
    }
    detail.timers = await timersFor(app.units)
    detail.verdict = serviceVerdict(detail, folder)
  }

  if (app.kind === 'container') {
    const out = await run(['docker', 'inspect', app.name], { timeout: 30_000 })
    try {
      const [info] = JSON.parse(out.stdout) as {
        Config?: { Image?: string; Labels?: Record<string, string> }
        State?: { Status?: string }
        Created?: string
        HostConfig?: { RestartPolicy?: { Name?: string } }
        Mounts?: { Source?: string; Destination?: string; Type?: string; Name?: string }[]
      }[]
      detail.container = {
        image: info?.Config?.Image ?? '',
        state: info?.State?.Status ?? '',
        created: info?.Created ? Date.parse(info.Created) : null,
        restart: info?.HostConfig?.RestartPolicy?.Name || 'no',
        mounts: (info?.Mounts ?? []).map((mount) => `${mount.Type === 'volume' ? `volume ${mount.Name}` : mount.Source} → ${mount.Destination}`),
        project: info?.Config?.Labels?.['com.docker.compose.project'] ?? null,
      }
    } catch {
      // Not readable.
    }
    detail.verdict = containerVerdict(detail)
  }

  if (app.kind === 'snap') {
    detail.verdict =
      app.group === 'system'
        ? { level: 'needed', title: 'Needed by the system', reasons: ['Other snaps run on top of this one.'], steps: [] }
        : { level: 'safe', title: 'Can be removed', reasons: ['Remove it with: snap remove ' + app.name], steps: [`snap remove ${app.name}`] }
  }

  return detail
}

function packageVerdict(detail: AppDetail, plan: { removed: string[]; blocked: string[]; warnings: string[] } | null): Verdict {
  if (detail.group === 'system' || (plan && plan.blocked.length)) {
    return {
      level: 'needed',
      title: 'Needed by the system',
      reasons: [
        plan?.blocked.length ? `Removing it would also remove ${plan.blocked.slice(0, 4).join(', ')}, which the system cannot run without.` : 'The operating system cannot run without it.',
      ],
      steps: ['Keep it. Updates are the only thing to do with it.'],
    }
  }
  const reasons: string[] = []
  const steps: string[] = []
  const users = detail.neededBy.filter((item) => item.app)
  if (plan?.warnings.length) reasons.push(...plan.warnings)
  if (users.length) {
    reasons.push(`${users.slice(0, 5).map((item) => item.app).filter((name, index, list) => list.indexOf(name) === index).join(', ')} ${users.length === 1 ? 'needs' : 'need'} it and would be removed with it.`)
    steps.push('Decide first whether you still need the apps that depend on it.')
  }
  if (detail.sites.length) {
    reasons.push(`Removing it takes ${detail.sites.slice(0, 4).join(', ')}${detail.sites.length > 4 ? ` and ${detail.sites.length - 4} more` : ''} offline.`)
    steps.push('Move or remove those websites first.')
  }
  const running = detail.unitList.filter((unit) => unit.active === 'active')
  if (running.length) reasons.push(`${running.map((unit) => pretty(unit.name)).join(', ')} ${running.length === 1 ? 'is' : 'are'} running now.`)
  const publicPorts = detail.listeners.filter((item) => item.public)
  if (publicPorts.length) reasons.push(`It accepts connections from the internet on port ${[...new Set(publicPorts.map((item) => item.port))].join(', ')}.`)
  const data = detail.folders.filter((folder) => folder.role === 'data' && (folder.size ?? 0) > 1024 ** 2)
  if (data.length) {
    reasons.push(`It keeps ${formatBytes(data.reduce((total, folder) => total + (folder.size ?? 0), 0))} of data in ${data.map((folder) => folder.path).join(', ')}, which uninstalling leaves in place.`)
    steps.push('Delete its data folders afterwards if you no longer need them.')
  }
  if (users.length) return { level: 'blocked', title: 'Other apps depend on it', reasons, steps }
  if (detail.sites.length || running.length || publicPorts.length) {
    steps.push('Stop it for a while to check that nothing breaks, then uninstall it.')
    return { level: 'caution', title: 'In use: check before removing', reasons, steps }
  }
  steps.unshift(`Uninstall it${detail.freed ? ` to free about ${formatBytes(detail.freed)}` : ''}.`)
  return { level: 'safe', title: 'Safe to remove', reasons: reasons.length ? reasons : ['Nothing else on the server uses it.'], steps }
}

function serviceVerdict(detail: AppDetail, folder: string | null): Verdict {
  const reasons: string[] = []
  const steps: string[] = []
  const unit = detail.unitList[0]
  if (detail.sites.length) {
    reasons.push(`It runs ${detail.sites.join(', ')}.`)
    steps.push(`Remove the web server settings of ${detail.sites.join(', ')} (in /etc/nginx/sites-enabled), then reload nginx.`)
  }
  if (unit?.active === 'active') reasons.push('It is running now.')
  if (detail.timers.length) {
    reasons.push(`${detail.timers.map((timer) => timer.name).join(', ')} keeps updating it.`)
    steps.push(`Stop and disable ${detail.timers.map((timer) => timer.name).join(', ')}.`)
  }
  steps.push(`Stop and disable ${detail.units[0]}, then delete its unit file.`)
  if (folder) steps.push(`Delete ${folder} once you are sure${detail.git ? '; the code also lives in git' : ''}.`)
  if (detail.sites.length || unit?.active === 'active') return { level: 'caution', title: 'In use: remove it step by step', reasons, steps }
  return { level: 'safe', title: 'Not in use', reasons: reasons.length ? reasons : ['It is stopped and no website points to it.'], steps }
}

function containerVerdict(detail: AppDetail): Verdict {
  const reasons: string[] = []
  if (detail.sites.length) reasons.push(`It runs ${detail.sites.join(', ')}.`)
  if (detail.running) reasons.push('It is running now.')
  if (detail.container?.mounts.length) reasons.push('It keeps data in mounted folders or volumes, which removing the container leaves in place.')
  const steps = [
    detail.container?.project ? `It belongs to the Compose project "${detail.container.project}": stop it with docker compose down in that project's folder.` : 'Stop it, then remove it with docker rm.',
  ]
  if (detail.sites.length || detail.running) return { level: 'caution', title: 'In use: check before removing', reasons, steps }
  return { level: 'safe', title: 'Not in use', reasons: reasons.length ? reasons : ['It is stopped and no website points to it.'], steps }
}

/** Start, stop or restart a container. */
export async function containerAction(name: string, action: string): Promise<{ ok: boolean; message: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) return { ok: false, message: 'Invalid container name.' }
  if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, message: 'Unknown action.' }
  const result = await run(['docker', action, name], { timeout: 120_000 })
  const verb = { start: 'Started', stop: 'Stopped', restart: 'Restarted' }[action]!
  logActivity({ area: 'service', action: result.ok ? `${verb} container` : `${verb} container: failed`, target: name, detail: result.ok ? '' : reason(result, ''), ok: result.ok })
  worldCache = null
  return { ok: result.ok, message: result.ok ? `${verb} ${name}.` : reason(result, `Could not ${action} ${name}.`) }
}

/** Forget what was read, after something changed. */
export function forgetApps() {
  worldCache = null
}

