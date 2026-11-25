<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Risk } from '@/lib/types'

defineProps<{ risk: Risk }>()
</script>

<template>
  <Badge v-if="risk.level === 'safe'" variant="outline" class="text-muted-foreground">Safe</Badge>
  <Tooltip v-else>
    <TooltipTrigger as-child>
      <Badge :variant="risk.level === 'blocked' ? 'destructive' : 'secondary'" class="cursor-default">
        {{ risk.level === 'blocked' ? 'Blocked' : 'Check first' }}
      </Badge>
    </TooltipTrigger>
    <TooltipContent class="max-w-xs">
      <ul class="list-disc pl-4">
        <li v-for="reason in risk.reasons" :key="reason">{{ reason }}</li>
      </ul>
    </TooltipContent>
  </Tooltip>
</template>
