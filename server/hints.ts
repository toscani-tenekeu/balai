import { existsSync, readdirSync } from 'node:fs'
import { listApps } from './apps.ts'
import { listServices } from './services.ts'
import { has, lines, readText, run } from './sys.ts'

/**
 * What a service is for, in a few words, so the Services and Processes pages say at a glance what matters
 * and what is useless on this server.
 */
export interface Hint {
  role: 'system' | 'site' | 'app' | 'unneeded' | 'unused'
  label: string
  detail: string
}

/** Units the machine itself needs to boot, log in, keep time and reach the network. */
const PLUMBING = /^(systemd-|dbus|getty@|serial-getty@|user@|user-runtime-dir@|ssh|sshd|cron|crond|rsyslog|polkit|udev|networking|netplan|cloud-|apparmor|auditd|chrony|ntp|irqbalance|lvm2|blk-availability|kmod|ldconfig|setvtrgb|console-setup|keyboard-setup|finalrd|plymouth|snapd|unattended-upgrades|apt-daily|e2scrub|logrotate|man-db|fstrim|dpkg-db-backup|motd-news|ua-|ubuntu-advantage|grub-|emergency|rescue|initrd-|sysstat|multipathd\.socket)/

interface Rule {
  label: string
  why: string
  /** True when the service really has nothing to do on this machine. */
  useless: () => Promise<boolean> | boolean
}

const virt = async () => (has('systemd-detect-virt') ? (await run(['systemd-detect-virt'])).stdout.trim() : 'none')
const none = (dir: string, match?: RegExp) => {
  try {
    return readdirSync(dir).filter((name) => !match || match.test(name)).length === 0
  } catch {
    return true
  }
}
const wireless = () => {
  try {
    return readdirSync('/sys/class/net').some((name) => existsSync(`/sys/class/net/${name}/wireless`))
  } catch {
    return false
  }
}

let nginxText: string | null = null
async function webConfig(): Promise<string> {
  if (nginxText !== null) return nginxText
  const parts: string[] = []
  if (has('nginx')) parts.push((await run(['nginx', '-T'], { timeout: 20_000 })).stdout)
  for (const dir of ['/etc/apache2/sites-enabled', '/etc/httpd/conf.d', '/etc/caddy']) {
    try {
      for (const name of readdirSync(dir)) parts.push(readText(`${dir}/${name}`))
    } catch {
      // Not there.
    }
  }
  nginxText = parts.join('\n')
  setTimeout(() => (nginxText = null), 60_000)
  return nginxText
}

const RULES: [RegExp, Rule][] = [
  [/^ModemManager\.service$/, { label: 'Not needed on a server', why: 'It talks to mobile broadband modems, and this server has none.', useless: () => none('/dev', /^(cdc-wdm|ttyUSB|ttyACM)/) }],
  [/^avahi-daemon\.(service|socket)$/, { label: 'Not needed on a server', why: 'It announces the machine on a local network (mDNS) and keeps a port open for it. Servers are reached by name or address instead.', useless: () => true }],
  [/^(cups|cups-browsed)\.service$/, { label: 'Not needed on a server', why: 'It runs printing, and nothing prints from this server.', useless: () => true }],
  [/^bluetooth\.service$/, { label: 'Not needed on a server', why: 'This server has no Bluetooth.', useless: () => none('/sys/class/bluetooth') }],
  [/^wpa_supplicant\.service$/, { label: 'Not needed on a server', why: 'It connects to Wi-Fi networks, and this server has no wireless card.', useless: () => !wireless() }],
  [/^(accounts-daemon|rtkit-daemon|udisks2|colord|upower|power-profiles-daemon|switcheroo-control|thermald|packagekit|whoopsie|kerneloops)\.service$/, { label: 'Not needed on a server', why: 'It serves desktops and laptops (login screens, sound, USB drives, batteries, desktop updates). A server does not use it.', useless: () => true }],
  [/^fwupd\.service$/, { label: 'Not needed here', why: 'It updates hardware firmware. A virtual server has no firmware of its own to update.', useless: async () => (await virt()) !== 'none' }],
  [/^(open-vm-tools|vgauth)\.service$/, { label: 'Not needed here', why: 'These are tools for VMware virtual machines, and this server does not run on VMware.', useless: async () => (await virt()) !== 'vmware' }],
  [/^(smartmontools|smartd)\.service$/, { label: 'Not needed here', why: 'It watches the health of physical disks. The disks of a virtual server report no health data.', useless: async () => (await virt()) !== 'none' }],
  [/^lm-sensors\.service$/, { label: 'Not needed here', why: 'It reads temperature sensors, and a virtual server has none.', useless: async () => (await virt()) !== 'none' }],
  [/^(iscsid|open-iscsi)\.service$/, { label: 'Not used', why: 'It connects to network storage (iSCSI), and no such disk is connected.', useless: () => none('/sys/class/iscsi_session') }],
  [/^multipathd\.service$/, { label: 'Not used', why: 'It manages disks reached through several paths (SAN storage), and this server has none.', useless: async () => !has('multipath') || !(await run(['multipath', '-l'])).stdout.trim() }],
  [/^(libvirtd|virtlogd|virtlockd|libvirt-guests|virtqemud)\.service$/, {
    label: 'Not used', why: 'It runs virtual machines with libvirt, and there are none.',
    useless: async () => !has('virsh') || !lines((await run(['virsh', 'list', '--all', '--name'], { timeout: 15_000 })).stdout).length,
  }],
  [/^(docker|containerd)\.service$/, {
    label: 'Not used', why: 'Docker is running but has no containers and no images.',
    useless: async () => !has('docker') || (!lines((await run(['docker', 'ps', '-aq'])).stdout).length && !lines((await run(['docker', 'image', 'ls', '-q'])).stdout).length),
  }],
]

