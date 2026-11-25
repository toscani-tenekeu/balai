<script setup lang="ts">
import { CircleCheckIcon, CircleXIcon, ListChecksIcon, XIcon } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import TaskDetails from '@/components/tasks/TaskDetails.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { cancel, clearFinished, jobs, running, startPolling } from '@/composables/useJobs'
import { useNow } from '@/composables/useNow'
import { amountOf, durationOf, progressOf } from '@/lib/tasks'
import type { Job } from '@/lib/types'

onMounted(startPolling)

const now = useNow()
const menu = ref(false)
const details = ref(false)
const chosen = ref<string | null>(null)
const finished = computed(() => jobs.value.some((job) => job.state !== 'running'))

function show(job: Job) {
  chosen.value = job.id
  menu.value = false
  details.value = true
}

function summary(job: Job) {
  if (job.state !== 'running') return job.message ?? ''
  return [amountOf(job), job.now].filter(Boolean).join(' · ')
}
</script>

<template>
  <Popover v-model:open="menu">
    <PopoverTrigger as-child>
      <Button variant="ghost" size="sm" aria-label="Tasks">
        <Spinner v-if="running.length" />
        <ListChecksIcon v-else />
        <span class="hidden sm:inline">Tasks</span>
        <Badge v-if="running.length" variant="secondary" class="tabular-nums">{{ running.length }}</Badge>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-96 max-w-[calc(100vw-2rem)] gap-0 p-0">
      <div class="flex items-center justify-between border-b px-4 py-3">
        <p class="text-sm font-medium">Tasks</p>
        <Button v-if="finished" variant="ghost" size="xs" @click="clearFinished">Clear finished</Button>
      </div>
      <ul v-if="jobs.length" class="max-h-96 divide-y overflow-y-auto">
        <li v-for="job in jobs" :key="job.id">
          <div class="hover:bg-muted/50 flex flex-col gap-1.5 px-4 py-3">
            <div class="flex items-center gap-2">
              <Spinner v-if="job.state === 'running'" class="size-3.5 shrink-0" />
              <CircleCheckIcon v-else-if="job.state === 'done'" class="text-muted-foreground size-3.5 shrink-0" />
              <CircleXIcon v-else class="text-destructive size-3.5 shrink-0" />
              <button type="button" class="min-w-0 flex-1 truncate text-left text-sm" :title="job.title" @click="show(job)">
                {{ job.title }}
              </button>
              <span class="text-muted-foreground shrink-0 text-xs tabular-nums">{{ durationOf(job, now) }}</span>
              <Button
                v-if="job.state === 'running' && job.cancellable"
                variant="ghost"
                size="icon-xs"
                :aria-label="`Cancel ${job.title}`"
                @click="cancel(job)"
              >
                <XIcon />
              </Button>
            </div>
            <Progress v-if="job.state === 'running' && progressOf(job) !== null" :model-value="progressOf(job)!" />
            <div class="flex items-center gap-2">
              <p class="text-muted-foreground min-w-0 flex-1 truncate text-xs" :title="summary(job)">{{ summary(job) }}</p>
              <Button variant="link" size="xs" class="h-auto shrink-0 p-0" @click="show(job)">Details</Button>
            </div>
          </div>
        </li>
      </ul>
      <Empty v-else class="py-8">
        <EmptyHeader>
          <EmptyTitle>Nothing running</EmptyTitle>
          <EmptyDescription>Searches, cleanups, deletions and package work show their progress here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </PopoverContent>
  </Popover>
  <TaskDetails v-if="chosen" :id="chosen" :key="chosen" v-model:open="details" />
</template>
