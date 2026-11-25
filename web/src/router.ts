import { createRouter, createWebHistory } from 'vue-router'
import { loadSession, signedIn } from '@/composables/useSession'
import { whenSignedOut } from '@/lib/api'

export const pages = [
  { path: '/', name: 'Overview', component: () => import('@/pages/Overview.vue') },
  { path: '/apps', name: 'Apps', component: () => import('@/pages/Apps.vue') },
  { path: '/processes', name: 'Processes', component: () => import('@/pages/Processes.vue') },
  { path: '/services', name: 'Services', component: () => import('@/pages/Services.vue') },
  { path: '/cleanup', name: 'Cleanup', component: () => import('@/pages/Cleanup.vue') },
  { path: '/disk', name: 'Disk', component: () => import('@/pages/Disk.vue') },
  { path: '/files', name: 'Files', component: () => import('@/pages/Files.vue') },
  { path: '/packages', name: 'Packages', component: () => import('@/pages/Packages.vue') },
  { path: '/ports', name: 'Ports', component: () => import('@/pages/Ports.vue') },
  { path: '/activity', name: 'Activity', component: () => import('@/pages/Activity.vue') },
  { path: '/settings', name: 'Settings', component: () => import('@/pages/Settings.vue') },
]

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'Sign in', component: () => import('@/pages/Login.vue'), meta: { open: true } },
    { path: '/setup', name: 'Setup', component: () => import('@/pages/Setup.vue'), meta: { open: true } },
    {
      path: '/',
      component: () => import('@/components/AppLayout.vue'),
      children: pages,
    },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.open) return true
  if (signedIn.value === null) await loadSession()
  return signedIn.value ? true : { path: '/login' }
})

router.afterEach((to) => {
  document.title = to.name ? `${String(to.name)} · Balai` : 'Balai'
})

whenSignedOut(() => {
  signedIn.value = false
  if (!router.currentRoute.value.meta.open) void router.push('/login')
})
