import { lines, readText, run } from './sys.ts'

export interface Listener {
  protocol: string
  address: string
  port: number
  process: string
  pid: number | null
  /** systemd service the program belongs to, when there is one. */
  unit: string | null
  public: boolean
}

function unitOf(pid: number): string | null {
  const match = readText(`/proc/${pid}/cgroup`).match(/\/([^/\n]+\.service)(?:\/[^\n]*)?$/m)
  return match ? match[1]! : null
}

export async function listListeners(): Promise<Listener[]> {
  const result = await run(['ss', '-H', '-tulnp'])
  const seen = new Set<string>()
  const list: Listener[] = []

  for (const line of lines(result.stdout)) {
    const parts = line.split(/\s+/)
    const protocol = parts[0]
    const local = parts[4]
    if (!protocol || !local) continue
    const split = local.lastIndexOf(':')
    const address = local.slice(0, split).replace(/^\[|\]$/g, '').replace(/%.*$/, '')
    const port = Number(local.slice(split + 1))
    if (!Number.isInteger(port)) continue

    const owner = line.match(/users:\(\("([^"]+)",pid=(\d+)/)
    const key = `${protocol}|${address}|${port}`
    if (seen.has(key)) continue
    seen.add(key)

    list.push({
      protocol,
      address,
      port,
      process: owner?.[1] ?? '',
      pid: owner ? Number(owner[2]) : null,
      unit: owner ? unitOf(Number(owner[2])) : null,
      public: !(address.startsWith('127.') || address === '::1'),
    })
  }
  return list.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol))
}
