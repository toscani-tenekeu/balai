<script setup lang="ts">
import { FileIcon, FolderIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import LoadError from '@/components/LoadError.vue'
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { bytes, percent } from '@/lib/format'
import type { DiskUsage, Overview } from '@/lib/types'

const { data: overview, error } = useResource<Overview>('/overview', 30_000)

const path = ref('/var')
const { data: usage, error: usageError, loading, refresh } = useResource<DiskUsage>(
  () => `/disk?path=${encodeURIComponent(path.value)}`,
)

function open(target: string) {
  path.value = target
}

watch(path, () => {
  loading.value = true
  void refresh()
})

const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean)
  return parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join('/')}` }))
})
const largest = computed(() => usage.value?.entries[0]?.size || 1)
</script>

<template>
  <LoadError :message="error" />

  <div class="grid gap-4 md:grid-cols-2">
    <template v-if="overview">
      <Card v-for="fs in overview.filesystems" :key="fs.mount">
        <CardHeader>
          <CardDescription class="truncate font-mono text-xs">{{ fs.source }} · {{ fs.type }}</CardDescription>
          <CardTitle>{{ fs.mount }}</CardTitle>
        </CardHeader>
        <CardContent class="flex flex-col gap-2">
          <Progress :model-value="fs.percent" />
          <div class="text-muted-foreground flex justify-between text-xs">
            <span>{{ bytes(fs.used) }} used ({{ percent(fs.percent) }})</span>
            <span>{{ bytes(fs.available) }} free of {{ bytes(fs.size) }}</span>
          </div>
        </CardContent>
      </Card>
    </template>
    <Skeleton v-else class="h-32" />
  </div>

  <Card>
    <CardHeader>
      <CardTitle>Where the space goes</CardTitle>
      <CardDescription>Open a folder to see what takes room inside it. Large folders take a moment to measure.</CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-3">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage v-if="!crumbs.length">/</BreadcrumbPage>
              <BreadcrumbLink v-else as-child>
                <button type="button" @click="open('/')">/</button>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <template v-for="(crumb, index) in crumbs" :key="crumb.path">
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage v-if="index === crumbs.length - 1">{{ crumb.name }}</BreadcrumbPage>
                <BreadcrumbLink v-else as-child>
                  <button type="button" @click="open(crumb.path)">{{ crumb.name }}</button>
                </BreadcrumbLink>
              </BreadcrumbItem>
            </template>
          </BreadcrumbList>
        </Breadcrumb>
        <Spinner v-if="loading" />
        <span v-else-if="usage" class="text-muted-foreground text-sm">{{ bytes(usage.total) }}</span>
        <div class="ml-auto flex gap-1">
          <Button v-for="shortcut in ['/', '/var', '/home', '/usr', '/opt']" :key="shortcut" variant="outline" size="sm" @click="open(shortcut)">
            {{ shortcut }}
          </Button>
        </div>
      </div>

      <LoadError :message="usageError" />

      <Table v-if="usage && !usageError">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead class="w-1/3">Share</TableHead>
            <TableHead class="text-right">Size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody :class="loading ? 'opacity-50' : ''">
          <TableRow v-for="entry in usage.entries" :key="entry.path">
            <TableCell class="max-w-80">
              <Button v-if="entry.directory" variant="link" class="h-auto max-w-full justify-start p-0" @click="open(entry.path)">
                <FolderIcon data-icon="inline-start" />
                <span class="truncate">{{ entry.name }}</span>
              </Button>
              <span v-else class="flex items-center gap-1.5">
                <FileIcon class="text-muted-foreground size-4 shrink-0" />
                <span class="truncate">{{ entry.name }}</span>
              </span>
            </TableCell>
            <TableCell><Progress :model-value="(entry.size / largest) * 100" /></TableCell>
            <TableCell class="text-right tabular-nums">{{ bytes(entry.size) }}</TableCell>
          </TableRow>
          <TableEmpty v-if="!usage.entries.length" :colspan="3">This folder is empty.</TableEmpty>
        </TableBody>
      </Table>
      <div v-else-if="!usageError" class="flex flex-col gap-2">
        <Skeleton v-for="index in 6" :key="index" class="h-9" />
      </div>
    </CardContent>
  </Card>
</template>
