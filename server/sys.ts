import { readFileSync } from 'node:fs'
import { Cancelled, scope } from './jobs.ts'

export interface RunResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

/**
 * The panel's environment without the variables OpenRC gives the service it runs: with RC_SVCNAME set,
 * OpenRC's own tools act as if they were called from inside that service and, for one, hide it.
 */
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^RC_/.test(key)))

const SETSID = Bun.which('setsid')

export interface SpawnOptions {
  timeout?: number
  env?: Record<string, string>
  input?: string
  cwd?: string
}

/**
 * Starts a program in its own process group. When the task or request it runs for is cancelled,
 * or the time limit passes, the whole group is killed at once, children of a shell included.
 */
export function spawn(cmd: string[], opts: SpawnOptions = {}) {
  const signal = scope.getStore()?.signal
  if (signal?.aborted) throw new Cancelled()
  const proc = Bun.spawn(SETSID ? [SETSID, ...cmd] : cmd, {
    cwd: opts.cwd,
    stdin: opts.input === undefined ? 'ignore' : new Blob([opts.input]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...baseEnv, LC_ALL: 'C', LANG: 'C', ...opts.env },
  })
  const kill = () => {
    try {
      // setsid makes the program the leader of a new group whose id is its pid.
      if (SETSID) process.kill(-proc.pid, 'SIGKILL')
      else proc.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
  const timer = setTimeout(kill, opts.timeout ?? 15_000)
  signal?.addEventListener('abort', kill, { once: true })
  void proc.exited.finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', kill)
  })
  return proc
}

/**
 * Runs a program with an explicit argument list. Nothing goes through a shell,
 * so values taken from a request can never be interpreted as shell syntax.
 */
export async function run(cmd: string[], opts: SpawnOptions = {}): Promise<RunResult> {
  try {
    const proc = spawn(cmd, opts)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { ok: code === 0, code, stdout, stderr }
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return { ok: false, code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

/** Reads a program's output line by line as it comes. */
export async function eachLine(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const decoder = new TextDecoder()
  let rest = ''
  for await (const chunk of stream) {
    const parts = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n|\r/)
    rest = parts.pop() ?? ''
    for (const part of parts) if (part.trim()) onLine(part)
  }
  if (rest.trim()) onLine(rest)
}

export function has(program: string): boolean {
  return Bun.which(program) !== null
}

export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** Last meaningful line of a command's error output, for showing to the user. */
export function reason(result: RunResult, fallback: string): string {
  const all = lines(result.stderr).concat(lines(result.stdout))
  return all.at(-1) ?? fallback
}

/** Sizes as people read them: 512 B, 3.4 MB, 1.2 GB. */
export function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`
}
