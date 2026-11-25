import { bytes, elapsed } from '@/lib/format'
import type { Job } from '@/lib/types'

export function progressOf(job: Job): number | null {
  if (!job.total) return null
  return Math.min(100, (job.done / job.total) * 100)
}

export function amountOf(job: Job): string {
  if (job.unit === 'bytes') return job.total ? `${bytes(job.done)} of ${bytes(job.total)}` : bytes(job.done)
  if (job.unit === 'items') return job.total ? `${job.done} of ${job.total}` : `${job.done}`
  if (job.unit === 'files') return `${job.done} ${job.done === 1 ? 'file' : 'files'} found`
  return ''
}

/** Time left, from the pace so far; null until there is enough to go on. */
export function remainingOf(job: Job, now: number): string | null {
  if (job.state !== 'running' || !job.total || job.done <= 0 || job.done >= job.total) return null
  const spent = now - job.startedAt
  if (spent < 3000) return null
  const left = (spent / job.done) * (job.total - job.done)
  return `about ${elapsed(left)} left`
}

export function durationOf(job: Job, now: number): string {
  return elapsed((job.finishedAt ?? now) - job.startedAt)
}

export const stateLabel: Record<Job['state'], string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}
