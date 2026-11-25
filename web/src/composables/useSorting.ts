import { computed, ref, type Ref } from 'vue'

type Value = number | string | null | undefined

/**
 * Sorting for a list: click a column once for one direction, again for the other.
 * Sizes and numbers start largest first; names start from A.
 */
export function useSorting<T>(
  items: () => T[],
  columns: Record<string, (item: T) => Value>,
  initial: { by: string; descending: boolean },
) {
  const sortBy = ref(initial.by)
  const descending = ref(initial.descending)

  const sorted = computed(() => {
    const read = columns[sortBy.value]
    const list = [...items()]
    if (!read) return list
    const direction = descending.value ? -1 : 1
    return list.sort((a, b) => {
      const x = read(a)
      const y = read(b)
      // Unknown values always go last, whatever the direction.
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * direction
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * direction
    })
  })

  function toggle(column: string, textual = false) {
    if (sortBy.value === column) descending.value = !descending.value
    else {
      sortBy.value = column
      descending.value = !textual
    }
  }

  return { sortBy, descending, sorted, toggle } as {
    sortBy: Ref<string>
    descending: Ref<boolean>
    sorted: typeof sorted
    toggle: typeof toggle
  }
}
