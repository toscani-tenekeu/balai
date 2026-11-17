<script setup lang="ts">
import { EllipsisIcon, SearchIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResource } from '@/composables/useResource'
import { api, messageOf, post } from '@/lib/api'
import type { ActionResult, ServiceInfo } from '@/lib/types'

type Action = 'start' | 'stop' | 'restart' | 'enable' | 'disable' | 'reset'

const { data, error, refresh } = useResource<ServiceInfo[]>('/services', 10_000)
const search = ref('')
const filter = ref('all')
const busy = ref('')
const pending = ref<{ service: ServiceInfo; action: Action } | null>(null)
const logs = ref<{ name: string; lines: string[] | null } | null>(null)

const counts = computed(() => ({
  running: data.value?.filter((item) => item.active === 'active').length ?? 0,
  failed: data.value?.filter((item) => item.active === 'failed').length ?? 0,
}))

const visible = computed(() => {
  const term = search.value.trim().toLowerCase()
  return (data.value ?? []).filter((item) => {
    if (filter.value === 'running' && item.active !== 'active') return false
    if (filter.value === 'failed' && item.active !== 'failed') return false
    if (filter.value === 'stopped' && item.active !== 'inactive') return false
    return !term || item.name.toLowerCase().includes(term) || item.description.toLowerCase().includes(term)
  })
})

const short = (name: string) => name.replace(/\.service$/, '')
const canToggleBoot = (item: ServiceInfo) => ['enabled', 'disabled'].includes(item.enabled)

const CONFIRM: Partial<Record<Action, { verb: string; text: string }>> = {
  stop: { verb: 'Stop', text: 'The service stops now. Anything that depends on it stops working until it is started again.' },
  restart: { verb: 'Restart', text: 'The service goes down for a moment and comes back. Open connections are dropped.' },
  disable: { verb: 'Disable', text: 'The service will no longer start when the server boots. It keeps running for now.' },
}

function ask(service: ServiceInfo, action: Action) {
  if (CONFIRM[action]) pending.value = { service, action }
  else void act(service, action)
}

async function act(service: ServiceInfo, action: Action) {
  pending.value = null
  busy.value = service.name
  try {
    const result = await post<ActionResult>(`/services/${encodeURIComponent(service.name)}/${action}`)
    toast.success(result.message)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  await refresh()
  busy.value = ''
}

async function showLogs(service: ServiceInfo) {
  logs.value = { name: service.name, lines: null }
  try {
    const result = await api<{ lines: string[] }>(`/services/${encodeURIComponent(service.name)}/logs`)
    if (logs.value?.name === service.name) logs.value = { name: service.name, lines: result.lines }
  } catch (failure) {
    logs.value = null
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <LoadError :message="error" />

  <div class="flex flex-wrap items-center gap-2">
    <div class="relative w-full max-w-sm">
      <SearchIcon class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
      <Input v-model="search" class="pl-8" placeholder="Filter services" aria-label="Filter services" />
    </div>
    <Tabs v-model="filter">
      <TabsList>
        <TabsTrigger value="all">All</TabsTrigger>
        <TabsTrigger value="running">Running {{ counts.running }}</TabsTrigger>
        <TabsTrigger value="failed">Failed {{ counts.failed }}</TabsTrigger>
        <TabsTrigger value="stopped">Stopped</TabsTrigger>
      </TabsList>
    </Tabs>
  </div>

  <Card class="py-0">
    <CardContent class="px-0">
      <Table v-if="data">
        <TableHeader>
          <TableRow>
            <TableHead class="pl-4">Service</TableHead>
            <TableHead>State</TableHead>
            <TableHead>At boot</TableHead>
            <TableHead class="w-10 pr-4"><span class="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="item in visible" :key="item.name">
            <TableCell class="max-w-96 pl-4">
              <p class="truncate font-medium">{{ short(item.name) }}</p>
              <p class="text-muted-foreground truncate text-xs">{{ item.description }}</p>
            </TableCell>
            <TableCell>
              <StatusBadge :tone="item.active === 'failed' ? 'bad' : item.active === 'active' ? 'good' : 'idle'">
                {{ item.active === 'active' ? item.sub : item.active === 'inactive' ? 'stopped' : item.active }}
              </StatusBadge>
            </TableCell>
            <TableCell class="text-muted-foreground">{{ item.enabled }}</TableCell>
            <TableCell class="pr-4">
              <Spinner v-if="busy === item.name" class="mx-auto" />
              <DropdownMenu v-else>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon-sm" :aria-label="`Actions for ${short(item.name)}`">
                    <EllipsisIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem @select="showLogs(item)">View logs</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem v-if="item.active !== 'active'" @select="ask(item, 'start')">Start</DropdownMenuItem>
                  <DropdownMenuItem v-if="item.active === 'active'" @select="ask(item, 'restart')">Restart</DropdownMenuItem>
                  <DropdownMenuItem v-if="item.active === 'active'" @select="ask(item, 'stop')">Stop</DropdownMenuItem>
                  <DropdownMenuItem v-if="item.active === 'failed'" @select="ask(item, 'reset')">Clear failed state</DropdownMenuItem>
                  <template v-if="canToggleBoot(item)">
                    <DropdownMenuSeparator />
                    <DropdownMenuItem v-if="item.enabled === 'disabled'" @select="ask(item, 'enable')">Enable at boot</DropdownMenuItem>
                    <DropdownMenuItem v-else @select="ask(item, 'disable')">Disable at boot</DropdownMenuItem>
                  </template>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
          <TableEmpty v-if="!visible.length" :colspan="4">No service matches.</TableEmpty>
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
        <AlertDialogTitle>{{ CONFIRM[pending.action]?.verb }} {{ short(pending.service.name) }}?</AlertDialogTitle>
        <AlertDialogDescription>{{ CONFIRM[pending.action]?.text }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction @click="act(pending.service, pending.action)">{{ CONFIRM[pending.action]?.verb }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <Dialog :open="!!logs" @update:open="(open: boolean) => { if (!open) logs = null }">
    <DialogContent v-if="logs" class="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{{ short(logs.name) }}</DialogTitle>
        <DialogDescription>The last 200 journal lines, newest at the bottom.</DialogDescription>
      </DialogHeader>
      <div v-if="!logs.lines" class="flex justify-center py-10"><Spinner /></div>
      <p v-else-if="!logs.lines.length" class="text-muted-foreground py-6 text-center text-sm">
        This service has not written anything to the journal.
      </p>
      <ScrollArea v-else class="bg-muted h-96 rounded-md border">
        <pre class="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{{ logs.lines.join('\n') }}</pre>
      </ScrollArea>
    </DialogContent>
  </Dialog>
</template>
