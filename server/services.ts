import { logActivity } from './db.ts'
import { platform } from './platform.ts'
import { lines, readText, reason, run } from './sys.ts'

export interface ServiceInfo {
  name: string
  description: string
  load: string
  /** active, inactive, failed or activating: the same words on systemd and OpenRC. */
  active: string
  sub: string
  /** enabled, disabled, static… whether it starts at boot. */
  enabled: string
}

const openrc = platform.init === 'openrc'
const NAME = openrc ? /^[A-Za-z0-9@_.:-]{1,200}$/ : /^[A-Za-z0-9@_.:\\-]{1,200}\.service$/

// ---- systemd -------------------------------------------------------------------------

async function systemdServices(): Promise<ServiceInfo[]> {
  const [units, files] = await Promise.all([
    run(['systemctl', 'list-units', '--type=service', '--all', '--no-legend', '--plain', '--no-pager']),
    run(['systemctl', 'list-unit-files', '--type=service', '--no-legend', '--plain', '--no-pager']),
  ])

  const enabled = new Map<string, string>()
  for (const line of lines(files.stdout)) {
    const [name, state] = line.split(/\s+/)
    if (name && state) enabled.set(name, state)
  }

  const services: ServiceInfo[] = []
  for (const line of lines(units.stdout)) {
    const parts = line.split(/\s+/)
    const [name, load, active, sub] = parts
    if (!name || !load || !active || !sub || !name.endsWith('.service')) continue
    if (load === 'not-found') continue
    const template = name.replace(/@[^.]+\.service$/, '@.service')
    services.push({
      name,
      load,
      active,
      sub,
      description: parts.slice(4).join(' '),
      enabled: enabled.get(name) ?? enabled.get(template) ?? 'static',
    })
  }
  return services
}

// ---- OpenRC (Alpine) ----------------------------------------------------------------------

const OPENRC_STATE: Record<string, { active: string; sub: string }> = {
  started: { active: 'active', sub: 'running' },
  stopped: { active: 'inactive', sub: 'dead' },
  crashed: { active: 'failed', sub: 'crashed' },
  starting: { active: 'activating', sub: 'starting' },
  stopping: { active: 'deactivating', sub: 'stopping' },
  inactive: { active: 'inactive', sub: 'inactive' },
}

async function openrcServices(): Promise<ServiceInfo[]> {
  const [status, boot] = await Promise.all([
    run(['rc-status', '--servicelist', '--nocolor']),
    run(['rc-update', 'show', '--verbose']),
  ])
  const runlevels = new Map<string, string>()
  for (const line of lines(boot.stdout)) {
    const [name, levels] = line.split('|').map((part) => part.trim())
    if (name) runlevels.set(name, levels ?? '')
  }
  const services: ServiceInfo[] = []
  for (const line of lines(status.stdout)) {
    const match = line.match(/^(\S+)\s+\[\s*(\w+)/)
    if (!match) continue
    const [, name, word] = match
    const state = OPENRC_STATE[word!] ?? { active: 'inactive', sub: word! }
    const description = readText(`/etc/init.d/${name}`).match(/^description="?([^"\n]*)"?/m)?.[1] ?? ''
    services.push({
      name: name!,
      load: 'loaded',
      active: state.active,
      sub: state.sub,
      description,
      enabled: runlevels.get(name!) ? 'enabled' : 'disabled',
    })
  }
  return services
}

