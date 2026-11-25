<script setup lang="ts">
import { CircleCheckIcon, CircleDashedIcon, CircleMinusIcon, CircleXIcon, LockIcon } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { cancel, jobs } from '@/composables/useJobs'
import { useNow } from '@/composables/useNow'
import { dateTime, elapsed } from '@/lib/format'
import { amountOf, durationOf, progressOf, remainingOf, stateLabel } from '@/lib/tasks'

const props = defineProps<{ id: string | null }>()
const open = defineModel<boolean>('open', { default: false })

const live = computed(() => jobs.value.find((job) => job.id === props.id) ?? null)
const now = useNow()
const log = ref<HTMLElement | null>(null)

const tone = computed(() => {
  const state = live.value?.state
  return state === 'done' ? 'good' : state === 'failed' ? 'bad' : state === 'running' ? 'warn' : 'idle'
})

// Keep the newest output in view while the task runs.
watch(
  () => live.value?.output.length,
  async () => {
    await nextTick()
    if (log.value) log.value.scrollTop = log.value.scrollHeight
  },
)

const stepTime = (started?: number, finished?: number) => (started ? elapsed((finished ?? now.value) - started) : '')
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent v-if="live" class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle class="pr-6 break-words">{{ live.title }}</DialogTitle>
        <DialogDescription class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge :tone="tone">{{ stateLabel[live.state] }}</StatusBadge>
          <span>Started {{ dateTime(live.startedAt) }}</span>
          <span>{{ live.state === 'running' ? 'Running for' : 'Took' }} {{ durationOf(live, now) }}</span>
        </DialogDescription>
      </DialogHeader>

      <div class="flex min-w-0 flex-col gap-4">
        <div v-if="live.state === 'running'" class="flex flex-col gap-2">
          <Progress v-if="progressOf(live) !== null" :model-value="progressOf(live)!" />
          <p class="text-muted-foreground flex flex-wrap gap-x-3 text-sm">
            <span v-if="amountOf(live)" class="tabular-nums">{{ amountOf(live) }}</span>
            <span v-if="remainingOf(live, now)">{{ remainingOf(live, now) }}</span>
          </p>
          <p v-if="live.now" class="truncate font-mono text-xs" :title="live.now">{{ live.now }}</p>
        </div>
        <p v-else-if="live.message" class="text-sm break-words">{{ live.message }}</p>

        <Alert v-if="live.state === 'running' && !live.cancellable && live.keep">
          <LockIcon />
          <AlertDescription>{{ live.keep }}</AlertDescription>
        </Alert>

        <ol v-if="live.steps.length" class="flex flex-col gap-2">
          <li v-for="item in live.steps" :key="item.title" class="flex items-start gap-2 text-sm">
            <Spinner v-if="item.state === 'running'" class="mt-0.5 size-4 shrink-0" />
            <CircleCheckIcon v-else-if="item.state === 'done'" class="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <CircleXIcon v-else-if="item.state === 'failed'" class="text-destructive mt-0.5 size-4 shrink-0" />
            <CircleMinusIcon v-else-if="item.state === 'skipped'" class="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <CircleDashedIcon v-else class="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <p :class="item.state === 'waiting' || item.state === 'skipped' ? 'text-muted-foreground' : ''">
                {{ item.title }}<span v-if="item.state === 'skipped'"> (not run)</span>
              </p>
              <p v-if="item.detail" class="text-muted-foreground text-xs break-words">{{ item.detail }}</p>
            </div>
            <span class="text-muted-foreground shrink-0 text-xs tabular-nums">{{ stepTime(item.startedAt, item.finishedAt) }}</span>
          </li>
        </ol>

        <div v-if="live.errors.length" class="flex flex-col gap-1">
          <p class="text-sm font-medium">Problems</p>
          <ul class="text-destructive bg-muted max-h-32 overflow-y-auto rounded-md border p-3 text-xs">
            <li v-for="problem in live.errors" :key="problem" class="break-all">{{ problem }}</li>
          </ul>
        </div>

        <div v-if="live.output.length" class="flex min-w-0 flex-col gap-1">
          <p class="text-sm font-medium">Output</p>
          <pre ref="log" class="bg-muted max-h-64 overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{{ live.output.join('\n') }}</pre>
        </div>
      </div>

      <DialogFooter>
        <Button v-if="live.link" variant="outline" as-child @click="open = false">
          <RouterLink :to="live.link">Open page</RouterLink>
        </Button>
        <Button v-if="live.state === 'running' && live.cancellable" variant="destructive" @click="cancel(live)">
          Cancel task
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
