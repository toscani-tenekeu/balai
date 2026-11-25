<script setup lang="ts">
import { ClockIcon, DownloadIcon, HardDriveIcon, RotateCcwIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { bytes, elapsed, signedBytes } from '@/lib/format'
import type { UpdatePlan } from '@/lib/types'

defineProps<{ plan: UpdatePlan | null; error?: string; compact?: boolean }>()

const used = (disk: UpdatePlan['disks'][number], free: number) => (disk.size ? ((disk.size - free) / disk.size) * 100 : 0)
</script>

<template>
  <div v-if="plan" class="flex flex-col gap-4">
    <dl v-if="compact" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      <dt class="text-muted-foreground flex items-center gap-2"><DownloadIcon class="size-4" />To download</dt>
      <dd class="font-medium tabular-nums">
        {{ bytes(plan.download) }}<span v-if="plan.cachedBytes" class="text-muted-foreground font-normal">, {{ bytes(plan.cachedBytes) }} already downloaded</span>
      </dd>
      <dt class="text-muted-foreground flex items-center gap-2"><HardDriveIcon class="size-4" />Space once installed</dt>
      <dd class="font-medium tabular-nums">{{ signedBytes(plan.change) }}</dd>
      <dt class="text-muted-foreground flex items-center gap-2"><ClockIcon class="size-4" />Time it may take</dt>
      <dd class="font-medium tabular-nums">
        about {{ elapsed(plan.seconds * 1000) }}
        <span class="text-muted-foreground font-normal">{{ plan.learnedFrom ? `(from ${plan.learnedFrom} earlier ${plan.learnedFrom === 1 ? 'update' : 'updates'})` : '(first guess)' }}</span>
      </dd>
    </dl>
    <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div class="flex items-start gap-3 rounded-lg border p-3">
        <DownloadIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div class="min-w-0">
          <p class="text-muted-foreground text-xs">To download</p>
          <p class="text-lg font-semibold tabular-nums">{{ bytes(plan.download) }}</p>
          <p v-if="plan.cachedBytes" class="text-muted-foreground text-xs">{{ bytes(plan.cachedBytes) }} already downloaded</p>
        </div>
      </div>
      <div class="flex items-start gap-3 rounded-lg border p-3">
        <HardDriveIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div class="min-w-0">
          <p class="text-muted-foreground text-xs">Space used once installed</p>
          <p class="text-lg font-semibold tabular-nums">{{ signedBytes(plan.change) }}</p>
          <p class="text-muted-foreground text-xs">compared with the versions installed now</p>
        </div>
      </div>
      <div class="flex items-start gap-3 rounded-lg border p-3">
        <ClockIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div class="min-w-0">
          <p class="text-muted-foreground text-xs">Time it may take</p>
          <p class="text-lg font-semibold tabular-nums">about {{ elapsed(plan.seconds * 1000) }}</p>
          <p class="text-muted-foreground text-xs">
            {{ plan.learnedFrom ? `based on ${plan.learnedFrom} earlier ${plan.learnedFrom === 1 ? 'update' : 'updates'} here` : 'a first guess; it improves after each update' }}
          </p>
        </div>
      </div>
    </div>

    <div v-for="disk in plan.disks" :key="disk.mount" class="flex flex-col gap-1.5">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
        <p>
          Disk <span class="font-mono">{{ disk.mount }}</span>
          <span class="text-muted-foreground"> ({{ disk.uses.join(' and ') }})</span>
        </p>
        <p class="tabular-nums">
          {{ bytes(disk.free) }} free now → <span class="font-medium">{{ bytes(Math.max(0, disk.after)) }}</span> after
          <span v-if="disk.during < disk.after" class="text-muted-foreground">, {{ bytes(Math.max(0, disk.during)) }} at the lowest</span>
        </p>
      </div>
      <Progress :model-value="used(disk, Math.max(0, disk.during))" />
    </div>

    <Alert v-for="warning in plan.warnings" :key="warning" variant="destructive">
      <TriangleAlertIcon />
      <AlertDescription>{{ warning }}</AlertDescription>
    </Alert>

    <Alert v-if="plan.restart.length">
      <RotateCcwIcon />
      <AlertTitle>A restart of the server will probably be needed</AlertTitle>
      <AlertDescription>
        {{ plan.restart.slice(0, 6).join(', ') }}{{ plan.restart.length > 6 ? ` and ${plan.restart.length - 6} more` : '' }}
        only fully take effect after a restart.
      </AlertDescription>
    </Alert>

    <Alert v-if="plan.keptBack.length">
      <TriangleAlertIcon />
      <AlertTitle>{{ plan.keptBack.length }} {{ plan.keptBack.length === 1 ? 'update is' : 'updates are' }} held back</AlertTitle>
      <AlertDescription>
        {{ plan.keptBack.join(', ') }}: installing {{ plan.keptBack.length === 1 ? 'it' : 'them' }} would add or remove other
        packages, so the package manager leaves {{ plan.keptBack.length === 1 ? 'it' : 'them' }} out of a normal update.
        Update {{ plan.keptBack.length === 1 ? 'it' : 'each one' }} on its own from the list to see what changes.
      </AlertDescription>
    </Alert>
  </div>
  <p v-else-if="error" class="text-muted-foreground text-sm">Sizes could not be worked out: {{ error }}</p>
  <div v-else class="grid gap-3 sm:grid-cols-3">
    <Skeleton v-for="index in 3" :key="index" class="h-20" />
  </div>
</template>
