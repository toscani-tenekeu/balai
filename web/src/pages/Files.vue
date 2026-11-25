<script setup lang="ts">
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, Trash2Icon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import FileDetails from '@/components/files/FileDetails.vue'
import UseBadge from '@/components/files/UseBadge.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cancel, jobResult, jobs, startPolling, track } from '@/composables/useJobs'
import { useNow } from '@/composables/useNow'
import { messageOf, post } from '@/lib/api'
import { bytes, dateTime } from '@/lib/format'
import { durationOf, progressOf } from '@/lib/tasks'
import type { DeleteResult, FileSearch, FileUse, FoundFile, Started, Use } from '@/lib/types'

const PRESETS = [
  { label: 'Images', value: 'png, jpg, jpeg, webp, gif, svg' },
  { label: 'Archives', value: 'zip, tar, gz, tgz, bz2, xz, 7z, rar' },
  { label: 'Backups', value: 'bak, old, orig, sql, dump' },
  { label: 'Logs', value: 'log' },
  { label: 'Disk images', value: 'iso, img, qcow2' },
  { label: 'Videos', value: 'mp4, mkv, avi, mov, webm' },
]

const MB = 1024 ** 2
/** Where the last search is remembered, so coming back to the page shows it again. */
const MEMORY = 'balai.files.search'

const folder = ref('/')
const extensions = ref('')
const minimum = ref('0')
const customSize = ref('')
const age = ref('0')
const customAge = ref('')

const now = useNow()
const searchId = ref<string | null>(null)
const usageId = ref<string | null>(null)
const result = ref<FileSearch | null>(null)
const uses = ref<Record<string, FileUse>>({})
const failure = ref('')
const deleting = ref(false)
const confirming = ref(false)
const outcome = ref<DeleteResult | null>(null)
const selected = ref<Record<string, boolean>>({})

const searchJob = computed(() => jobs.value.find((job) => job.id === searchId.value) ?? null)
const usageJob = computed(() => jobs.value.find((job) => job.id === usageId.value) ?? null)
const searching = computed(() => searchJob.value?.state === 'running')
const checking = computed(() => usageJob.value?.state === 'running')

const minBytes = computed(() => {
  if (minimum.value !== 'custom') return Number(minimum.value) * MB
  const value = Number(String(customSize.value).replace(',', '.'))
  return Number.isFinite(value) && value > 0 ? Math.round(value * MB) : 0
})
const days = computed(() => (age.value === 'custom' ? Math.max(0, Math.floor(Number(customAge.value) || 0)) : Number(age.value)))
const canSearch = computed(() => extensions.value.trim() !== '' || minBytes.value > 0)

startPolling()

async function search() {
  if (!canSearch.value || searching.value) return
  failure.value = ''
  outcome.value = null
  try {
    const answer = await post<Started>('/files/search', {
      path: folder.value.trim() || '/',
      ext: extensions.value,
      min: minBytes.value,
      days: days.value,
    })
    searchId.value = answer.job.id
    sessionStorage.setItem(MEMORY, JSON.stringify({ search: answer.job.id, usage: null }))
    await follow(answer.job)
  } catch (error) {
    failure.value = messageOf(error)
  }
}

/** Waits for a search, shows its files, then checks where each one is used. */
async function follow(job: Started['job']) {
  const finished = await track(job, { quiet: true })
  if (finished.state === 'cancelled') return
  const answer = await jobResult<FileSearch>(finished.id)
  if (finished.state !== 'done' || !answer.result) {
    failure.value = finished.message ?? 'The search did not finish.'
    return
  }
  result.value = answer.result
  selected.value = {}
  uses.value = {}
  filter.value = 'all'
  if (answer.result.files.length) await checkUsage(answer.result.files.map((file) => file.path))
}

async function checkUsage(paths: string[]) {
  try {
    const answer = await post<Started>('/files/usage', { paths })
    usageId.value = answer.job.id
    sessionStorage.setItem(MEMORY, JSON.stringify({ search: searchId.value, usage: answer.job.id }))
    await showUsage(answer.job)
  } catch (error) {
    toast.error(messageOf(error))
  }
}

