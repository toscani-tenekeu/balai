<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

defineProps<{ label: string; destructive?: boolean }>()
defineEmits<{ click: [] }>()
</script>

<template>
  <!-- A visible action in a table row: an icon with its name on hover and for screen readers. -->
  <Tooltip>
    <TooltipTrigger as-child>
      <Button
        variant="ghost"
        size="icon-sm"
        :aria-label="label"
        :class="destructive ? 'text-destructive hover:text-destructive' : 'text-muted-foreground hover:text-foreground'"
        @click="$emit('click')"
      >
        <slot />
      </Button>
    </TooltipTrigger>
    <TooltipContent>{{ label }}</TooltipContent>
  </Tooltip>
</template>
