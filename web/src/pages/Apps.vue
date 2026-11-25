<script setup lang="ts">
import { BoxIcon, ContainerIcon, GlobeIcon, PackageIcon, SearchIcon, ServerCogIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppDetailPanel from '@/components/apps/AppDetailPanel.vue'
import LoadError from '@/components/LoadError.vue'
import { Card, CardContent } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResource } from '@/composables/useResource'
import { bytes } from '@/lib/format'
import type { AppGroup, AppSummary } from '@/lib/types'

const { data, error, refresh } = useResource<AppSummary[]>('/apps')
const route = useRoute()
const router = useRouter()

const group = ref<AppGroup>('user')
const search = ref('')
const libraries = ref(false)
const order = ref('name')

// The chosen app is in the address, so it survives a reload and can be shared.
const chosen = computed(() => (typeof route.query.app === 'string' ? route.query.app : null))
function choose(app: AppSummary) {
  void router.replace({ query: { ...route.query, app: app.id } })
}
watch(data, (apps) => {
  const current = apps?.find((app) => app.id === chosen.value)
  if (current) group.value = current.group
})

const counts = computed(() => {
  const all = data.value ?? []
  const of = (name: AppGroup) => all.filter((app) => app.group === name && (name !== 'user' || libraries.value || !app.library)).length
  return { user: of('user'), default: of('default'), system: of('system') }
})

const visible = computed(() => {
  const term = search.value.trim().toLowerCase()
  const list = (data.value ?? []).filter((app) => {
    if (term) return app.name.toLowerCase().includes(term) || app.summary.toLowerCase().includes(term) || app.sites.some((site) => site.includes(term))
    if (app.group !== group.value) return false
    return libraries.value || !app.library
  })
  if (order.value === 'size') return [...list].sort((a, b) => (b.size ?? -1) - (a.size ?? -1))
  if (order.value === 'size-asc') return [...list].sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity))
  return list
})

const KIND_ICON = { package: PackageIcon, service: ServerCogIcon, container: ContainerIcon, snap: BoxIcon } as const
const GROUP_HELP: Record<AppGroup, string> = {
  user: 'Packages, services and containers added to this server after it was set up.',
  default: 'Installed with the operating system. Usually useful, sometimes not needed on a server.',
  system: 'The operating system cannot run without these.',
}
</script>

<template>
  <LoadError :message="error" />

  <div class="flex flex-wrap items-center gap-2">
    <div class="relative w-full max-w-xs">
      <SearchIcon class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
      <Input v-model="search" class="pl-8" placeholder="Find an app or a website" aria-label="Find an app" />
    </div>
    <Tabs v-model="group">
      <TabsList>
        <TabsTrigger value="user">Installed by you {{ counts.user }}</TabsTrigger>
        <TabsTrigger value="default">Came with the system {{ counts.default }}</TabsTrigger>
        <TabsTrigger value="system">Needed by the system {{ counts.system }}</TabsTrigger>
      </TabsList>
    </Tabs>
    <div class="ml-auto flex items-center gap-3">
      <div class="flex items-center gap-2">
        <Switch id="libraries" v-model="libraries" />
        <Label for="libraries" class="text-sm font-normal">Libraries and fonts</Label>
      </div>
      <Select v-model="order">
        <SelectTrigger size="sm" class="w-36" aria-label="Order"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="name">By name</SelectItem>
          <SelectItem value="size">Largest first</SelectItem>
          <SelectItem value="size-asc">Smallest first</SelectItem>
        </SelectContent>
      </Select>
    </div>
  </div>
  <p class="text-muted-foreground -mt-2 text-sm">{{ search ? 'Results from every group.' : GROUP_HELP[group] }}</p>

  <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
    <Card class="py-0 lg:sticky lg:top-4">
      <CardContent class="max-h-[70vh] overflow-y-auto px-0">
        <ul v-if="data" class="divide-y">
          <li v-for="app in visible" :key="app.id">
            <button
              type="button"
              class="hover:bg-muted/60 flex w-full items-center gap-3 px-4 py-2.5 text-left"
              :class="app.id === chosen ? 'bg-muted' : ''"
              @click="choose(app)"
            >
              <component :is="KIND_ICON[app.kind]" class="text-muted-foreground size-4 shrink-0" />
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="truncate text-sm font-medium">{{ app.name }}</span>
                  <span v-if="app.running" class="size-1.5 shrink-0 rounded-full bg-emerald-500" title="Running" />
                </span>
                <span class="text-muted-foreground flex items-center gap-1 truncate text-xs">
                  <template v-if="app.sites.length"><GlobeIcon class="size-3 shrink-0" />{{ app.sites.length === 1 ? app.sites[0] : `${app.sites.length} websites` }}</template>
                  <template v-else>{{ app.summary }}</template>
                </span>
              </span>
              <span class="text-muted-foreground shrink-0 text-xs tabular-nums">{{ app.size === null ? '' : bytes(app.size) }}</span>
            </button>
          </li>
          <li v-if="!visible.length" class="text-muted-foreground px-4 py-6 text-center text-sm">No app matches.</li>
        </ul>
        <div v-else class="flex flex-col gap-2 p-4">
          <Skeleton v-for="index in 10" :key="index" class="h-10" />
        </div>
      </CardContent>
    </Card>

    <AppDetailPanel v-if="chosen" :id="chosen" :key="chosen" @changed="refresh" />
    <Card v-else>
      <CardContent>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Choose an app</EmptyTitle>
            <EmptyDescription>
              See everything linked to it (websites, services, ports, folders, packages), how much space it takes, what
              you can do with it, and whether it is safe to remove.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
    </Card>
  </div>
</template>