async function showUsage(job: Started['job']) {
  const finished = await track(job, { quiet: true })
  if (finished.state !== 'done') {
    if (finished.state === 'failed') toast.error(finished.message ?? 'The check did not finish.')
    return
  }
  const answer = await jobResult<FileUse[]>(finished.id)
  uses.value = Object.fromEntries((answer.result ?? []).map((item) => [item.path, item]))
}

// Coming back to the page shows the last search and its check, even if they are still running.
onMounted(async () => {
  const saved = sessionStorage.getItem(MEMORY)
  if (!saved) return
  try {
    const { search: lastSearch, usage } = JSON.parse(saved) as { search: string | null; usage: string | null }
    if (!lastSearch) return
    const answer = await jobResult<FileSearch>(lastSearch)
    searchId.value = lastSearch
    if (answer.job.state === 'running') return void follow(answer.job)
    if (!answer.result) return
    result.value = answer.result
    if (!usage) return
    const checked = await jobResult<FileUse[]>(usage)
    usageId.value = usage
    if (checked.job.state === 'running') return void showUsage(checked.job)
    uses.value = Object.fromEntries((checked.result ?? []).map((item) => [item.path, item]))
  } catch {
    // The tasks are gone after an hour or a restart; the page starts empty.
    sessionStorage.removeItem(MEMORY)
  }
})

// ---- Filtering and sorting ----------------------------------------------------------

const filter = ref<'all' | Use>('all')
const text = ref('')
const sortBy = ref<'size' | 'path' | 'modified'>('size')
const descending = ref(true)

const counts = computed(() => {
  const all = result.value?.files ?? []
  const of = (use: Use) => all.filter((file) => uses.value[file.path]?.use === use).length
  return { all: all.length, unused: of('unused'), maybe: of('maybe'), used: of('used') }
})

const visible = computed(() => {
  const needle = text.value.trim().toLowerCase()
  const list = (result.value?.files ?? []).filter((file) => {
    if (filter.value !== 'all' && uses.value[file.path]?.use !== filter.value) return false
    if (!needle) return true
    return file.path.toLowerCase().includes(needle) || uses.value[file.path]?.label.toLowerCase().includes(needle)
  })
  const direction = descending.value ? -1 : 1
  return [...list].sort((a, b) => {
    if (sortBy.value === 'path') return a.path.localeCompare(b.path) * direction
    return (a[sortBy.value] - b[sortBy.value]) * direction
  })
})

function sort(column: typeof sortBy.value) {
  if (sortBy.value === column) descending.value = !descending.value
  else {
    sortBy.value = column
    descending.value = column !== 'path'
  }
}

watch(filter, () => (selected.value = {}))

// ---- Selection and deletion ---------------------------------------------------------

const deletable = computed(() => visible.value.filter((file) => !file.locked))
const chosen = computed(() => (result.value?.files ?? []).filter((file) => !file.locked && selected.value[file.path]))
const chosenSize = computed(() => chosen.value.reduce((sum, file) => sum + file.size, 0))
const allChosen = computed(() => deletable.value.length > 0 && deletable.value.every((file) => selected.value[file.path]))
const risky = computed(() => chosen.value.filter((file) => uses.value[file.path] && uses.value[file.path]!.use !== 'unused'))

function toggleAll() {
  const next = !allChosen.value
  for (const file of deletable.value) selected.value[file.path] = next
}

async function remove(paths = chosen.value.map((file) => file.path)) {
  confirming.value = false
  details.value = false
  deleting.value = true
  try {
    outcome.value = await post<DeleteResult>('/files/delete', { paths })
    if (outcome.value.deleted) toast.success(`${outcome.value.deleted} deleted, ${bytes(outcome.value.freed)} freed.`)
    const gone = new Set(paths.filter((path) => !outcome.value?.failed.some((entry) => entry.path === path)))
    if (result.value) {
      const removed = result.value.files.filter((file) => gone.has(file.path))
      result.value = {
        ...result.value,
        files: result.value.files.filter((file) => !gone.has(file.path)),
        count: result.value.count - gone.size,
        total: Math.max(0, result.value.total - removed.reduce((sum, file) => sum + file.size, 0)),
      }
    }
    for (const path of gone) delete selected.value[path]
  } catch (error) {
    toast.error(messageOf(error))
  }
  deleting.value = false
}

