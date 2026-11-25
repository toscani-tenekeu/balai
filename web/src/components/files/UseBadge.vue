<script setup lang="ts">
import { CircleCheckIcon, CircleDashedIcon, CircleHelpIcon } from '@lucide/vue'
import StatusBadge from '@/components/StatusBadge.vue'
import type { FileUse } from '@/lib/types'

defineProps<{ use: FileUse }>()
</script>

<template>
  <StatusBadge :tone="use.use === 'used' ? 'good' : use.use === 'maybe' ? 'warn' : 'idle'" :title="use.reasons.join(' ')">
    <CircleCheckIcon v-if="use.use === 'used'" />
    <CircleHelpIcon v-else-if="use.use === 'maybe'" />
    <CircleDashedIcon v-else />
    {{ use.label }}
  </StatusBadge>
</template>
