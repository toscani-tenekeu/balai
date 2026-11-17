<script setup lang="ts">
import { RefreshCwIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { messageOf, post } from '@/lib/api'
import { duration } from '@/lib/format'
import type { ActionResult, PackageState } from '@/lib/types'

const { data, error, refresh } = useResource<PackageState>('/packages')
const refreshing = ref(false)

const security = computed(() => data.value?.upgrades.filter((item) => item.security).length ?? 0)

async function refreshLists() {
  refreshing.value = true
  try {
    const result = await post<ActionResult>('/packages/refresh')
    toast.success(result.message)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  await refresh()
  refreshing.value = false
}
</script>

<template>
  <LoadError :message="error" />

  <Alert v-if="data?.rebootRequired">
    <TriangleAlertIcon />
    <AlertTitle>A restart is needed</AlertTitle>
    <AlertDescription>
      Some installed updates only take effect after the server restarts<template v-if="data.rebootPackages.length">:
        {{ data.rebootPackages.slice(0, 6).join(', ') }}</template>.
    </AlertDescription>
  </Alert>

  <Card>
    <CardHeader>
      <CardTitle>
        <template v-if="data">
          {{ data.upgrades.length }} {{ data.upgrades.length === 1 ? 'update' : 'updates' }} available
        </template>
        <template v-else>Updates</template>
      </CardTitle>
      <CardDescription>
        <template v-if="data">
          <template v-if="security">{{ security }} for security. </template>
          <template v-if="data.indexAge !== null">Package lists refreshed {{ duration(data.indexAge) }} ago. </template>
          Install them from a terminal with <code class="bg-muted rounded px-1 py-0.5 font-mono text-xs">sudo apt upgrade</code>.
        </template>
      </CardDescription>
      <CardAction>
        <Button variant="outline" size="sm" :disabled="refreshing" @click="refreshLists">
          <Spinner v-if="refreshing" data-icon="inline-start" />
          <RefreshCwIcon v-else data-icon="inline-start" />
          Refresh lists
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent>
      <template v-if="data">
        <Table v-if="data.upgrades.length">
          <TableHeader>
            <TableRow>
              <TableHead>Package</TableHead>
              <TableHead>Installed</TableHead>
              <TableHead>Available</TableHead>
              <TableHead class="text-right">Type</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="item in data.upgrades" :key="item.name">
              <TableCell class="font-medium">{{ item.name }}</TableCell>
              <TableCell class="text-muted-foreground max-w-48 truncate font-mono text-xs">{{ item.current }}</TableCell>
              <TableCell class="max-w-48 truncate font-mono text-xs">{{ item.next }}</TableCell>
              <TableCell class="text-right">
                <StatusBadge :tone="item.security ? 'bad' : 'idle'">{{ item.security ? 'Security' : 'Regular' }}</StatusBadge>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <Empty v-else>
          <EmptyHeader>
            <EmptyTitle>Everything is up to date</EmptyTitle>
            <EmptyDescription>Refresh the lists to check the software sources again.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </template>
      <div v-else class="flex flex-col gap-2">
        <Skeleton v-for="index in 5" :key="index" class="h-9" />
      </div>
    </CardContent>
  </Card>
</template>
