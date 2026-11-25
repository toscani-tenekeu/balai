<script setup lang="ts">
import HintBadge from '@/components/HintBadge.vue'
import SortHead from '@/components/SortHead.vue'
import { useSorting } from '@/composables/useSorting'
import { SearchIcon, SquareIcon, ZapIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import RowAction from '@/components/RowAction.vue'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResource } from '@/composables/useResource'
import { messageOf, post } from '@/lib/api'
import { bytes, duration } from '@/lib/format'
import type { ActionResult, Hint, ProcessInfo } from '@/lib/types'

const { data, error, refresh } = useResource<ProcessInfo[]>('/processes', 5000)
const search = ref('')
const show = ref('all')
const { data: hints } = useResource<Record<string, Hint>>('/services/hints', 60_000)
const BY_HAND: Hint = {
  role: 'unused',
  label: 'Started by hand',
  detail: 'Started from a login session (SSH or console) rather than by a service. Nothing restarts it if it stops.',
}
/** What a process is for, from the service it belongs to. */
function hintOf(item: ProcessInfo): Hint | null {
  if (item.unit) return hints.value?.[item.unit] ?? { role: 'app', label: item.unit.replace(/\.service$/, ''), detail: `Part of the service ${item.unit}.` }
  return item.session ? BY_HAND : null
}
const pending = ref<{ process: ProcessInfo; action: 'stop' | 'kill' } | null>(null)

const filtered = computed(() => {
  const term = search.value.trim().toLowerCase()
  return (data.value ?? []).filter((item) => {
    if (show.value === 'unneeded' && hintOf(item)?.role !== 'unneeded') return false
    if (show.value === 'hand' && !item.session) return false
    return !term || item.command.toLowerCase().includes(term) || item.user.includes(term) || String(item.pid) === term
  })
})
const { sortBy, descending, sorted, toggle } = useSorting<ProcessInfo>(
  () => filtered.value,
  {
    name: (item) => item.name,
    pid: (item) => item.pid,
    user: (item) => item.user,
    cpu: (item) => item.cpu,
    memory: (item) => item.rss,
    elapsed: (item) => item.elapsed,
  },
  { by: 'cpu', descending: true },
)
const visible = computed(() => sorted.value.slice(0, 100))

async function confirm() {
  const target = pending.value
  if (!target) return
  pending.value = null
  try {
    const result = await post<ActionResult>(`/processes/${target.process.pid}/${target.action}`)
    toast.success(result.message)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  await refresh()
}
</script>

<template>
  <LoadError :message="error" />

  <div class="flex flex-wrap items-center gap-2">
    <div class="relative w-full max-w-sm">
      <SearchIcon class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
      <Input v-model="search" class="pl-8" placeholder="Filter by name, user or PID" aria-label="Filter processes" />
    </div>
    <Tabs v-model="show">
      <TabsList>
        <TabsTrigger value="all">All</TabsTrigger>
        <TabsTrigger value="unneeded">Not needed {{ (data ?? []).filter((item) => hintOf(item)?.role === 'unneeded').length }}</TabsTrigger>
        <TabsTrigger value="hand">Started by hand {{ (data ?? []).filter((item) => item.session).length }}</TabsTrigger>
      </TabsList>
    </Tabs>
    <p v-if="data" class="text-muted-foreground ml-auto text-sm">{{ data.length }} running</p>
  </div>

  <Card class="py-0">
    <CardContent class="px-0">
      <Table v-if="data">
        <TableHeader>
          <TableRow>
            <SortHead label="Process" column="name" class="pl-4" :sort-by="sortBy" :descending="descending" @sort="(column) => toggle(column, true)" />
            <TableHead>Purpose</TableHead>
            <SortHead label="PID" column="pid" :sort-by="sortBy" :descending="descending" @sort="toggle" />
            <SortHead label="User" column="user" :sort-by="sortBy" :descending="descending" @sort="(column) => toggle(column, true)" />
            <SortHead label="CPU" column="cpu" align="right" :sort-by="sortBy" :descending="descending" @sort="toggle" />
            <SortHead label="Memory" column="memory" align="right" :sort-by="sortBy" :descending="descending" @sort="toggle" />
            <SortHead label="Running" column="elapsed" align="right" :sort-by="sortBy" :descending="descending" @sort="toggle" />
            <TableHead class="w-20 pr-4 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="item in visible" :key="item.pid">
            <TableCell class="max-w-72 pl-4">
              <p class="truncate font-medium">{{ item.name }}</p>
              <p class="text-muted-foreground truncate font-mono text-xs" :title="item.command">{{ item.command }}</p>
            </TableCell>
            <TableCell>
              <HintBadge v-if="hintOf(item)" :hint="hintOf(item)!" />
            </TableCell>
            <TableCell class="tabular-nums">{{ item.pid }}</TableCell>
            <TableCell>{{ item.user }}</TableCell>
            <TableCell class="text-right tabular-nums">{{ item.cpu.toFixed(1) }}%</TableCell>
            <TableCell class="text-right tabular-nums">{{ bytes(item.rss) }}</TableCell>
            <TableCell class="text-right tabular-nums">{{ duration(item.elapsed) }}</TableCell>
            <TableCell class="pr-4">
              <div class="flex justify-end gap-0.5">
                <RowAction :label="`Stop ${item.name}`" @click="pending = { process: item, action: 'stop' }"><SquareIcon /></RowAction>
                <RowAction :label="`Force stop ${item.name}`" destructive @click="pending = { process: item, action: 'kill' }"><ZapIcon /></RowAction>
              </div>
            </TableCell>
          </TableRow>
          <TableEmpty v-if="!visible.length" :colspan="8">No process matches that filter.</TableEmpty>
        </TableBody>
      </Table>
      <div v-else class="flex flex-col gap-2 p-4">
        <Skeleton v-for="index in 8" :key="index" class="h-10" />
      </div>
    </CardContent>
  </Card>

  <AlertDialog :open="!!pending" @update:open="(open: boolean) => { if (!open) pending = null }">
    <AlertDialogContent v-if="pending">
      <AlertDialogHeader>
        <AlertDialogTitle>
          {{ pending.action === 'kill' ? 'Force stop' : 'Stop' }} {{ pending.process.name }}?
        </AlertDialogTitle>
        <AlertDialogDescription>
          <template v-if="pending.action === 'kill'">
            Process {{ pending.process.pid }} is ended immediately, without a chance to save its work.
          </template>
          <template v-else>
            Process {{ pending.process.pid }} is asked to shut down cleanly. If a service manages it, it may start again.
          </template>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button :variant="pending.action === 'kill' ? 'destructive' : 'default'" @click="confirm">
          {{ pending.action === 'kill' ? 'Force stop' : 'Stop' }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
