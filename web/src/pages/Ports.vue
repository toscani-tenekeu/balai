<script setup lang="ts">
import LoadError from '@/components/LoadError.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import type { Listener } from '@/lib/types'

const { data, error } = useResource<Listener[]>('/ports', 15_000)
</script>

<template>
  <LoadError :message="error" />

  <Card>
    <CardHeader>
      <CardTitle>Listening ports</CardTitle>
      <CardDescription>
        Programs waiting for connections. “Reachable” means the port accepts connections from other machines unless a firewall blocks it.
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
            <TableHead class="text-right">Exposure</TableHead>
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
            </TableCell>
            <TableCell class="text-right">
              <StatusBadge :tone="item.public ? 'good' : 'idle'">{{ item.public ? 'Reachable' : 'Local only' }}</StatusBadge>
            </TableCell>
          </TableRow>
          <TableEmpty v-if="!data.length" :colspan="5">Nothing is listening.</TableEmpty>
        </TableBody>
      </Table>
      <div v-else class="flex flex-col gap-2">
        <Skeleton v-for="index in 6" :key="index" class="h-9" />
      </div>
    </CardContent>
  </Card>
</template>
