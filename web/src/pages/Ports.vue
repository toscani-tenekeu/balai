<script setup lang="ts">
import { EllipsisIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { messageOf, post } from '@/lib/api'
import type { ActionResult, Listener } from '@/lib/types'

type Action = 'restart-service' | 'stop-service' | 'stop' | 'kill'

const { data, error, refresh } = useResource<Listener[]>('/ports', 15_000)
const pending = ref<{ listener: Listener; action: Action } | null>(null)

const unitName = (listener: Listener) => listener.unit?.replace(/\.service$/, '') ?? ''

const dialog = computed(() => {
  const target = pending.value
  if (!target) return null
  const { listener, action } = target
  const port = `Port ${listener.port} closes`
  const program = listener.process || `process ${listener.pid}`
  switch (action) {
    case 'restart-service':
      return {
        title: `Restart ${unitName(listener)}?`,
        text: `Port ${listener.port} closes for a moment and reopens. Open connections are dropped.`,
        verb: 'Restart',
        destructive: false,
      }
    case 'stop-service':
      return {
        title: `Stop ${unitName(listener)}?`,
        text: `${port} and everything that connects to it stops working until the service is started again.`,
        verb: 'Stop service',
        destructive: true,
      }
    case 'stop':
      return {
        title: `Stop ${program}?`,
        text: `${port} once the program has shut down cleanly.${listener.unit ? ' Its service may start it again.' : ''}`,
        verb: 'Stop',
        destructive: false,
      }
    default:
      return {
        title: `Force stop ${program}?`,
        text: `${port} at once. The program is ended without a chance to finish what it was doing.`,
        verb: 'Force stop',
        destructive: true,
      }
  }
})

const remoteAccess = computed(() => {
  const listener = pending.value?.listener
  return !!listener && pending.value?.action !== 'restart-service' && /^sshd?$/.test(listener.process)
})

async function confirm() {
  const target = pending.value
  if (!target) return
  pending.value = null
  const { listener, action } = target
  const path =
    action === 'restart-service' ? `/services/${encodeURIComponent(listener.unit!)}/restart`
    : action === 'stop-service' ? `/services/${encodeURIComponent(listener.unit!)}/stop`
    : `/processes/${listener.pid}/${action}`
  try {
    const result = await post<ActionResult>(path)
    toast.success(result.message)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  setTimeout(() => void refresh(), 800)
}
</script>

<template>
  <LoadError :message="error" />

  <Card>
    <CardHeader>
      <CardTitle>Listening ports</CardTitle>
      <CardDescription>
        Programs waiting for connections. “Reachable” means the port accepts connections from other machines unless a
        firewall blocks it. To close a port, stop the program or the service that holds it.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Table v-if="data">
        <TableHeader>
          <TableRow>
            <TableHead>Port</TableHead>
            <TableHead>Protocol</TableHead>
            <TableHead>Address</TableHead>
            <TableHead>Program</TableHead>
            <TableHead>Exposure</TableHead>
            <TableHead class="w-10"><span class="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="item in data" :key="`${item.protocol}-${item.address}-${item.port}`">
            <TableCell class="font-medium tabular-nums">{{ item.port }}</TableCell>
            <TableCell class="text-muted-foreground">{{ item.protocol }}</TableCell>
            <TableCell class="font-mono text-xs">{{ item.address }}</TableCell>
            <TableCell>
              {{ item.process || 'Unknown' }}
              <span v-if="item.pid" class="text-muted-foreground text-xs">({{ item.pid }})</span>
              <p v-if="item.unit" class="text-muted-foreground text-xs">{{ unitName(item) }} service</p>
            </TableCell>
            <TableCell>
              <StatusBadge :tone="item.public ? 'good' : 'idle'">{{ item.public ? 'Reachable' : 'Local only' }}</StatusBadge>
            </TableCell>
            <TableCell>
              <DropdownMenu v-if="item.pid">
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon-sm" :aria-label="`Actions for port ${item.port}`">
                    <EllipsisIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <template v-if="item.unit">
                    <DropdownMenuItem @select="pending = { listener: item, action: 'restart-service' }">
                      Restart service
                    </DropdownMenuItem>
                    <DropdownMenuItem @select="pending = { listener: item, action: 'stop-service' }">
                      Stop service
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </template>
                  <DropdownMenuItem @select="pending = { listener: item, action: 'stop' }">Stop program</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" @select="pending = { listener: item, action: 'kill' }">
                    Force stop program
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
          <TableEmpty v-if="!data.length" :colspan="6">Nothing is listening.</TableEmpty>
        </TableBody>
      </Table>
      <div v-else class="flex flex-col gap-2">
        <Skeleton v-for="index in 6" :key="index" class="h-9" />
      </div>
    </CardContent>
  </Card>

  <AlertDialog :open="!!pending" @update:open="(open: boolean) => { if (!open) pending = null }">
    <AlertDialogContent v-if="dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ dialog.title }}</AlertDialogTitle>
        <AlertDialogDescription>
          {{ dialog.text }}
          <template v-if="remoteAccess">
            This is the SSH server: without it you may be locked out of the server.
          </template>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction :variant="dialog.destructive ? 'destructive' : 'default'" @click="confirm">
          {{ dialog.verb }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
