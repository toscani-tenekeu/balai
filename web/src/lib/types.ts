export type Status = 'ok' | 'warning' | 'critical'

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

export interface Overview {
  host: { name: string; os: string; kernel: string; arch: string; uptime: number }
  cpu: { model: string; cores: number; percent: number; load: [number, number, number] }
  memory: {
    total: number; available: number; used: number; cached: number; percent: number
    swapTotal: number; swapUsed: number; swapPercent: number
  }
  filesystems: Filesystem[]
}

export interface Check {
  id: string
  title: string
  status: Status
  detail: string
  link: string | null
}

export interface Health {
  status: Status
  checks: Check[]
}

export interface Sample {
  at: number
  cpu: number
  mem: number
  disk: number
  load: number
}

export interface ProcessInfo {
  pid: number
  ppid: number
  user: string
  cpu: number
  memory: number
  rss: number
  state: string
  elapsed: number
  name: string
  command: string
}

export interface ServiceInfo {
  name: string
  description: string
  load: string
  active: string
  sub: string
  enabled: string
}

export interface CleanupItem {
  id: string
  title: string
  description: string
  recommended: boolean
  kind: 'disk' | 'memory'
  bytes: number | null
  note: string | null
}

export interface CleanupResult {
  ok: boolean
  message: string
  freed: number
  results: { id: string; title: string; ok: boolean; message: string | null; freed: number; released?: number }[]
}

export interface DiskUsage {
  path: string
  parent: string | null
  total: number
  entries: { path: string; name: string; size: number; directory: boolean; locked: boolean }[]
}

export interface PackageState {
  upgrades: { name: string; current: string; next: string; security: boolean }[]
  rebootRequired: boolean
  rebootPackages: string[]
  indexAge: number | null
  checkedAt: number
  /** apt, dnf, yum, zypper, pacman or apk; null when this system's package manager is not supported. */
  manager: string | null
  canUpgradeOne: boolean
  canPurge: boolean
  tracksSecurity: boolean
}

export interface Listener {
  protocol: string
  address: string
  port: number
  process: string
  pid: number | null
  unit: string | null
  public: boolean
}

export interface ActivityRow {
  id: number
  at: number
  area: string
  action: string
  target: string
  detail: string
  ok: number
  freed: number
}

export interface UpdateState {
  managed: boolean
  version: string
  commit: string
  latestVersion: string | null
  available: boolean
  commits: { hash: string; subject: string; at: number }[]
  checkedAt: number | null
  error: string | null
  installing: boolean
  auto: boolean
}

export interface ActionResult {
  ok: boolean
  message: string
}

export interface InstalledPackage {
  name: string
  version: string
  size: number
  summary: string
  manual: boolean
  locked: boolean
}

export interface RemovalPlan {
  ok: boolean
  name: string
  removed: string[]
  size: number
  blocked: string[]
  warnings: string[]
}

export interface PackageJob {
  id: string
  title: string
  running: boolean
  ok: boolean | null
  output: string[]
  startedAt: number
  finishedAt: number | null
}

export interface FoundFile {
  path: string
  size: number
  modified: number
  locked: boolean
}

export interface FileSearch {
  ok: boolean
  path: string
  extensions: string[]
  count: number
  total: number
  truncated: boolean
  files: FoundFile[]
}

export interface DeleteResult {
  ok: boolean
  deleted: number
  freed: number
  failed: { path: string; message: string }[]
}

export interface CleanupSchedule {
  enabled: boolean
  lastRun: number | null
  nextRun: number | null
}

export type JobState = 'running' | 'done' | 'failed' | 'cancelled'

export interface JobStep {
  title: string
  state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped'
  detail: string | null
  startedAt?: number
  finishedAt?: number
}

export interface Job {
  id: string
  kind: 'search' | 'usage' | 'cleanup' | 'delete' | 'packages' | 'update'
  title: string
  state: JobState
  cancellable: boolean
  keep: string | null
  done: number
  total: number
  unit: 'bytes' | 'items' | 'files' | null
  now: string | null
  steps: JobStep[]
  output: string[]
  message: string | null
  errors: string[]
  startedAt: number
  finishedAt: number | null
  link: string | null
}

export interface Started {
  ok: boolean
  job: Job
}

export type Use = 'used' | 'maybe' | 'unused'

export interface FileUse {
  path: string
  use: Use
  label: string
  reasons: string[]
  site: { name: string; url: string } | null
  release: { site: string; current: string; previous: boolean } | null
  project: { root: string; git: 'tracked' | 'untracked' | 'ignored' | null } | null
  references: { file: string; line: number }[]
  referenceCount: number
  requests: { count: number; last: number | null; since: number | null } | null
  openBy: string[]
  copyOf: string | null
}

export interface CleanupOutcome {
  results: CleanupResult['results']
  freed: number
}

export interface PlanPackage {
  name: string
  download: number | null
  change: number | null
  cached: boolean
  restart: boolean
}

export interface DiskImpact {
  mount: string
  free: number
  size: number
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
  unknown: number
  disks: DiskImpact[]
  seconds: number
  learnedFrom: number
  restart: string[]
  keptBack: string[]
  warnings: string[]
}
