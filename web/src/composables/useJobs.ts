import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { api, messageOf, post } from '@/lib/api'
import type { Job } from '@/lib/types'

/** Every task the server is running or finished in the last hour, newest first. */
export const jobs = ref<Job[]>([])
export const running = computed(() => jobs.value.filter((job) => job.state === 'running'))

const known = new Map<string, Job['state']>()
const waiting = new Map<string, ((job: Job) => void)[]>()
/** Tasks a page follows itself: their end is shown there, not as a notice. */
const quiet = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined
let started = false

function settle(job: Job) {
  for (const resolve of waiting.get(job.id) ?? []) resolve(job)
  waiting.delete(job.id)
  if (quiet.has(job.id)) return
  if (job.state === 'done') toast.success(job.message ?? `${job.title}: done.`)
  else if (job.state === 'failed') toast.error(job.message ?? `${job.title}: failed.`, { description: job.errors.slice(0, 3).join('\n') || undefined })
}

async function poll() {
  clearTimeout(timer)
  try {
    const list = await api<Job[]>('/jobs')
    for (const job of list) {
      if (known.get(job.id) === 'running' && job.state !== 'running') settle(job)
      known.set(job.id, job.state)
    }
    jobs.value = list
  } catch {
    // Tried again on the next tick.
  }
  timer = setTimeout(poll, running.value.length ? 700 : 5000)
}

export function startPolling() {
  if (started) return
  started = true
  void poll()
}

/** Follows a task the server just started; the promise resolves when it ends, however it ends. */
export function track(job: Job, options: { quiet?: boolean } = {}): Promise<Job> {
  if (options.quiet) quiet.add(job.id)
  known.set(job.id, job.state)
  jobs.value = [job, ...jobs.value.filter((item) => item.id !== job.id)]
  const done = new Promise<Job>((resolve) => {
    if (job.state !== 'running') return resolve(job)
    waiting.set(job.id, [...(waiting.get(job.id) ?? []), resolve])
  })
  void poll()
  return done
}

/** The task as last seen, kept up to date by polling. */
export const jobById = (id: string | null) => computed(() => jobs.value.find((job) => job.id === id) ?? null)

/** A task with its result, once it has finished. */
export const jobResult = <T>(id: string) => api<{ job: Job; result: T | null }>(`/jobs/${id}`)

/** Cancels at once in the interface too: the server has already stopped the work when it answers. */
export async function cancel(job: Job) {
  try {
    await post(`/jobs/${job.id}/cancel`)
    const local = jobs.value.find((item) => item.id === job.id)
    if (local) {
      local.state = 'cancelled'
      local.message = 'Cancelled.'
      local.finishedAt = Date.now()
    }
    known.set(job.id, 'cancelled')
    const followed = quiet.has(job.id)
    settle({ ...job, state: 'cancelled', message: 'Cancelled.' })
    if (!followed) toast(`${job.title}: cancelled.`)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  void poll()
}

export async function clearFinished() {
  jobs.value = await post<Job[]>('/jobs/clear').catch(() => jobs.value)
}