let cache: { at: number; hints: Record<string, Hint> } | null = null

export async function serviceHints(): Promise<Record<string, Hint>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.hints
  const [services, apps, text] = await Promise.all([listServices(), listApps().catch(() => []), webConfig()])
  const hints: Record<string, Hint> = {}
  for (const service of services) {
    const name = service.name.endsWith('.service') ? service.name : `${service.name}.service`
    const app = apps.find((item) => item.units.includes(name))

    // PHP-FPM: each version is used only if a site's settings point at its socket.
    const php = name.match(/^php([\d.]+)-fpm\.service$/)
    if (php && text) {
      const used = text.includes(`php${php[1]}-fpm`) || (text.includes('php-fpm.sock') && !text.match(/php\d/))
      if (!used) {
        hints[service.name] = { role: 'unneeded', label: 'Not used', detail: `No website on this server sends PHP pages to PHP ${php[1]}. Stop and disable it to free its memory.` }
        continue
      }
    }

    const rule = RULES.find(([pattern]) => pattern.test(name))
    if (rule && (await rule[1].useless())) {
      hints[service.name] = {
        role: 'unneeded',
        label: rule[1].label,
        detail: `${rule[1].why}${service.active === 'active' ? ' It can be stopped and disabled.' : ''}`,
      }
      continue
    }

    if (app?.sites.length) {
      hints[service.name] = {
        role: 'site',
        label: app.sites.length === 1 ? `Runs ${app.sites[0]}` : `Runs ${app.sites.length} websites`,
        detail: `Websites: ${app.sites.join(', ')}. Stopping it takes them offline.`,
      }
      continue
    }
    if (PLUMBING.test(name) || app?.group === 'system') {
      hints[service.name] = { role: 'system', label: 'Needed by the system', detail: 'The server needs it to start, log in, keep time or reach the network.' }
      continue
    }
    if (app) {
      hints[service.name] = {
        role: 'app',
        label: app.kind === 'service' ? 'Your app' : `Part of ${app.name}`,
        detail: app.kind === 'service' ? 'A service of your own.' : `Installed with ${app.name}${app.group === 'default' ? ', which came with the system' : ''}.`,
      }
      continue
    }
    if (service.active !== 'active' && service.enabled === 'disabled') {
      hints[service.name] = { role: 'unused', label: 'Not used', detail: 'It is stopped and does not start at boot.' }
    }
  }
  cache = { at: Date.now(), hints }
  return hints
}

/** Where a process comes from: the service it belongs to, or a login session. */
export function originOf(pid: number): { unit: string | null; session: boolean } {
  const cgroup = readText(`/proc/${pid}/cgroup`)
  const unit = cgroup.match(/\/([^/\n]+\.service)(?:\/[^\n]*)?$/m)?.[1] ?? cgroup.match(/\/openrc\.([^/\n]+)/m)?.[1] ?? null
  return { unit, session: !unit && /session-\d+\.scope/.test(cgroup) }
}
