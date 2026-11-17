import { logActivity } from './db.ts'
import { lines, reason, run } from './sys.ts'

export interface ServiceInfo {
  name: string
  description: string
  load: string
  active: string
  sub: string
  enabled: string
}

const NAME = /^[A-Za-z0-9@_.:\\-]{1,200}\.service$/

export async function listServices(): Promise<ServiceInfo[]> {
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

  const rank = (service: ServiceInfo) => (service.active === 'failed' ? 0 : service.active === 'active' ? 1 : 2)
  return services.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export async function failedUnits(): Promise<string[]> {
  const result = await run(['systemctl', 'list-units', '--failed', '--no-legend', '--plain', '--no-pager'])
  return lines(result.stdout).map((line) => line.split(/\s+/)[0]!).filter(Boolean)
}

const ACTIONS: Record<string, { past: string; args: string[] }> = {
  start: { past: 'Started', args: ['start'] },
  stop: { past: 'Stopped', args: ['stop'] },
  restart: { past: 'Restarted', args: ['restart'] },
  enable: { past: 'Enabled at boot', args: ['enable'] },
  disable: { past: 'Disabled at boot', args: ['disable'] },
  reset: { past: 'Cleared failed state', args: ['reset-failed'] },
}

export async function serviceAction(name: string, action: string): Promise<{ ok: boolean; message: string }> {
  const spec = ACTIONS[action]
  if (!spec) return { ok: false, message: 'Unknown action.' }
  if (!NAME.test(name)) return { ok: false, message: 'Invalid service name.' }

  const result = await run(['systemctl', ...spec.args, '--', name], { timeout: 60_000 })
  const message = result.ok ? `${spec.past}: ${name}` : reason(result, 'systemctl failed.')
  logActivity({
    area: 'service',
    action: result.ok ? spec.past : `${action} failed`,
    target: name,
    detail: result.ok ? '' : message,
    ok: result.ok,
  })
  return { ok: result.ok, message }
}

export async function serviceLogs(name: string): Promise<{ ok: boolean; lines: string[] }> {
  if (!NAME.test(name)) return { ok: false, lines: [] }
  const result = await run(['journalctl', '-u', name, '-n', '200', '--no-pager', '-o', 'short-iso'])
  return { ok: result.ok, lines: result.stdout.split('\n').filter(Boolean) }
}
