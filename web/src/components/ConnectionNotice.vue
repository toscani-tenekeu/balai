<script setup lang="ts">
import { WifiOffIcon, ServerOffIcon } from '@lucide/vue'
import { computed, onMounted, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { connection, retryNow, startProbing, watchConnection } from '@/composables/useConnection'

const lost = computed(() => connection.value !== 'online')

onMounted(watchConnection)
watch(connection, (now, before) => {
  if (now !== 'online') startProbing()
  else if (before !== 'online') toast.success('Connection restored. The panel is up to date again.')
})
</script>

<template>
  <!-- Cannot be closed by hand: it goes away by itself once the panel answers again. -->
  <Dialog :open="lost">
    <DialogContent :show-close-button="false" class="sm:max-w-md" @interact-outside.prevent @escape-key-down.prevent>
      <DialogHeader>
        <div class="bg-muted mb-2 flex size-10 items-center justify-center rounded-full">
          <WifiOffIcon v-if="connection === 'offline'" class="size-5" />
          <ServerOffIcon v-else class="size-5" />
        </div>
        <DialogTitle>{{ connection === 'offline' ? 'You are offline' : 'The server is not answering' }}</DialogTitle>
        <DialogDescription>
          <template v-if="connection === 'offline'">
            This device has lost its network connection. The panel reconnects by itself as soon as it is back.
          </template>
          <template v-else>
            The panel cannot reach the server. It may be restarting after an update, or the network between you is down.
            Work already started on the server carries on.
          </template>
        </DialogDescription>
      </DialogHeader>
      <DialogFooter class="items-center sm:justify-between">
        <span class="text-muted-foreground flex items-center gap-2 text-sm">
          <Spinner />
          Trying again every few seconds
        </span>
        <Button variant="outline" @click="retryNow">Try now</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
