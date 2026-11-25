<script setup lang="ts">
import { CircleCheckIcon, CircleMinusIcon, CircleXIcon, RefreshCwIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cancel, jobResult, jobs, startPolling, track } from '@/composables/useJobs'
import { useResource } from '@/composables/useResource'
import { messageOf, post } from '@/lib/api'
import { bytes, dateTime } from '@/lib/format'
import { progressOf } from '@/lib/tasks'
import type { CleanupItem, CleanupOutcome, CleanupSchedule, Job, Started } from '@/lib/types'

const { data, error, loading, refresh } = useResource<CleanupItem[]>('/cleanup')
const { data: schedule } = useResource<CleanupSchedule>('/cleanup/schedule')
const selected = ref<Record<string, boolean>>({})

async function setSchedule(enabled: boolean) {
  try {
    schedule.value = await post<CleanupSchedule>('/cleanup/schedule', { enabled })
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
const confirming = ref(false)
const result = ref<{ job: Job; outcome: CleanupOutcome | null } | null>(null)
const started = ref<string | null>(null)

// The cleanup this page follows: one started here, or one already running, such as the weekly run.
const task = computed(
  () =>
    jobs.value.find((job) => job.id === started.value) ??
    jobs.value.find((job) => job.kind === 'cleanup' && job.state === 'running') ??
    null,
)
const running = computed(() => task.value?.state === 'running')
const stepOf = (item: CleanupItem) => (running.value ? task.value?.steps.find((entry) => entry.title === item.title) : undefined)

startPolling()
watch(
  () => task.value?.state,
  async (state, before) => {
    if (before !== 'running' || state === 'running' || !task.value) return
    const finished = task.value
    const answer = await jobResult<CleanupOutcome>(finished.id).catch(() => null)
    result.value = { job: answer?.job ?? finished, outcome: answer?.result ?? null }
    await refresh()
  },
)

let initialised = false

const hasSomething = (item: CleanupItem) =>
  item.bytes === null ? !item.note?.startsWith('0 ') : item.bytes > 0

watch(data, (items) => {
  if (!items || initialised) return
  initialised = true
  for (const item of items) selected.value[item.id] = item.recommended && hasSomething(item)
})

const chosen = computed(() => (data.value ?? []).filter((item) => selected.value[item.id]))

// Suggested order, or by size; items whose size is not a number of bytes go last.
const order = ref('suggested')
const ordered = computed(() => {
  const list = [...(data.value ?? [])]
  if (order.value === 'suggested') return list
  const direction = order.value === 'largest' ? -1 : 1
  return list.sort((a, b) => {
    if (a.bytes === null || b.bytes === null) return a.bytes === null ? (b.bytes === null ? 0 : 1) : -1
    return (a.bytes - b.bytes) * direction
  })
})
const total = computed(() =>
  chosen.value.reduce((sum, item) => sum + (item.kind === 'disk' && item.id !== 'journal' ? item.bytes ?? 0 : 0), 0),
)

function size(item: CleanupItem): string {
  if (item.bytes === null) return item.note ?? ''
  return item.note ? `${bytes(item.bytes)} ${item.note}` : bytes(item.bytes)
}

async function run() {
  confirming.value = false
  result.value = null
  try {
    const answer = await post<Started>('/cleanup', { ids: chosen.value.map((item) => item.id) })
    started.value = answer.job.id
    void track(answer.job, { quiet: true })
    for (const item of chosen.value) selected.value[item.id] = false
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <LoadError :message="error" />

  <Card v-if="task && running">
    <CardHeader>
      <CardTitle>{{ task.title }}</CardTitle>
      <CardDescription>{{ task.now ?? 'Starting…' }}</CardDescription>
      <CardAction>
        <Button variant="outline" size="sm" @click="cancel(task)">Cancel</Button>
      </CardAction>
    </CardHeader>
    <CardContent>
      <Progress :model-value="progressOf(task) ?? 0" />
      <p class="text-muted-foreground mt-2 text-xs tabular-nums">{{ task.done }} of {{ task.total }} done</p>
    </CardContent>
  </Card>

  <Alert v-if="result && result.job.state === 'cancelled'">
    <CircleMinusIcon />
    <AlertTitle>Cleanup cancelled</AlertTitle>
    <AlertDescription>
      Items cleaned before it was cancelled stay cleaned.
      <template v-if="result.job.steps.some((entry) => entry.state === 'done')">
        Done: {{ result.job.steps.filter((entry) => entry.state === 'done').map((entry) => entry.title).join(', ') }}.
      </template>
    </AlertDescription>
  </Alert>
  <Alert v-else-if="result && result.outcome" :variant="result.job.state === 'done' ? 'default' : 'destructive'">
    <CircleCheckIcon v-if="result.job.state === 'done'" />
    <TriangleAlertIcon v-else />
    <AlertTitle>
      {{ result.job.state === 'done' ? `Done. ${bytes(result.outcome.freed)} freed.` : `Finished with errors. ${bytes(result.outcome.freed)} freed.` }}
    </AlertTitle>
    <AlertDescription>
      <ul>
        <li v-for="entry in result.outcome.results" :key="entry.id">
          {{ entry.title }}:
          {{ entry.ok ? (entry.freed ? bytes(entry.freed) : entry.released ? `${bytes(entry.released)} of memory released` : 'done') : entry.message }}
        </li>
      </ul>
    </AlertDescription>
  </Alert>
  <Alert v-else-if="result" variant="destructive">
    <TriangleAlertIcon />
    <AlertTitle>The cleanup failed</AlertTitle>
    <AlertDescription>{{ result.job.message }}</AlertDescription>
  </Alert>

  <Card>
    <CardHeader>
      <CardTitle>What to clean</CardTitle>
      <CardDescription>
        Items that are always safe to remove are ticked for you. The others are explained and left for you to decide.
      </CardDescription>
      <CardAction class="flex gap-2">
        <Select v-model="order">
          <SelectTrigger size="sm" class="w-40" aria-label="Order">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="suggested">Suggested order</SelectItem>
            <SelectItem value="largest">Largest first</SelectItem>
            <SelectItem value="smallest">Smallest first</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" :disabled="loading || running" @click="refresh">
          <RefreshCwIcon data-icon="inline-start" />
          Measure again
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent>
      <FieldGroup v-if="data" class="gap-0 divide-y">
        <Field v-for="item in ordered" :key="item.id" orientation="horizontal" class="py-3 first:pt-0 last:pb-0">
          <Checkbox :id="`clean-${item.id}`" v-model="selected[item.id]" :disabled="running" />
          <FieldContent>
            <FieldLabel :for="`clean-${item.id}`">{{ item.title }}</FieldLabel>
            <FieldDescription>{{ item.description }}</FieldDescription>
          </FieldContent>
          <span v-if="stepOf(item)" class="text-muted-foreground flex items-center gap-1.5 text-sm whitespace-nowrap">
            <Spinner v-if="stepOf(item)!.state === 'running'" />
            <CircleCheckIcon v-else-if="stepOf(item)!.state === 'done'" class="size-4" />
            <CircleXIcon v-else-if="stepOf(item)!.state === 'failed'" class="text-destructive size-4" />
            {{ stepOf(item)!.state === 'running' ? 'Cleaning…' : stepOf(item)!.state === 'waiting' ? 'Waiting' : stepOf(item)!.detail ?? stepOf(item)!.state }}
          </span>
          <span v-else class="text-sm font-medium whitespace-nowrap tabular-nums">{{ size(item) }}</span>
        </Field>
      </FieldGroup>
      <div v-else class="flex flex-col gap-3">
        <Skeleton v-for="index in 7" :key="index" class="h-12" />
      </div>
    </CardContent>
    <CardFooter class="justify-between gap-4 border-t">
      <p class="text-muted-foreground text-sm">
        <template v-if="chosen.length">{{ chosen.length }} selected, about {{ bytes(total) }} to free</template>
        <template v-else>Nothing selected</template>
      </p>
      <Button :disabled="!chosen.length || running" @click="confirming = true">
        <Spinner v-if="running" />
        {{ running ? 'Cleaning…' : 'Clean selected' }}
      </Button>
    </CardFooter>
  </Card>

  <Card v-if="schedule">
    <CardContent>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel for="auto-clean">Clean every week</FieldLabel>
          <FieldDescription>
            Once a week, Balai removes the items that are always safe to remove. The others are never cleaned on their own.
            <template v-if="schedule.nextRun">Next run on {{ dateTime(schedule.nextRun) }}.</template>
            <template v-if="schedule.lastRun">Last run on {{ dateTime(schedule.lastRun) }}.</template>
          </FieldDescription>
        </FieldContent>
        <Switch id="auto-clean" :model-value="schedule.enabled" @update:model-value="setSchedule" />
      </Field>
    </CardContent>
  </Card>

  <AlertDialog v-model:open="confirming">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Clean {{ chosen.length }} {{ chosen.length === 1 ? 'item' : 'items' }}?</AlertDialogTitle>
        <AlertDialogDescription>
          {{ chosen.map((item) => item.title).join(', ') }}. Removed files cannot be brought back.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction @click="run">Clean</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
