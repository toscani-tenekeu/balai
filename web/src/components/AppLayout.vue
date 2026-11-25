<script setup lang="ts">
import { useColorMode } from '@vueuse/core'
import { BrushCleaningIcon, LogOutIcon, MoonIcon, SettingsIcon, SunIcon } from '@lucide/vue'
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TasksMenu from '@/components/tasks/TasksMenu.vue'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem,
  SidebarProvider, SidebarRail, SidebarTrigger,
} from '@/components/ui/sidebar'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { loadUpdateState, signedIn, updateAvailable } from '@/composables/useSession'
import { sectionOf, sections } from '@/lib/sections'
import { post } from '@/lib/api'

const route = useRoute()
const router = useRouter()
const mode = useColorMode()

// The open section's pages are tabs under the header, so related tools are one click apart.
const section = computed(() => sectionOf(route.path))
const goTo = (path: string | number) => {
  if (path !== route.path) void router.push(String(path))
}

async function signOut() {
  await post('/logout').catch(() => null)
  signedIn.value = false
  await router.push('/login')
}

onMounted(loadUpdateState)
</script>

<template>
  <SidebarProvider>
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" as-child>
              <RouterLink to="/">
                <div class="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <BrushCleaningIcon class="size-4" />
                </div>
                <div class="grid flex-1 text-left leading-tight">
                  <span class="truncate font-semibold">Balai</span>
                  <span class="text-muted-foreground truncate text-xs">Server care</span>
                </div>
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem v-for="item in sections" :key="item.id">
                <SidebarMenuButton as-child :is-active="section?.id === item.id" :tooltip="item.label">
                  <RouterLink :to="item.tabs[0]!.to">
                    <component :is="item.icon" />
                    <span>{{ item.label }}</span>
                  </RouterLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton as-child :is-active="route.path === '/settings'" tooltip="Settings">
              <RouterLink to="/settings">
                <SettingsIcon />
                <span>Settings</span>
              </RouterLink>
            </SidebarMenuButton>
            <SidebarMenuBadge v-if="updateAvailable">Update</SidebarMenuBadge>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Sign out" @click="signOut">
              <LogOutIcon />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>

    <SidebarInset>
      <header class="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger class="-ml-1" />
        <Separator orientation="vertical" class="mr-2 h-4! self-center!" />
        <h1 class="text-sm font-medium">{{ section?.label ?? route.name }}</h1>
        <div class="flex-1" />
        <TasksMenu />
        <Button
          variant="ghost"
          size="icon"
          :aria-label="mode === 'dark' ? 'Use light theme' : 'Use dark theme'"
          @click="mode = mode === 'dark' ? 'light' : 'dark'"
        >
          <SunIcon v-if="mode === 'dark'" />
          <MoonIcon v-else />
        </Button>
      </header>
      <main class="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 md:p-6">
        <Tabs v-if="section && section.tabs.length > 1" :model-value="route.path" @update:model-value="goTo">
          <TabsList class="max-w-full overflow-x-auto">
            <TabsTrigger v-for="tab in section.tabs" :key="tab.to" :value="tab.to" class="px-3">
              <component :is="tab.icon" />
              {{ tab.label }}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <RouterView />
      </main>
    </SidebarInset>
  </SidebarProvider>
</template>