export async function listServices(): Promise<ServiceInfo[]> {
  const services = openrc ? await openrcServices() : platform.init === 'systemd' ? await systemdServices() : []
  const rank = (service: ServiceInfo) => (service.active === 'failed' ? 0 : service.active === 'active' ? 1 : 2)
  return services.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export async function failedUnits(): Promise<string[]> {
  if (openrc) return (await openrcServices()).filter((service) => service.active === 'failed').map((service) => service.name)
  if (platform.init !== 'systemd') return []
  const result = await run(['systemctl', 'list-units', '--failed', '--no-legend', '--plain', '--no-pager'])
  return lines(result.stdout).map((line) => line.split(/\s+/)[0]!).filter(Boolean)
}

const ACTIONS: Record<string, { past: string; systemd: string[]; openrc: (name: string) => string[] }> = {
  start: { past: 'Started', systemd: ['start'], openrc: (name) => ['rc-service', name, 'start'] },
  stop: { past: 'Stopped', systemd: ['stop'], openrc: (name) => ['rc-service', name, 'stop'] },
  restart: { past: 'Restarted', systemd: ['restart'], openrc: (name) => ['rc-service', name, 'restart'] },
  enable: { past: 'Enabled at boot', systemd: ['enable'], openrc: (name) => ['rc-update', 'add', name, 'default'] },
  // On OpenRC this is done runlevel by runlevel, below.
  disable: { past: 'Disabled at boot', systemd: ['disable'], openrc: (name) => ['rc-update', 'delete', name] },
  reset: { past: 'Cleared failed state', systemd: ['reset-failed'], openrc: (name) => ['rc-service', name, 'zap'] },
}

/** The service this panel runs as, so it is never stopped from its own interface. */
const OWN_SERVICE = openrc ? 'balai' : (readText('/proc/self/cgroup').match(/\/([^/\n]+\.service)$/m)?.[1] ?? null)

export async function serviceAction(name: string, action: string): Promise<{ ok: boolean; message: string }> {
  const spec = ACTIONS[action]
  if (!spec) return { ok: false, message: 'Unknown action.' }
  if (!platform.init) return { ok: false, message: 'No service manager was found on this system.' }
  if (!NAME.test(name)) return { ok: false, message: 'Invalid service name.' }
  if (name === OWN_SERVICE && action === 'stop') {
    return { ok: false, message: 'This is the panel itself. Stop it from a terminal instead.' }
  }

  const command = openrc ? spec.openrc(name) : ['systemctl', ...spec.systemd, '--', name]
  let result = openrc && action === 'disable' ? { ok: true, code: 0, stdout: '', stderr: '' } : await run(command, { timeout: 60_000 })
  if (openrc && action === 'disable') {
    // `rc-update --all delete` fails for every runlevel the service is not in, so only its own runlevels are named.
    const shown = await run(['rc-update', 'show', '--verbose'])
    const levels = lines(shown.stdout).find((line) => line.split('|')[0]?.trim() === name)?.split('|')[1]?.trim().split(/\s+/).filter(Boolean) ?? []
    for (const level of levels) {
      result = await run(['rc-update', 'delete', name, level], { timeout: 60_000 })
      if (!result.ok) break
    }
  }
  const message = result.ok ? `${spec.past}: ${name}` : reason(result, `${command[0]} failed.`)
  logActivity({
    area: 'service',
    action: result.ok ? spec.past : `${action} failed`,
    target: name,
    detail: result.ok ? '' : message,
    ok: result.ok,
  })
  return { ok: result.ok, message }
}

/** Recent log lines: the journal on systemd; on OpenRC, the service's own log file or the system log. */
export async function serviceLogs(name: string): Promise<{ ok: boolean; lines: string[] }> {
  if (!NAME.test(name)) return { ok: false, lines: [] }
  if (!openrc) {
    const result = await run(['journalctl', '-u', name, '-n', '200', '--no-pager', '-o', 'short-iso'])
    return { ok: result.ok, lines: result.stdout.split('\n').filter(Boolean) }
  }
  const own = readText(`/var/log/${name}.log`) || readText(`/var/log/${name}/${name}.log`)
  if (own) return { ok: true, lines: own.split('\n').filter(Boolean).slice(-200) }
  const system = readText('/var/log/messages').split('\n').filter((line) => line.includes(name))
  return { ok: true, lines: system.slice(-200) }
}
