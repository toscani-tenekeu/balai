<script setup lang="ts">
import { ExternalLinkIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import UseBadge from '@/components/files/UseBadge.vue'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { bytes, dateTime } from '@/lib/format'
import type { FileUse, FoundFile } from '@/lib/types'

const props = defineProps<{ file: FoundFile | null; use: FileUse | null; checking: boolean }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ delete: [file: FoundFile] }>()

const IMAGES = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i
const image = computed(() => (props.file && IMAGES.test(props.file.path) ? props.file : null))
const previewFailed = ref(false)
watch(() => props.file?.path, () => (previewFailed.value = false))

const name = computed(() => props.file?.path.split('/').pop() ?? '')
const folder = computed(() => props.file?.path.slice(0, props.file.path.lastIndexOf('/')) || '/')
const gitLabel = { tracked: 'kept in git', untracked: 'not committed to git', ignored: 'ignored by git' } as const
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent v-if="file" class="w-full gap-0 overflow-y-auto sm:max-w-lg">
      <SheetHeader>
        <SheetTitle class="pr-6 break-all">{{ name }}</SheetTitle>
        <SheetDescription class="font-mono text-xs break-all">{{ folder }}</SheetDescription>
      </SheetHeader>

      <div class="flex flex-col gap-5 px-4 pb-4">
        <div v-if="image && !previewFailed" class="bg-muted flex justify-center overflow-hidden rounded-lg border p-2">
          <img
            :src="`/api/files/preview?path=${encodeURIComponent(image.path)}`"
            :alt="`Preview of ${name}`"
            class="max-h-64 max-w-full object-contain"
            @error="previewFailed = true"
          />
        </div>

        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt class="text-muted-foreground">Size</dt>
          <dd class="tabular-nums">{{ bytes(file.size) }}</dd>
          <dt class="text-muted-foreground">Last changed</dt>
          <dd>{{ dateTime(file.modified) }}</dd>
          <template v-if="use?.project">
            <dt class="text-muted-foreground">Project</dt>
            <dd class="break-all">
              <span class="font-mono text-xs">{{ use.project.root }}</span>
              <span v-if="use.project.git" class="text-muted-foreground">, {{ gitLabel[use.project.git] }}</span>
            </dd>
          </template>
          <template v-if="use?.requests">
            <dt class="text-muted-foreground">Visits</dt>
            <dd>
              {{ use.requests.count }} {{ use.requests.count === 1 ? 'request' : 'requests' }}
              <span v-if="use.requests.since" class="text-muted-foreground">since {{ dateTime(use.requests.since) }}</span>
              <span v-if="use.requests.last" class="text-muted-foreground">, last on {{ dateTime(use.requests.last) }}</span>
            </dd>
          </template>
        </dl>

        <Separator />

        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-medium">Where it is used</h3>
          <template v-if="use">
            <UseBadge :use="use" class="self-start" />
            <ul class="text-muted-foreground flex list-disc flex-col gap-1 pl-5 text-sm">
              <li v-for="reason in use.reasons" :key="reason" class="break-words">{{ reason }}</li>
            </ul>
            <Button v-if="use.site" variant="outline" size="sm" class="self-start" as-child>
              <a :href="use.site.url" target="_blank" rel="noreferrer noopener">
                <ExternalLinkIcon data-icon="inline-start" />
                Open on {{ use.site.name }}
              </a>
            </Button>
          </template>
          <div v-else-if="checking" class="flex flex-col gap-2">
            <Skeleton class="h-5 w-40" />
            <Skeleton class="h-4 w-full" />
          </div>
          <p v-else class="text-muted-foreground text-sm">Not checked.</p>
        </section>

        <section v-if="use?.references.length" class="flex flex-col gap-2">
          <h3 class="text-sm font-medium">
            Referred to in
            <span class="text-muted-foreground font-normal">({{ use.referenceCount }})</span>
          </h3>
          <ul class="bg-muted max-h-56 overflow-y-auto rounded-md border p-3 font-mono text-xs">
            <li v-for="entry in use.references" :key="`${entry.file}:${entry.line}`" class="break-all">
              {{ entry.file }}<span class="text-muted-foreground">:{{ entry.line }}</span>
            </li>
            <li v-if="use.referenceCount > use.references.length" class="text-muted-foreground font-sans">
              and {{ use.referenceCount - use.references.length }} more
            </li>
          </ul>
          <p class="text-muted-foreground text-xs">Matched by file name, so a file with the same name elsewhere in the folder counts too.</p>
        </section>

        <section v-if="use?.copyOf" class="flex flex-col gap-1">
          <h3 class="text-sm font-medium">Live copy</h3>
          <p class="font-mono text-xs break-all">{{ use.copyOf }}</p>
        </section>
      </div>

      <SheetFooter v-if="!file.locked" class="border-t">
        <Button variant="destructive" @click="emit('delete', file)">
          <Trash2Icon data-icon="inline-start" />
          Delete this file
        </Button>
      </SheetFooter>
      <SheetFooter v-else class="border-t">
        <p class="text-muted-foreground text-sm">This file belongs to the system and cannot be deleted from here.</p>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
