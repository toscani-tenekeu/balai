/**
 * What cleaning must leave alone. A stopped container or a removed package can still be needed:
 * a server that ran out of disk stops its services without anyone meaning to remove them, and the
 * removal script of a replaced package can act on the package that took its place.
 */
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { lines, readText, run } from './sys.ts'

export interface Kept {
  name: string
  reason: string
}

/** What an item would remove if cleaned now, and what it leaves alone and why. */
export interface Selection {
  removes: string[]
  keeps: Kept[]
}

// ---- Stopped containers ------------------------------------------------------------

/** A container stopped for less than this is more likely broken or paused than finished with. */
export const CONTAINER_AGE_DAYS = 7

export interface Container {
  id: string
  name: string
  /** Docker's restart policy: empty or "no" when it is not started again by itself. */
  restart: string
  /** Compose project it belongs to, if any. */
  project: string
  /** Made by `compose run` for a single command. */
  oneOff: boolean
  finishedAt: string
}

/** Why a stopped container must stay, or null when it is safe to remove. */
export function containerKeptBecause(item: Container, now = Date.now()): string | null {
  if (item.restart && item.restart !== 'no') return 'set to start again by itself'
  if (item.project && !item.oneOff) return `part of the ${item.project} Compose project`
  const finished = Date.parse(item.finishedAt)
  if (!(finished > 0)) return 'when it stopped is not known'
  if (now - finished < CONTAINER_AGE_DAYS * 86_400_000) return `stopped less than ${CONTAINER_AGE_DAYS} days ago`
  return null
}

const FIELDS = [
  '{{.Id}}',
  '{{.Name}}',
  '{{.HostConfig.RestartPolicy.Name}}',
  '{{index .Config.Labels "com.docker.compose.project"}}',
  '{{index .Config.Labels "com.docker.compose.oneoff"}}',
  '{{.State.FinishedAt}}',
].join('\t')

export async function stoppedContainers(): Promise<Selection & { ids: string[] }> {
  const listed = await run(['docker', 'ps', '-aq', '--no-trunc', '--filter', 'status=exited', '--filter', 'status=dead'])
  const found = lines(listed.stdout)
  const result = { ids: [] as string[], removes: [] as string[], keeps: [] as Kept[] }
  if (!found.length) return result
  const inspected = await run(['docker', 'inspect', '--format', FIELDS, ...found], { timeout: 60_000 })
  // Not trimmed: empty fields at either end of a line still count.
  for (const line of inspected.stdout.split('\n')) {
    const parts = line.split('\t')
    if (parts.length !== 6) continue
    // Docker prints "<no value>" for a label the container does not have.
    const [id, rawName, restart, project, oneOff, finishedAt] = parts.map((part) => (part === '<no value>' ? '' : part)) as [string, string, string, string, string, string]
    const name = rawName.replace(/^\//, '')
    const reason = containerKeptBecause({ id, name, restart, project, oneOff: oneOff === 'True', finishedAt })
    if (reason) result.keeps.push({ name, reason })
    else {
      result.ids.push(id)
      result.removes.push(name)
    }
  }
  return result
}

// ---- Settings of removed packages --------------------------------------------------

/** Purging these can delete databases, containers or virtual machines along with the settings. */
const HOLDS_DATA = /^(mysql|mariadb|percona|postgresql|mongodb|redis|docker|containerd|podman|lxd|incus|libvirt)(?![a-z])/

const UNIT_DIRS = ['/etc/systemd/system', '/run/systemd/system', '/usr/local/lib/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system']

/** Services a package's removal script names. */
export function servicesNamed(script: string): string[] {
  const code = script.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  const units = [...code.matchAll(/([A-Za-z0-9_@.-]+\.(?:service|socket|timer))\b/g)].map((match) => match[1]!)
  const scripts = [...code.matchAll(/(?:invoke-rc\.d|update-rc\.d|\/etc\/init\.d\/)\s*(?:-\S+\s+)*([A-Za-z0-9_][A-Za-z0-9_.-]*)/g)]
    .map((match) => `${match[1]}.service`)
  return [...new Set([...units, ...scripts])]
}

/** A unit file that is there and not masked. */
function unitExists(unit: string): boolean {
  return UNIT_DIRS.some((dir) => {
    const path = join(dir, unit)
    try {
      return existsSync(path) && realpathSync(path) !== '/dev/null'
    } catch {
      return false
    }
  })
}

/** Why a removed package's leftovers must stay, or null when purging them is safe. */
export function leftoverKeptBecause(name: string, script: string, present = unitExists): string | null {
  if (HOLDS_DATA.test(name)) return 'removing it for good can delete data'
  const service = servicesNamed(script).find((unit) => present(unit))
  if (service) return `its removal script acts on ${service}, which is still on this server`
  return null
}

/** Sorts removed packages (as dpkg names them) into those safe to purge and those to keep. */
export function sortLeftovers(names: string[], info = '/var/lib/dpkg/info'): Selection {
  const result: Selection = { removes: [], keeps: [] }
  for (const name of names) {
    const bare = name.split(':')[0]!
    // Both scripts run on a purge; multi-arch packages keep the architecture in the file name.
    const script = [...new Set([name, bare])]
      .flatMap((file) => [readText(join(info, `${file}.prerm`)), readText(join(info, `${file}.postrm`))])
      .join('\n')
    const reason = leftoverKeptBecause(bare, script)
    if (reason) result.keeps.push({ name, reason })
    else result.removes.push(name)
  }
  return result
}
