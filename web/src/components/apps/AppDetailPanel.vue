<script setup lang="ts">
import {
  CircleCheckIcon, ExternalLinkIcon, GitBranchIcon, OctagonXIcon, PlayIcon, RotateCwIcon, ScrollTextIcon, ShieldIcon,
  SquareIcon, TriangleAlertIcon, Trash2Icon,
} from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import StatusBadge from '@/components/StatusBadge.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, messageOf, post } from '@/lib/api'
import { ago, bytes, dateTime } from '@/lib/format'
import type { ActionResult, AppDetail } from '@/lib/types'

const props = defineProps<{ id: string }>()
const emit = defineEmits<{ changed: [] }>()

const detail = ref<AppDetail | null>(null)
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  const asked = props.id
  try {
    const answer = await api<AppDetail>(`/apps/detail?id=${encodeURIComponent(asked)}`)
    if (asked === props.id) detail.value = answer
  } catch (failure) {
    if (asked === props.id) error.value = messageOf(failure)
  }
  if (asked === props.id) loading.value = false
}
watch(() => props.id, () => {
  detail.value = null
  void load()
}, { immediate: true })

const KIND = { package: 'Package', service: 'Your service', container: 'Docker container', snap: 'Snap' } as const
const GROUP = { user: 'Installed by you', default: 'Came with the system', system: 'Needed by the system' } as const
const ROLE = { program: 'Program', settings: 'Settings', data: 'Data', logs: 'Logs', cache: 'Cache' } as const
const VERDICT_ICON = { needed: ShieldIcon, blocked: OctagonXIcon, caution: TriangleAlertIcon, safe: CircleCheckIcon } as const

const memory = computed(() => detail.value?.unitList.reduce((total, unit) => total + (unit.memory ?? 0), 0) ?? 0)
const publicPorts = computed(() => [...new Set(detail.value?.listeners.filter((item) => item.public).map((item) => item.port) ?? [])])
const localPorts = computed(() => [...new Set(detail.value?.listeners.filter((item) => !item.public).map((item) => item.port) ?? [])])

// ---- Actions ----------------------------------------------------------------------------------

type Pending =
  | { kind: 'unit'; name: string; action: 'start' | 'stop' | 'restart' }
  | { kind: 'container'; name: string; action: 'start' | 'stop' | 'restart' }
  | { kind: 'uninstall'; name: string }

const pending = ref<Pending | null>(null)
const busy = ref(false)

const VERB = { start: 'Start', stop: 'Stop', restart: 'Restart' } as const

