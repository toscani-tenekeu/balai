<script setup lang="ts">
import { FileIcon, FolderIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import { messageOf, post } from '@/lib/api'
import { bytes, percent } from '@/lib/format'
import type { DiskUsage, Overview } from '@/lib/types'

type Entry = DiskUsage['entries'][number]

const { data: overview, error, refresh: refreshOverview } = useResource<Overview>('/overview', 30_000)

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

const pending = ref<Entry | null>(null)
const deleting = ref('')

async function remove() {
  const entry = pending.value
  if (!entry) return
  pending.value = null
  deleting.value = entry.path
  try {
    if (entry.directory) await post('/files/delete-folder', { path: entry.path })
    else {
      const result = await post<{ failed: { message: string }[] }>('/files/delete', { paths: [entry.path] })
      if (result.failed.length) throw new Error(result.failed[0]!.message)
    }
    toast.success(`Deleted ${entry.name}, ${bytes(entry.size)} freed.`)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  deleting.value = ''
  loading.value = true
  void refresh()
  void refreshOverview()
}
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
      <CardDescription>Open a folder to see what takes room inside it. Large folders take a moment to measure.
        Folders and files the system needs cannot be deleted from here.</CardDescription>
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
            <TableHead class="w-10"><span class="sr-only">Actions</span></TableHead>
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
            <TableCell>
              <Spinner v-if="deleting === entry.path" class="mx-auto" />
              <Button
                v-else-if="!entry.locked"
                variant="ghost"
                size="icon-sm"
                :disabled="!!deleting"
                :aria-label="`Delete ${entry.name}`"
                @click="pending = entry"
              >
                <Trash2Icon />
              </Button>
            </TableCell>
          </TableRow>
          <TableEmpty v-if="!usage.entries.length" :colspan="4">This folder is empty.</TableEmpty>
        </TableBody>
      </Table>
      <div v-else-if="!usageError" class="flex flex-col gap-2">
        <Skeleton v-for="index in 6" :key="index" class="h-9" />
      </div>
    </CardContent>
  </Card>

  <AlertDialog :open="!!pending" @update:open="(open: boolean) => { if (!open) pending = null }">
    <AlertDialogContent v-if="pending">
      <AlertDialogHeader>
        <AlertDialogTitle>Delete {{ pending.name }}?</AlertDialogTitle>
        <AlertDialogDescription>
          <template v-if="pending.directory">
            The folder and everything inside it, {{ bytes(pending.size) }} in all, is removed for good.
          </template>
          <template v-else>The file ({{ bytes(pending.size) }}) is removed for good.</template>
          There is no trash to restore it from, and a program that needs it will stop working.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <p class="bg-muted rounded-md border p-3 font-mono text-xs break-all">{{ pending.path }}</p>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button variant="destructive" @click="remove">Delete</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
