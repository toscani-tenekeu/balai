<script setup lang="ts">
import { CircleCheckIcon, RefreshCwIcon, SearchIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResource } from '@/composables/useResource'
import { api, messageOf, post } from '@/lib/api'
import { bytes, duration } from '@/lib/format'
import type { ActionResult, InstalledPackage, PackageJob, PackageState, RemovalPlan } from '@/lib/types'

type Pending =
  | { kind: 'upgrade'; name: string | null }
  | { kind: 'remove'; name: string; plan: RemovalPlan | null; error: string }

const { data, error, refresh } = useResource<PackageState>('/packages')
const { data: installed, error: installedError, refresh: refreshInstalled } =
  useResource<InstalledPackage[]>('/packages/installed')

const tab = ref('updates')
const refreshing = ref(false)
const search = ref('')
const scope = ref('manual')
const pending = ref<Pending | null>(null)
const purge = ref(false)
const job = ref<PackageJob | null>(null)
const showJob = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

const security = computed(() => data.value?.upgrades.filter((item) => item.security).length ?? 0)
const busy = computed(() => job.value?.running === true)

const matching = computed(() => {
  const term = search.value.trim().toLowerCase()
  return (installed.value ?? []).filter((item) => {
    if (scope.value === 'manual' && !item.manual) return false
    return !term || item.name.toLowerCase().includes(term) || item.summary.toLowerCase().includes(term)
  })
})
const visible = computed(() => matching.value.slice(0, 200))

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

async function askRemove(item: InstalledPackage) {
  purge.value = false
  pending.value = { kind: 'remove', name: item.name, plan: null, error: '' }
  try {
    const plan = await api<RemovalPlan>(`/packages/removal?name=${encodeURIComponent(item.name)}`)
    if (pending.value?.kind === 'remove' && pending.value.name === item.name) pending.value.plan = plan
  } catch (failure) {
    if (pending.value?.kind === 'remove' && pending.value.name === item.name) pending.value.error = messageOf(failure)
  }
}

const removal = computed(() => (pending.value?.kind === 'remove' ? pending.value : null))
const upgrade = computed(() => (pending.value?.kind === 'upgrade' ? pending.value : null))
const blocked = computed(() => (removal.value?.plan?.blocked.length ?? 0) > 0)
const others = computed(() => removal.value?.plan?.removed.filter((name) => name !== removal.value?.name) ?? [])

async function poll() {
  try {
    const state = await api<{ job: PackageJob | null }>('/packages/job')
    const wasRunning = busy.value
    job.value = state.job
    if (state.job?.running) {
      timer ??= setInterval(() => void poll(), 1500)
    } else {
      clearInterval(timer)
      timer = undefined
      if (wasRunning) {
        if (state.job?.ok) toast.success(`${state.job.title}: done.`)
        else toast.error(`${state.job?.title ?? 'The operation'} failed.`)
        void refresh()
        void refreshInstalled()
      }
    }
  } catch {
    // The next tick tries again.
  }
}

