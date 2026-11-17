<script setup lang="ts">
import { CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import LoadError from '@/components/LoadError.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import UsageChart from '@/components/UsageChart.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResource } from '@/composables/useResource'
import { bytes, duration, percent } from '@/lib/format'
import type { Health, Overview, Sample } from '@/lib/types'

const { data: overview, error } = useResource<Overview>('/overview', 5000)
const { data: health } = useResource<Health>('/health', 30_000)

const range = ref('24')
const { data: samples, refresh: reloadSamples } = useResource<Sample[]>(() => `/history?hours=${range.value}`, 60_000)
watch(range, reloadSamples)

const root = computed(() => overview.value?.filesystems.find((fs) => fs.mount === '/') ?? overview.value?.filesystems[0])
const problems = computed(() => health.value?.checks.filter((check) => check.status !== 'ok').length ?? 0)

const summary = computed(() => {
  if (!health.value) return ''
  if (health.value.status === 'ok') return 'Everything looks fine.'
  return problems.value === 1 ? '1 thing needs attention.' : `${problems.value} things need attention.`
})
</script>

<template>
  <LoadError :message="error" />

  <div v-if="overview" class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <h2 class="text-xl font-semibold tracking-tight">{{ overview.host.name }}</h2>
    <p class="text-muted-foreground text-sm">
      {{ overview.host.os }} · Linux {{ overview.host.kernel }} · up {{ duration(overview.host.uptime) }}
    </p>
  </div>
  <Skeleton v-else class="h-7 w-72" />

  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <template v-if="overview">
      <Card>
        <CardHeader>
          <CardDescription>CPU</CardDescription>
          <CardTitle class="text-2xl tabular-nums">{{ percent(overview.cpu.percent) }}</CardTitle>
        </CardHeader>
        <CardContent class="flex flex-col gap-2">
          <Progress :model-value="overview.cpu.percent" />
          <p class="text-muted-foreground text-xs">
            Load {{ overview.cpu.load.map((value) => value.toFixed(2)).join(' · ') }} on {{ overview.cpu.cores }} cores
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Memory</CardDescription>
          <CardTitle class="text-2xl tabular-nums">{{ percent(overview.memory.percent) }}</CardTitle>
        </CardHeader>
        <CardContent class="flex flex-col gap-2">
          <Progress :model-value="overview.memory.percent" />
          <p class="text-muted-foreground text-xs">
            {{ bytes(overview.memory.used) }} of {{ bytes(overview.memory.total) }} used
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Swap</CardDescription>
          <CardTitle class="text-2xl tabular-nums">
            {{ overview.memory.swapTotal ? percent(overview.memory.swapPercent) : 'Off' }}
          </CardTitle>
        </CardHeader>
        <CardContent class="flex flex-col gap-2">
          <Progress :model-value="overview.memory.swapPercent" />
          <p class="text-muted-foreground text-xs">
            <template v-if="overview.memory.swapTotal">
              {{ bytes(overview.memory.swapUsed) }} of {{ bytes(overview.memory.swapTotal) }} used
            </template>
            <template v-else>No swap space configured</template>
          </p>
        </CardContent>
      </Card>
      <Card v-if="root">
        <CardHeader>
          <CardDescription>Disk {{ root.mount }}</CardDescription>
          <CardTitle class="text-2xl tabular-nums">{{ percent(root.percent) }}</CardTitle>
        </CardHeader>
        <CardContent class="flex flex-col gap-2">
          <Progress :model-value="root.percent" />
          <p class="text-muted-foreground text-xs">{{ bytes(root.available) }} free of {{ bytes(root.size) }}</p>
        </CardContent>
      </Card>
    </template>
    <Skeleton v-for="index in 4" v-else :key="index" class="h-36" />
  </div>

  <div class="grid gap-4 lg:grid-cols-5">
    <Card class="lg:col-span-2">
      <CardHeader>
        <CardTitle>Health</CardTitle>
        <CardDescription>{{ summary || 'Checking the server…' }}</CardDescription>
        <CardAction v-if="health">
          <StatusBadge :tone="health.status === 'ok' ? 'good' : health.status === 'critical' ? 'bad' : 'warn'">
            {{ health.status === 'ok' ? 'Healthy' : health.status === 'critical' ? 'Problem' : 'Attention' }}
          </StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ul v-if="health" class="flex flex-col divide-y">
          <li v-for="check in health.checks" :key="check.id" class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <CircleXIcon v-if="check.status === 'critical'" class="text-destructive size-4 shrink-0" />
            <TriangleAlertIcon v-else-if="check.status === 'warning'" class="size-4 shrink-0" />
            <CircleCheckIcon v-else class="text-muted-foreground size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">{{ check.title }}</p>
              <p class="text-muted-foreground truncate text-xs" :title="check.detail">{{ check.detail }}</p>
            </div>
            <Button v-if="check.link && check.status !== 'ok'" variant="outline" size="sm" as-child>
              <RouterLink :to="check.link">Look</RouterLink>
            </Button>
          </li>
        </ul>
        <div v-else class="flex flex-col gap-3">
          <Skeleton v-for="index in 6" :key="index" class="h-9" />
        </div>
      </CardContent>
    </Card>

    <Card class="lg:col-span-3">
      <CardHeader>
        <CardTitle>Usage</CardTitle>
        <CardDescription>CPU and memory over time</CardDescription>
        <CardAction>
          <Tabs v-model="range">
            <TabsList>
              <TabsTrigger value="1">1 hour</TabsTrigger>
              <TabsTrigger value="24">24 hours</TabsTrigger>
              <TabsTrigger value="168">7 days</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent>
        <UsageChart v-if="samples && samples.length > 1" :samples="samples" :hours="Number(range)" />
        <Empty v-else>
          <EmptyHeader>
            <EmptyTitle>Not enough data yet</EmptyTitle>
            <EmptyDescription>A reading is saved every minute. The chart appears after the first few.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
    </Card>
  </div>
</template>