// ---- Details ------------------------------------------------------------------------

const details = ref(false)
const shown = ref<FoundFile | null>(null)
const single = ref<FoundFile | null>(null)

function show(file: FoundFile) {
  shown.value = file
  details.value = true
}

function askDeleteOne(file: FoundFile) {
  single.value = file
  details.value = false
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Find files</CardTitle>
      <CardDescription>
        Look for files by type, size or age anywhere on the server. Balai then checks whether a website, a project or
        a program uses each one, so you can tell what is safe to delete.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form id="file-search" @submit.prevent="search">
        <FieldGroup>
          <div class="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel for="extensions">File extensions</FieldLabel>
              <Input id="extensions" v-model="extensions" placeholder="png, zip, log" autocomplete="off" />
              <div class="flex flex-wrap gap-1">
                <Button
                  v-for="preset in PRESETS"
                  :key="preset.label"
                  type="button"
                  variant="outline"
                  size="xs"
                  @click="extensions = preset.value"
                >
                  {{ preset.label }}
                </Button>
              </div>
            </Field>
            <Field>
              <FieldLabel for="folder">Folder</FieldLabel>
              <Input id="folder" v-model="folder" class="font-mono" placeholder="/" autocomplete="off" />
              <FieldDescription>Use / to search the whole server.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel for="minimum">Size</FieldLabel>
              <div class="flex gap-2">
                <Select v-model="minimum">
                  <SelectTrigger id="minimum" class="min-w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Any size</SelectItem>
                    <SelectItem value="1">1 MB or more</SelectItem>
                    <SelectItem value="10">10 MB or more</SelectItem>
                    <SelectItem value="100">100 MB or more</SelectItem>
                    <SelectItem value="1024">1 GB or more</SelectItem>
                    <SelectItem value="custom">Your own size…</SelectItem>
                  </SelectContent>
                </Select>
                <div v-if="minimum === 'custom'" class="relative flex-1">
                  <Input
                    v-model="customSize"
                    type="number"
                    min="0"
                    step="any"
                    inputmode="decimal"
                    placeholder="250"
                    aria-label="Minimum size in MB"
                    class="pr-24"
                  />
                  <span class="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm">MB or more</span>
                </div>
              </div>
            </Field>
            <Field>
              <FieldLabel for="age">Last changed</FieldLabel>
              <div class="flex gap-2">
                <Select v-model="age">
                  <SelectTrigger id="age" class="min-w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Any time</SelectItem>
                    <SelectItem value="30">More than 30 days ago</SelectItem>
                    <SelectItem value="90">More than 90 days ago</SelectItem>
                    <SelectItem value="365">More than a year ago</SelectItem>
                    <SelectItem value="custom">Your own number of days…</SelectItem>
                  </SelectContent>
                </Select>
                <div v-if="age === 'custom'" class="relative flex-1">
                  <Input
                    v-model="customAge"
                    type="number"
                    min="1"
                    step="1"
                    inputmode="numeric"
                    placeholder="14"
                    aria-label="Days since last change"
                    class="pr-24"
                  />
                  <span class="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm">days or more</span>
                </div>
              </div>
            </Field>
          </div>
        </FieldGroup>
      </form>
    </CardContent>
    <CardFooter class="justify-between gap-4 border-t">
      <p class="text-muted-foreground text-sm">
        {{ canSearch ? 'Searching a whole disk can take a minute. You can cancel at any time.' : 'Give an extension or a minimum size.' }}
      </p>
      <Button type="submit" form="file-search" :disabled="!canSearch || searching">
        <Spinner v-if="searching" data-icon="inline-start" />
        <SearchIcon v-else data-icon="inline-start" />
        {{ searching ? 'Searching…' : 'Search' }}
      </Button>
    </CardFooter>
  </Card>

  <Card v-if="searchJob && searching">
    <CardHeader>
      <CardTitle>{{ searchJob.title }}</CardTitle>
      <CardDescription class="tabular-nums">
        {{ searchJob.now ?? 'Starting…' }} · {{ durationOf(searchJob, now) }}
      </CardDescription>
      <CardAction>
        <Button variant="outline" size="sm" @click="cancel(searchJob)">
          <XIcon data-icon="inline-start" />
          Cancel
        </Button>
      </CardAction>
    </CardHeader>
  </Card>

  <Alert v-if="failure" variant="destructive">
    <TriangleAlertIcon />
    <AlertTitle>The search did not run</AlertTitle>
    <AlertDescription>{{ failure }}</AlertDescription>
  </Alert>

  <Alert v-if="outcome && outcome.failed.length" variant="destructive">
    <TriangleAlertIcon />
    <AlertTitle>{{ outcome.failed.length }} could not be deleted</AlertTitle>
    <AlertDescription>
      <ul>
        <li v-for="entry in outcome.failed.slice(0, 8)" :key="entry.path" class="break-all">
          {{ entry.path }}: {{ entry.message }}
        </li>
      </ul>
    </AlertDescription>
  </Alert>

  <Card v-if="result" :class="result.files.length ? 'pb-0' : ''">
    <CardHeader>
      <CardTitle>
        {{ result.count }} {{ result.count === 1 ? 'file' : 'files' }}, {{ bytes(result.total) }}
      </CardTitle>
      <CardDescription>
        In <span class="font-mono">{{ result.path }}</span>.
        <template v-if="result.truncated">Only the {{ result.files.length }} largest are listed.</template>
        Files that belong to the system are shown but cannot be deleted from here.
      </CardDescription>
    </CardHeader>

    <CardContent v-if="usageJob && checking" class="flex flex-col gap-2">
      <div class="flex items-center gap-3">
        <Spinner />
        <p class="min-w-0 flex-1 truncate text-sm">{{ usageJob.now ?? 'Checking where each file is used…' }}</p>
        <Button variant="ghost" size="sm" @click="cancel(usageJob)">Stop checking</Button>
      </div>
      <Progress
        :model-value="progressOf(usageJob) ?? (usageJob.steps.filter((entry) => entry.state === 'done').length / Math.max(1, usageJob.steps.length)) * 100"
      />
    </CardContent>

    <CardContent v-if="result.files.length" class="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Tabs v-model="filter">
        <TabsList class="max-w-full overflow-x-auto">
          <TabsTrigger value="all">All <span class="text-muted-foreground tabular-nums">{{ counts.all }}</span></TabsTrigger>
          <TabsTrigger value="unused" :disabled="!Object.keys(uses).length">
            Not used <span class="text-muted-foreground tabular-nums">{{ counts.unused }}</span>
          </TabsTrigger>
          <TabsTrigger value="maybe" :disabled="!Object.keys(uses).length">
            Unsure <span class="text-muted-foreground tabular-nums">{{ counts.maybe }}</span>
          </TabsTrigger>
          <TabsTrigger value="used" :disabled="!Object.keys(uses).length">
            In use <span class="text-muted-foreground tabular-nums">{{ counts.used }}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Input v-model="text" placeholder="Filter by path or use, such as releases or toscani" class="sm:ml-auto sm:max-w-xs" aria-label="Filter the list" />
    </CardContent>

    <CardContent v-if="visible.length" class="px-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-10 pl-4">
              <Checkbox
                :model-value="allChosen"
                :disabled="!deletable.length || deleting"
                aria-label="Select all shown"
                @update:model-value="toggleAll"
              />
            </TableHead>
            <TableHead>
              <button type="button" class="inline-flex items-center gap-1" @click="sort('path')">
                File
                <ArrowDownIcon v-if="sortBy === 'path' && descending" class="size-3" />
                <ArrowUpIcon v-else-if="sortBy === 'path'" class="size-3" />
              </button>
            </TableHead>
            <TableHead>Use</TableHead>
            <TableHead>
              <button type="button" class="inline-flex items-center gap-1" @click="sort('modified')">
                Last changed
                <ArrowDownIcon v-if="sortBy === 'modified' && descending" class="size-3" />
                <ArrowUpIcon v-else-if="sortBy === 'modified'" class="size-3" />
              </button>
            </TableHead>
            <TableHead class="pr-4 text-right">
              <button type="button" class="inline-flex items-center gap-1" @click="sort('size')">
                Size
                <ArrowDownIcon v-if="sortBy === 'size' && descending" class="size-3" />
                <ArrowUpIcon v-else-if="sortBy === 'size'" class="size-3" />
              </button>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="file in visible.slice(0, 1000)" :key="file.path" class="cursor-pointer" @click="show(file)">
            <TableCell class="pl-4" @click.stop>
              <Checkbox
                v-model="selected[file.path]"
                :disabled="file.locked || deleting"
                :aria-label="`Select ${file.path}`"
              />
            </TableCell>
            <TableCell class="max-w-md">
              <span class="flex items-center gap-2">
                <span class="truncate font-mono text-xs" :title="file.path">{{ file.path }}</span>
                <StatusBadge v-if="file.locked" tone="idle">System</StatusBadge>
              </span>
            </TableCell>
            <TableCell class="whitespace-nowrap">
              <UseBadge v-if="uses[file.path]" :use="uses[file.path]!" />
              <Skeleton v-else-if="checking" class="h-5 w-28" />
              <span v-else class="text-muted-foreground text-xs">Not checked</span>
            </TableCell>
            <TableCell class="text-muted-foreground whitespace-nowrap">{{ dateTime(file.modified) }}</TableCell>
            <TableCell class="pr-4 text-right tabular-nums">{{ bytes(file.size) }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
    <CardContent v-else>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing found</EmptyTitle>
          <EmptyDescription>
            {{ result.files.length ? 'No file matches this filter.' : 'No file matches in that folder.' }}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </CardContent>
    <CardFooter v-if="result.files.length" class="bg-card sticky bottom-0 justify-between gap-4 rounded-b-xl border-t py-4">
      <p class="text-muted-foreground text-sm">
        <template v-if="chosen.length">{{ chosen.length }} selected, {{ bytes(chosenSize) }}</template>
        <template v-else>Click a file to see where it is used.</template>
      </p>
      <Button variant="destructive" :disabled="!chosen.length || deleting" @click="confirming = true">
        <Spinner v-if="deleting" data-icon="inline-start" />
        <Trash2Icon v-else data-icon="inline-start" />
        Delete selected
      </Button>
    </CardFooter>
  </Card>

  <FileDetails
    v-model:open="details"
    :file="shown"
    :use="shown ? uses[shown.path] ?? null : null"
    :checking="checking"
    @delete="askDeleteOne"
  />

  <AlertDialog v-model:open="confirming">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          Delete {{ chosen.length }} {{ chosen.length === 1 ? 'file' : 'files' }}?
        </AlertDialogTitle>
        <AlertDialogDescription>
          {{ bytes(chosenSize) }} will be freed. The files are removed for good: there is no trash to restore them from.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <Alert v-if="risky.length" variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>{{ risky.length }} of them may still be in use</AlertTitle>
        <AlertDescription>
          <ul>
            <li v-for="file in risky.slice(0, 5)" :key="file.path" class="break-all">
              {{ file.path.split('/').pop() }}: {{ uses[file.path]!.label }}
            </li>
            <li v-if="risky.length > 5">and {{ risky.length - 5 }} more</li>
          </ul>
        </AlertDescription>
      </Alert>
      <ul class="bg-muted max-h-40 overflow-y-auto rounded-md border p-3 font-mono text-xs break-all">
        <li v-for="file in chosen.slice(0, 20)" :key="file.path">{{ file.path }}</li>
        <li v-if="chosen.length > 20" class="text-muted-foreground font-sans">and {{ chosen.length - 20 }} more</li>
      </ul>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" @click="remove()">Delete</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <AlertDialog :open="single !== null" @update:open="(value) => { if (!value) single = null }">
    <AlertDialogContent v-if="single">
      <AlertDialogHeader>
        <AlertDialogTitle>Delete {{ single.path.split('/').pop() }}?</AlertDialogTitle>
        <AlertDialogDescription>
          {{ bytes(single.size) }} will be freed. The file is removed for good.
          <template v-if="uses[single.path] && uses[single.path]!.use !== 'unused'">
            Balai thinks it may still be in use: {{ uses[single.path]!.label.toLowerCase() }}.
          </template>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" @click="() => { const path = single!.path; single = null; void remove([path]) }">
          Delete
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
