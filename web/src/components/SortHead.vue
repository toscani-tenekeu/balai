<script setup lang="ts">
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from '@lucide/vue'
import { TableHead } from '@/components/ui/table'

const props = defineProps<{ label: string; column: string; sortBy: string; descending: boolean; align?: 'right' }>()
const emit = defineEmits<{ sort: [column: string] }>()
</script>

<template>
  <TableHead :class="align === 'right' ? 'text-right' : ''" :aria-sort="sortBy === column ? (descending ? 'descending' : 'ascending') : 'none'">
    <button
      type="button"
      class="hover:text-foreground inline-flex items-center gap-1"
      :class="align === 'right' ? 'flex-row-reverse' : ''"
      :title="`Sort by ${label.toLowerCase()}`"
      @click="emit('sort', props.column)"
    >
      {{ label }}
      <ArrowDownIcon v-if="sortBy === column && descending" class="size-3" />
      <ArrowUpIcon v-else-if="sortBy === column" class="size-3" />
      <ArrowUpDownIcon v-else class="text-muted-foreground/60 size-3" />
    </button>
  </TableHead>
</template>