async function confirm() {
  const target = pending.value
  if (!target) return
  pending.value = null
  try {
    if (target.kind === 'upgrade') await post<ActionResult>('/packages/upgrade', { name: target.name })
    else await post<ActionResult>('/packages/remove', { name: target.name, purge: purge.value })
    showJob.value = true
    await poll()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}

onMounted(poll)
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <LoadError :message="error || installedError" />

  <Alert v-if="data?.rebootRequired">
    <TriangleAlertIcon />
    <AlertTitle>A restart is needed</AlertTitle>
    <AlertDescription>
      Some installed updates only take effect after the server restarts<template v-if="data.rebootPackages.length">:
        {{ data.rebootPackages.slice(0, 6).join(', ') }}</template>.
    </AlertDescription>
  </Alert>

  <Alert v-if="job && (job.running || !showJob)" :variant="job.ok === false ? 'destructive' : 'default'">
    <Spinner v-if="job.running" />
    <CircleCheckIcon v-else-if="job.ok" />
    <TriangleAlertIcon v-else />
    <AlertTitle>{{ job.title }}{{ job.running ? '…' : job.ok ? ': done' : ': failed' }}</AlertTitle>
    <AlertDescription>
      <Button variant="link" class="h-auto p-0" @click="showJob = true">Show the output</Button>
    </AlertDescription>
  </Alert>

  <Tabs v-model="tab">
    <TabsList>
      <TabsTrigger value="updates">Updates{{ data ? ` ${data.upgrades.length}` : '' }}</TabsTrigger>
      <TabsTrigger value="installed">Installed</TabsTrigger>
    </TabsList>

    <TabsContent value="updates">
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
              <template v-if="data.indexAge !== null">Package lists refreshed {{ duration(data.indexAge) }} ago.</template>
            </template>
          </CardDescription>
          <CardAction class="flex gap-2">
            <Button variant="outline" size="sm" :disabled="refreshing || busy" @click="refreshLists">
              <Spinner v-if="refreshing" data-icon="inline-start" />
              <RefreshCwIcon v-else data-icon="inline-start" />
              Refresh lists
            </Button>
            <Button
              v-if="data?.upgrades.length"
              size="sm"
              :disabled="busy"
              @click="pending = { kind: 'upgrade', name: null }"
            >
              Install all
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
                  <TableHead>Type</TableHead>
                  <TableHead class="w-20"><span class="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="item in data.upgrades" :key="item.name">
                  <TableCell class="font-medium">{{ item.name }}</TableCell>
                  <TableCell class="text-muted-foreground max-w-48 truncate font-mono text-xs">{{ item.current }}</TableCell>
                  <TableCell class="max-w-48 truncate font-mono text-xs">{{ item.next }}</TableCell>
                  <TableCell>
                    <StatusBadge :tone="item.security ? 'bad' : 'idle'">{{ item.security ? 'Security' : 'Regular' }}</StatusBadge>
                  </TableCell>
                  <TableCell class="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      :disabled="busy"
                      @click="pending = { kind: 'upgrade', name: item.name }"
                    >
                      Update
                    </Button>
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
    </TabsContent>

    <TabsContent value="installed" class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative w-full max-w-sm">
          <SearchIcon class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input v-model="search" class="pl-8" placeholder="Filter packages" aria-label="Filter packages" />
        </div>
        <Tabs v-model="scope">
          <TabsList>
            <TabsTrigger value="manual">Installed by you</TabsTrigger>
            <TabsTrigger value="all">Everything</TabsTrigger>
          </TabsList>
        </Tabs>
        <p v-if="installed" class="text-muted-foreground ml-auto text-sm">
          {{ matching.length }} {{ matching.length === 1 ? 'package' : 'packages' }}
          <template v-if="matching.length > visible.length">, first {{ visible.length }} shown</template>
        </p>
      </div>

      <Card class="py-0">
        <CardContent class="px-0">
          <Table v-if="installed">
            <TableHeader>
              <TableRow>
                <TableHead class="pl-4">Package</TableHead>
                <TableHead>Version</TableHead>
                <TableHead class="text-right">Size</TableHead>
                <TableHead class="w-28 pr-4"><span class="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="item in visible" :key="item.name">
                <TableCell class="max-w-96 pl-4">
                  <p class="truncate font-medium">{{ item.name }}</p>
                  <p class="text-muted-foreground truncate text-xs">{{ item.summary }}</p>
                </TableCell>
                <TableCell class="text-muted-foreground max-w-40 truncate font-mono text-xs">{{ item.version }}</TableCell>
                <TableCell class="text-right tabular-nums">{{ bytes(item.size) }}</TableCell>
                <TableCell class="pr-4 text-right">
                  <StatusBadge v-if="item.locked" tone="idle">System</StatusBadge>
                  <Button v-else variant="outline" size="sm" :disabled="busy" @click="askRemove(item)">Uninstall</Button>
                </TableCell>
              </TableRow>
              <TableEmpty v-if="!visible.length" :colspan="4">No package matches.</TableEmpty>
            </TableBody>
          </Table>
          <div v-else class="flex flex-col gap-2 p-4">
            <Skeleton v-for="index in 8" :key="index" class="h-10" />
          </div>
        </CardContent>
      </Card>
    </TabsContent>
  </Tabs>

  <AlertDialog :open="!!upgrade" @update:open="(open: boolean) => { if (!open) pending = null }">
    <AlertDialogContent v-if="upgrade">
      <AlertDialogHeader>
        <AlertDialogTitle>
          {{ upgrade.name ? `Update ${upgrade.name}?` : `Install all ${data?.upgrades.length ?? ''} updates?` }}
        </AlertDialogTitle>
        <AlertDialogDescription>
          Services that belong to an updated package restart during the installation, so they can be unavailable for a
          moment. Your configuration files are kept as they are. A kernel update only takes effect after a server restart.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button @click="confirm">{{ upgrade.name ? 'Update' : 'Install all' }}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <AlertDialog :open="!!removal" @update:open="(open: boolean) => { if (!open) pending = null }">
    <AlertDialogContent v-if="removal">
      <AlertDialogHeader>
        <AlertDialogTitle>Uninstall {{ removal.name }}?</AlertDialogTitle>
        <AlertDialogDescription>
          <template v-if="removal.error">{{ removal.error }}</template>
          <template v-else-if="!removal.plan">Working out what would be removed…</template>
          <template v-else-if="blocked">
            This cannot be done from here: it would also remove {{ removal.plan.blocked.slice(0, 5).join(', ') }},
            which the system needs to run.
          </template>
          <template v-else>
            The program stops and is removed from the server, freeing about {{ bytes(removal.plan.size) }}.
            Anything that depends on it stops working.
          </template>
        </AlertDialogDescription>
      </AlertDialogHeader>

      <template v-if="removal.plan && !blocked">
        <Alert v-for="warning in removal.plan.warnings" :key="warning" variant="destructive">
          <TriangleAlertIcon />
          <AlertDescription>{{ warning }}</AlertDescription>
        </Alert>
        <div v-if="others.length" class="flex flex-col gap-2">
          <p class="text-sm">
            {{ others.length }} other {{ others.length === 1 ? 'package depends' : 'packages depend' }} on it and will be removed too:
          </p>
          <ul class="bg-muted max-h-32 overflow-y-auto rounded-md border p-3 font-mono text-xs">
            <li v-for="name in others" :key="name">{{ name }}</li>
          </ul>
        </div>
        <Field orientation="horizontal">
          <Checkbox id="purge" v-model="purge" />
          <FieldContent>
            <FieldLabel for="purge">Also delete its settings</FieldLabel>
            <FieldDescription>Removes the configuration files too. Data it stored elsewhere is not touched.</FieldDescription>
          </FieldContent>
        </Field>
      </template>

      <AlertDialogFooter>
        <AlertDialogCancel>{{ blocked || removal.error ? 'Close' : 'Cancel' }}</AlertDialogCancel>
        <Button v-if="removal.plan && !blocked" variant="destructive" @click="confirm">
          Uninstall
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <Dialog v-model:open="showJob">
    <DialogContent v-if="job" class="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{{ job.title }}</DialogTitle>
        <DialogDescription>
          <template v-if="job.running">Running. You can close this window; the work continues on the server.</template>
          <template v-else-if="job.ok">Finished without errors.</template>
          <template v-else>Finished with an error. The last lines say why.</template>
        </DialogDescription>
      </DialogHeader>
      <ScrollArea class="bg-muted h-80 rounded-md border">
        <pre class="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{{ job.output.join('\n') || 'Waiting for output…' }}</pre>
      </ScrollArea>
      <DialogFooter>
        <Spinner v-if="job.running" class="mr-auto self-center" />
        <Button variant="outline" @click="showJob = false">Close</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
