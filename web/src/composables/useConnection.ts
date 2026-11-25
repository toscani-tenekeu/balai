import { ref } from 'vue'

/** online: all good. offline: this device has no network. unreachable: the network is up but the server does not answer. */
export type Connection = 'online' | 'offline' | 'unreachable'

export const connection = ref<Connection>(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'online')

/** Called by every request: a failed connection marks the server unreachable, any answer marks it reachable again. */
export function reportRequest(reached: boolean) {
  if (reached) {
    if (connection.value === 'unreachable') connection.value = 'online'
    return
  }
  if (connection.value === 'online') connection.value = navigator.onLine ? 'unreachable' : 'offline'
}

let watching = false
let timer: ReturnType<typeof setTimeout> | undefined

/** Asks the server again every few seconds while it is out of reach. */
async function probe() {
  clearTimeout(timer)
  if (connection.value === 'online') return
  if (!navigator.onLine) {
    connection.value = 'offline'
  } else {
    try {
      const response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' })
      connection.value = response.ok || response.status === 401 ? 'online' : 'unreachable'
    } catch {
      connection.value = 'unreachable'
    }
  }
  if (connection.value !== 'online') timer = setTimeout(probe, 4000)
}

export function retryNow() {
  void probe()
}

export function watchConnection() {
  if (watching) return
  watching = true
  window.addEventListener('offline', () => {
    connection.value = 'offline'
    void probe()
  })
  window.addEventListener('online', () => void probe())
}

/** Starts asking the server again whenever the connection is lost. */
export function startProbing() {
  void probe()
}