async function confirm() {
  const target = pending.value
  if (!target) return
  pending.value = null
  busy.value = true
  try {
    let result: ActionResult
    if (target.kind === 'unit') result = await post<ActionResult>(`/services/${encodeURIComponent(target.name)}/${target.action}`)
    else if (target.kind === 'container') result = await post<ActionResult>(`/apps/containers/${encodeURIComponent(target.name)}/${target.action}`)
    else result = await post<ActionResult>('/packages/remove', { name: target.name, purge: false })
    toast.success(target.kind === 'uninstall' ? `${result.message} Follow it in Tasks.` : result.message)
    emit('changed')
    await load()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  busy.value = false
}

const mainPackage = computed(() => detail.value?.packageList.find((item) => !item.system)?.name ?? null)
const canUninstall = computed(
  () => detail.value?.kind === 'package' && detail.value.verdict.level !== 'needed' && mainPackage.value !== null,
)

const logs = ref<{ name: string; lines: string[] | null } | null>(null)
async function showLogs(name: string) {
  logs.value = { name, lines: null }
  try {
    const answer = await api<{ lines: string[] }>(`/services/${encodeURIComponent(name)}/logs`)
    if (logs.value?.name === name) logs.value = { name, lines: answer.lines }
  } catch (failure) {
    logs.value = null
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <Card v-if="error">
    <CardContent>
      <Alert variant="destructive">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>
    </CardContent>
  </Card>

  <Card v-else-if="!detail">
    <CardHeader>
      <Skeleton class="h-6 w-48" />
      <Skeleton class="h-4 w-72" />
    </CardHeader>
    <CardContent class="flex flex-col gap-3">
      <p class="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner />
        Looking at its packages, services, ports, websites and folders…
      </p>
      <Skeleton v-for="index in 4" :key="index" class="h-16" />
    </CardContent>
  </Card>

  <div v-else class="flex min-w-0 flex-col gap-4">
    <Card>
      <CardHeader>
        <CardTitle class="flex flex-wrap items-center gap-2 text-lg">
          {{ detail.name }}
          <Badge variant="outline">{{ KIND[detail.kind] }}</Badge>
          <Badge variant="secondary">{{ GROUP[detail.group] }}</Badge>
        </CardTitle>
        <CardDescription>{{ detail.summary }}</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <Alert :variant="detail.verdict.level === 'blocked' ? 'destructive' : 'default'">
          <component :is="VERDICT_ICON[detail.verdict.level]" />
          <AlertTitle>{{ detail.verdict.title }}</AlertTitle>
          <AlertDescription>
            <ul class="list-disc pl-4">
              <li v-for="reason in detail.verdict.reasons" :key="reason">{{ reason }}</li>
            </ul>
            <template v-if="detail.verdict.steps.length">
              <p class="text-foreground mt-2 font-medium">What to do</p>
              <ol class="list-decimal pl-4">
                <li v-for="item in detail.verdict.steps" :key="item">{{ item }}</li>
              </ol>
            </template>
          </AlertDescription>
        </Alert>

        <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-lg border p-3">
            <dt class="text-muted-foreground text-xs">Size on disk</dt>
            <dd class="font-semibold tabular-nums">{{ detail.size === null ? '—' : bytes(detail.size) }}</dd>
          </div>
          <div class="rounded-lg border p-3">
            <dt class="text-muted-foreground text-xs">Memory now</dt>
            <dd class="font-semibold tabular-nums">{{ memory ? bytes(memory) : '—' }}</dd>
          </div>
          <div class="rounded-lg border p-3">
            <dt class="text-muted-foreground text-xs">Status</dt>
            <dd class="font-semibold">{{ detail.running === null ? 'No service' : detail.running ? 'Running' : 'Stopped' }}</dd>
          </div>
          <div class="rounded-lg border p-3">
            <dt class="text-muted-foreground text-xs">Updates</dt>
            <dd class="font-semibold">{{ detail.updates ? `${detail.updates} available` : 'Up to date' }}</dd>
          </div>
        </dl>

        <div class="flex flex-wrap gap-2">
          <template v-for="unit in detail.unitList" :key="unit.name">
            <Button v-if="unit.active === 'active'" variant="outline" size="sm" :disabled="busy" @click="pending = { kind: 'unit', name: unit.name, action: 'restart' }">
              <RotateCwIcon data-icon="inline-start" />
              Restart{{ detail.unitList.length > 1 ? ` ${unit.name.replace('.service', '')}` : '' }}
            </Button>
            <Button v-if="unit.active === 'active'" variant="outline" size="sm" :disabled="busy" @click="pending = { kind: 'unit', name: unit.name, action: 'stop' }">
              <SquareIcon data-icon="inline-start" />
              Stop{{ detail.unitList.length > 1 ? ` ${unit.name.replace('.service', '')}` : '' }}
            </Button>
            <Button v-else variant="outline" size="sm" :disabled="busy" @click="pending = { kind: 'unit', name: unit.name, action: 'start' }">
              <PlayIcon data-icon="inline-start" />
              Start{{ detail.unitList.length > 1 ? ` ${unit.name.replace('.service', '')}` : '' }}
            </Button>
            <Button variant="outline" size="sm" @click="showLogs(unit.name)">
              <ScrollTextIcon data-icon="inline-start" />
              Logs{{ detail.unitList.length > 1 ? ` of ${unit.name.replace('.service', '')}` : '' }}
            </Button>
          </template>
          <template v-if="detail.kind === 'container'">
            <Button v-if="detail.running" variant="outline" size="sm" :disabled="busy" @click="pending = { kind: 'container', name: detail.name, action: 'restart' }">
              <RotateCwIcon data-icon="inline-start" />
              Restart
            </Button>
            <Button v-if="detail.running" variant="outline" size="sm" :disabled="busy" @click="pending = { kind: 'container', name: detail.name, action: 'stop' }">
              <SquareIcon data-icon="inline-start" />
              Stop
            </Button>
            <Button v-else variant="outline" size="sm" :disabled="busy" @click="pending = { kind: 'container', name: detail.name, action: 'start' }">
              <PlayIcon data-icon="inline-start" />
              Start
            </Button>
          </template>
          <Button v-if="detail.updates" variant="outline" size="sm" as-child>
            <RouterLink to="/packages">See its updates</RouterLink>
          </Button>
          <Button v-if="canUninstall" variant="destructive" size="sm" :disabled="busy" @click="pending = { kind: 'uninstall', name: mainPackage! }">
            <Trash2Icon data-icon="inline-start" />
            Uninstall
          </Button>
        </div>
      </CardContent>
    </Card>

    <Card v-if="detail.siteList.length">
      <CardHeader>
        <CardTitle>Websites</CardTitle>
        <CardDescription>{{ detail.siteList.length }} {{ detail.siteList.length === 1 ? 'site depends' : 'sites depend' }} on it.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul class="flex flex-col divide-y">
          <li v-for="site in detail.siteList" :key="site.url" class="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">{{ site.name }}</p>
              <p class="text-muted-foreground text-xs">{{ site.how }}</p>
            </div>
            <Button variant="ghost" size="sm" as-child>
              <a :href="site.url" target="_blank" rel="noreferrer noopener" :aria-label="`Open ${site.name}`"><ExternalLinkIcon /></a>
            </Button>
          </li>
        </ul>
      </CardContent>
    </Card>

    <Card v-if="detail.unitList.length || detail.listeners.length">
      <CardHeader>
        <CardTitle>Services and ports</CardTitle>
        <CardDescription>
          <template v-if="publicPorts.length">Open to the internet on port {{ publicPorts.join(', ') }}. </template>
          <template v-if="localPorts.length">Listening on this server only on port {{ localPorts.join(', ') }}.</template>
          <template v-if="!detail.listeners.length">No network port.</template>
        </CardDescription>
      </CardHeader>
      <CardContent v-if="detail.unitList.length" class="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="pl-6">Service</TableHead>
              <TableHead>State</TableHead>
              <TableHead>At boot</TableHead>
              <TableHead class="pr-6 text-right">Memory</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="unit in detail.unitList" :key="unit.name">
              <TableCell class="max-w-72 pl-6">
                <p class="truncate font-medium">{{ unit.name }}</p>
                <p class="text-muted-foreground truncate font-mono text-xs" :title="unit.command">{{ unit.command }}</p>
                <p class="text-muted-foreground text-xs">Runs as {{ unit.user }}<template v-if="unit.since">, since {{ ago(unit.since) }}</template></p>
              </TableCell>
              <TableCell>
                <StatusBadge :tone="unit.active === 'active' ? 'good' : unit.active === 'failed' ? 'bad' : 'idle'">{{ unit.active }}</StatusBadge>
              </TableCell>
              <TableCell class="text-muted-foreground">{{ unit.enabled }}</TableCell>
              <TableCell class="pr-6 text-right tabular-nums">{{ unit.memory ? bytes(unit.memory) : '—' }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Card v-if="detail.folders.length">
      <CardHeader>
        <CardTitle>Folders</CardTitle>
        <CardDescription>Where it keeps its program, settings, data and logs.</CardDescription>
      </CardHeader>
      <CardContent class="px-0">
        <Table>
          <TableBody>
            <TableRow v-for="folder in detail.folders" :key="folder.path">
              <TableCell class="pl-6 font-mono text-xs break-all">{{ folder.path }}</TableCell>
              <TableCell><Badge variant="outline">{{ ROLE[folder.role] }}</Badge></TableCell>
              <TableCell class="pr-6 text-right tabular-nums">{{ folder.size === null ? '—' : bytes(folder.size) }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Card v-if="detail.packageList.length">
      <CardHeader>
        <CardTitle>Packages</CardTitle>
        <CardDescription>
          <template v-if="detail.removes.length > 1">
            Uninstalling also removes {{ detail.removes.filter((name) => name !== mainPackage).join(', ') }}<template v-if="detail.freed">, about {{ bytes(detail.freed) }} in all</template>.
          </template>
          <template v-else-if="detail.freed">Uninstalling frees about {{ bytes(detail.freed) }}.</template>
          <template v-if="detail.held.length"> Held at its version: {{ detail.held.join(', ') }}.</template>
        </CardDescription>
      </CardHeader>
      <CardContent class="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="pl-6">Package</TableHead>
              <TableHead>Version</TableHead>
              <TableHead class="pr-6 text-right">Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="item in detail.packageList" :key="item.name">
              <TableCell class="max-w-72 pl-6">
                <p class="flex items-center gap-2 font-medium">
                  {{ item.name }}
                  <StatusBadge v-if="item.system" tone="idle">System</StatusBadge>
                </p>
                <p class="text-muted-foreground truncate text-xs">{{ item.summary }}</p>
              </TableCell>
              <TableCell class="text-muted-foreground max-w-40 truncate font-mono text-xs">{{ item.version }}</TableCell>
              <TableCell class="pr-6 text-right tabular-nums">{{ bytes(item.size) }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Card v-if="detail.neededBy.length">
      <CardHeader>
        <CardTitle>Needed by</CardTitle>
        <CardDescription>Installed packages that depend on it.</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-1.5">
        <Badge v-for="item in detail.neededBy" :key="item.name" :variant="item.app ? 'secondary' : 'outline'" :title="item.app ? `Part of ${item.app}` : 'A library or dependency'">
          {{ item.name }}
        </Badge>
      </CardContent>
    </Card>

    <Card v-if="detail.git || detail.timers.length || detail.container">
      <CardHeader>
        <CardTitle>{{ detail.container ? 'Container' : 'Source and updates' }}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <template v-if="detail.git">
            <dt class="text-muted-foreground flex items-center gap-1.5"><GitBranchIcon class="size-3.5" />Git</dt>
            <dd class="break-all">{{ detail.git.remote || 'no remote' }} · {{ detail.git.branch }}</dd>
            <dt class="text-muted-foreground">Last commit</dt>
            <dd class="break-words">{{ detail.git.commit }}<span v-if="detail.git.date" class="text-muted-foreground">, {{ ago(detail.git.date) }}</span></dd>
          </template>
          <template v-for="timer in detail.timers" :key="timer.name">
            <dt class="text-muted-foreground">{{ timer.name }}</dt>
            <dd>
              Last run {{ timer.last ? ago(timer.last) : 'never' }}<template v-if="timer.result">, {{ timer.result === 'success' ? 'succeeded' : timer.result }}</template><template v-if="timer.next">; next {{ dateTime(timer.next) }}</template>
            </dd>
          </template>
          <template v-if="detail.container">
            <dt class="text-muted-foreground">Image</dt>
            <dd class="font-mono text-xs break-all">{{ detail.container.image }}</dd>
            <dt class="text-muted-foreground">Restarts</dt>
            <dd>{{ detail.container.restart === 'no' ? 'Never on its own' : detail.container.restart }}</dd>
            <template v-if="detail.container.project">
              <dt class="text-muted-foreground">Compose project</dt>
              <dd>{{ detail.container.project }}</dd>
            </template>
            <template v-if="detail.container.mounts.length">
              <dt class="text-muted-foreground">Data</dt>
              <dd class="font-mono text-xs break-all">
                <p v-for="mount in detail.container.mounts" :key="mount">{{ mount }}</p>
              </dd>
            </template>
          </template>
        </dl>
      </CardContent>
    </Card>
  </div>

  <AlertDialog :open="!!pending" @update:open="(open: boolean) => { if (!open) pending = null }">
    <AlertDialogContent v-if="pending">
      <AlertDialogHeader>
        <AlertDialogTitle>
          <template v-if="pending.kind === 'uninstall'">Uninstall {{ pending.name }}?</template>
          <template v-else>{{ VERB[pending.action] }} {{ pending.name.replace('.service', '') }}?</template>
        </AlertDialogTitle>
        <AlertDialogDescription>
          <template v-if="pending.kind === 'uninstall'">
            {{ detail?.verdict.level === 'safe' ? 'Nothing else uses it.' : detail?.verdict.reasons.join(' ') }}
            Its settings and data folders stay in place. The removal runs as a task.
          </template>
          <template v-else-if="pending.action === 'stop'">
            It stops now{{ detail?.sites.length ? `, and ${detail.sites.slice(0, 3).join(', ')} go${detail.sites.length === 1 ? 'es' : ''} offline until it is started again` : '' }}.
          </template>
          <template v-else-if="pending.action === 'restart'">It goes down for a moment and comes back. Open connections are dropped.</template>
          <template v-else>It starts now.</template>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button :variant="pending.kind === 'uninstall' || pending.action === 'stop' ? 'destructive' : 'default'" @click="confirm">
          {{ pending.kind === 'uninstall' ? 'Uninstall' : VERB[pending.action] }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <Dialog :open="!!logs" @update:open="(open: boolean) => { if (!open) logs = null }">
    <DialogContent v-if="logs" class="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Logs of {{ logs.name }}</DialogTitle>
        <DialogDescription>The latest lines, newest at the bottom.</DialogDescription>
      </DialogHeader>
      <ScrollArea class="bg-muted h-96 rounded-md border">
        <pre v-if="logs.lines" class="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{{ logs.lines.join('\n') || 'No log lines.' }}</pre>
        <div v-else class="flex items-center gap-2 p-3 text-sm"><Spinner /> Loading…</div>
      </ScrollArea>
    </DialogContent>
  </Dialog>
</template>
