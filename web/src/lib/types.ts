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
  results: { id: string; title: string; ok: boolean; message: string | null; freed: number }[]
}

export interface DiskUsage {
  path: string
  parent: string | null
  total: number
  entries: { path: string; name: string; size: number; directory: boolean }[]
}

export interface PackageState {
  upgrades: { name: string; current: string; next: string; security: boolean }[]
  rebootRequired: boolean
  rebootPackages: string[]
  indexAge: number | null
  checkedAt: number
}

export interface Listener {
  protocol: string
  address: string
  port: number
  process: string
  pid: number | null
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
