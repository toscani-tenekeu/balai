<script setup lang="ts">
import { useColorMode } from '@vueuse/core'
import ConnectionNotice from '@/components/ConnectionNotice.vue'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import 'vue-sonner/style.css'

const mode = useColorMode()
</script>

<template>
  <TooltipProvider>
    <RouterView />
  </TooltipProvider>
  <ConnectionNotice />
  <Toaster :theme="mode === 'dark' ? 'dark' : 'light'" position="bottom-right" />
</template>
