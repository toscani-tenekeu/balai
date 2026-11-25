<script setup lang="ts">
import { CircleCheckIcon, CircleDashedIcon, CircleMinusIcon, GlobeIcon, PackageIcon, ShieldIcon } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Hint } from '@/lib/types'

defineProps<{ hint: Hint }>()
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Badge
        :variant="hint.role === 'unneeded' ? 'destructive' : hint.role === 'site' || hint.role === 'app' ? 'secondary' : 'outline'"
        class="max-w-56 cursor-default"
      >
        <CircleMinusIcon v-if="hint.role === 'unneeded'" />
        <GlobeIcon v-else-if="hint.role === 'site'" />
        <PackageIcon v-else-if="hint.role === 'app'" />
        <ShieldIcon v-else-if="hint.role === 'system'" />
        <CircleDashedIcon v-else-if="hint.role === 'unused'" />
        <CircleCheckIcon v-else />
        <span class="truncate">{{ hint.label }}</span>
      </Badge>
    </TooltipTrigger>
    <TooltipContent class="max-w-xs">{{ hint.detail }}</TooltipContent>
  </Tooltip>
</template>
