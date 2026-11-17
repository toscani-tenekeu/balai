import { logActivity } from './db.ts'
import { lines, readText, run } from './sys.ts'

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

export async function listProcesses(): Promise<ProcessInfo[]> {
  const result = await run([
    'ps', '-eo', 'pid=,ppid=,user:32=,pcpu=,pmem=,rss=,stat=,etimes=,args=', '--sort=-pcpu',
  ])
  const list: ProcessInfo[] = []
  for (const line of lines(result.stdout)) {
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[9]!
    // Kernel threads have no memory of their own and cannot be acted on.
    if (Number(match[2]) === 2 || pid === 2 || command.startsWith('ps -eo pid=')) continue
    list.push({
      pid,
      ppid: Number(match[2]),
      user: match[3]!,
      cpu: Number(match[4]),
      memory: Number(match[5]),
      rss: Number(match[6]) * 1024,
      state: match[7]!,
      elapsed: Number(match[8]),
      name: readText(`/proc/${pid}/comm`).trim() || command.split(' ')[0]!,
      command,
    })
  }
  return list
}

const SIGNALS = { stop: 'SIGTERM', kill: 'SIGKILL' } as const

export function signalProcess(pid: number, action: string): { ok: boolean; message: string } {
  if (!(action in SIGNALS)) return { ok: false, message: 'Unknown action.' }
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, message: 'This process cannot be stopped.' }
  if (pid === process.pid) return { ok: false, message: 'This is the panel itself.' }

  const name = readText(`/proc/${pid}/comm`).trim()
  if (!name) return { ok: false, message: 'The process has already exited.' }

  const signal = SIGNALS[action as keyof typeof SIGNALS]
  try {
    process.kill(pid, signal)
    logActivity({ area: 'process', action: action === 'kill' ? 'Force stopped' : 'Stopped', target: `${name} (${pid})` })
    return { ok: true, message: `${signal} sent to ${name}.` }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The signal could not be sent.'
    logActivity({ area: 'process', action: 'Stop failed', target: `${name} (${pid})`, detail: message, ok: false })
    return { ok: false, message }
  }
}
