import { existsSync } from 'node:fs'
import { has, readText } from './sys.ts'

export type PackageManagerId = 'apt' | 'dnf' | 'yum' | 'zypper' | 'pacman' | 'apk'
export type InitId = 'systemd' | 'openrc'

function osRelease(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of readText('/etc/os-release').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (match) values[match[1]!] = match[2]!.replace(/^["']|["']$/g, '')
  }
  return values
}

function detectManager(): PackageManagerId | null {
  if (has('apt-get') && has('dpkg-query')) return 'apt'
  if (has('dnf')) return 'dnf'
  if (has('yum')) return 'yum'
  if (has('zypper')) return 'zypper'
  if (has('pacman')) return 'pacman'
  if (has('apk')) return 'apk'
  return null
}

function detectInit(): InitId | null {
  if (existsSync('/run/systemd/system') && has('systemctl')) return 'systemd'
  if (has('rc-service') && has('rc-status')) return 'openrc'
  return null
}

const release = osRelease()

/** What kind of system Balai runs on, worked out once at start-up. */
export const platform = {
  name: release.PRETTY_NAME || release.NAME || 'Linux',
  id: release.ID ?? '',
  manager: detectManager(),
  init: detectInit(),
}
