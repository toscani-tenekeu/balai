import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export type JobState = 'running' | 'done' | 'failed' | 'cancelled'
export type StepState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'

export interface Step {
  title: string
  state: StepState
  detail: string | null
  startedAt?: number
  finishedAt?: number
}

export interface Job {
  id: string
  kind: 'search' | 'usage' | 'cleanup' | 'delete' | 'packages' | 'update'
  title: string
  state: JobState
  /** False for work that must not stop halfway, such as installing packages. */
  cancellable: boolean
  /** Why a job cannot be cancelled, shown next to it. */
  keep: string | null
  /** Progress: done out of total; total 0 means unknown. */
  done: number
  total: number
  unit: 'bytes' | 'items' | 'files' | null
  /** What the job is doing right now. */
  now: string | null
  steps: Step[]
  /** Recent output of the programs it runs. */
  output: string[]
  message: string | null
  errors: string[]
  startedAt: number
  finishedAt: number | null
  /** Page where the job's result is shown. */
  link: string | null
}

interface Entry {
  job: Job
  controller: AbortController
  result: unknown
}

/** The job, or request, the current code runs for. Programs started from it stop when it is cancelled. */
export interface Scope {
  signal: AbortSignal
  job: Job | null
}

export const scope = new AsyncLocalStorage<Scope>()

export class Cancelled extends Error {
  constructor() {
    super('Cancelled.')
  }
}

const jobs = new Map<string, Entry>()

export interface Handle {
  job: Job
  signal: AbortSignal
  readonly cancelled: boolean
  /** Throws once the job is cancelled; call it between pieces of work. */
  check(): void
  log(line: string): void
}

/**
 * Runs long work in the background; the request that starts it returns at once.
 * Cancelling marks the job cancelled straight away and kills every program it started,
 * so nothing waits for the work to notice.
 */
export function startJob(
  init: Pick<Job, 'kind' | 'title'> & Partial<Pick<Job, 'unit' | 'total' | 'link' | 'steps' | 'cancellable' | 'keep'>>,
  work: (handle: Handle) => Promise<{ message?: string; result?: unknown } | void>,
): Job {
  const job: Job = {
    id: randomUUID(),
    kind: init.kind,
    title: init.title,
    state: 'running',
    cancellable: init.cancellable ?? true,
    keep: init.keep ?? null,
    done: 0,
    total: init.total ?? 0,
    unit: init.unit ?? null,
    now: null,
    steps: init.steps ?? [],
    output: [],
    message: null,
    errors: [],
    startedAt: Date.now(),
    finishedAt: null,
    link: init.link ?? null,
  }
  const entry: Entry = { job, controller: new AbortController(), result: null }
  jobs.set(job.id, entry)
  const signal = entry.controller.signal

  const handle: Handle = {
    job,
    signal,
    get cancelled() {
      return signal.aborted
    },
    check() {
      if (signal.aborted) throw new Cancelled()
    },
    log(line: string) {
      job.output.push(line)
      if (job.output.length > 500) job.output.splice(0, job.output.length - 500)
    },
  }

  void scope.run({ signal, job }, async () => {
    try {
      const outcome = await work(handle)
      if (signal.aborted) return
      entry.result = outcome?.result ?? null
      job.message = outcome?.message ?? null
      job.state = job.errors.length ? 'failed' : 'done'
    } catch (error) {
      if (signal.aborted) return
      job.state = 'failed'
      job.message = error instanceof Error ? error.message : String(error)
    }
    job.now = null
    job.finishedAt = Date.now()
  })

  return job
}

export function listJobs(): Job[] {
  const now = Date.now()
  for (const [id, entry] of jobs) {
    // Finished jobs stay listed for an hour.
    if (entry.job.finishedAt && now - entry.job.finishedAt > 3_600_000) jobs.delete(id)
  }
  return [...jobs.values()].map((entry) => entry.job).sort((a, b) => b.startedAt - a.startedAt)
}

export function getJob(id: string): { job: Job; result: unknown } | null {
  const entry = jobs.get(id)
  return entry ? { job: entry.job, result: entry.result } : null
}

export const runningJob = (kind: Job['kind']) =>
  [...jobs.values()].find((entry) => entry.job.kind === kind && entry.job.state === 'running')?.job ?? null

export function cancelJob(id: string): { ok: boolean; message: string } {
  const entry = jobs.get(id)
  if (!entry || entry.job.state !== 'running') return { ok: false, message: 'This task has already finished.' }
  if (!entry.job.cancellable) return { ok: false, message: entry.job.keep ?? 'This task cannot be stopped.' }
  const { job } = entry
  job.state = 'cancelled'
  job.message = 'Cancelled.'
  job.now = null
  job.finishedAt = Date.now()
  for (const step of job.steps) if (step.state === 'running' || step.state === 'waiting') step.state = 'skipped'
  entry.controller.abort()
  return { ok: true, message: 'Cancelled.' }
}

export function clearFinished() {
  for (const [id, entry] of jobs) if (entry.job.state !== 'running') jobs.delete(id)
}

/** Runs work as one step of a job's list, keeping the step's state and timing in line with the outcome. */
export async function step<T>(handle: Handle, index: number, work: () => Promise<T>): Promise<T> {
  const item = handle.job.steps[index]!
  handle.check()
  item.state = 'running'
  item.startedAt = Date.now()
  handle.job.now = item.title
  try {
    const value = await work()
    if (!handle.cancelled) item.state = 'done'
    return value
  } catch (error) {
    if (!handle.cancelled) {
      item.state = 'failed'
      item.detail = error instanceof Error ? error.message : String(error)
    }
    throw error
  } finally {
    item.finishedAt = Date.now()
  }
}

/** Long loops in the server's own code await this often: it lets other requests in and stops a cancelled job. */
export function pacer(handle: Handle) {
  let last = Date.now()
  return async () => {
    handle.check()
    if (Date.now() - last < 25) return
    await Bun.sleep(0)
    last = Date.now()
    handle.check()
  }
}
