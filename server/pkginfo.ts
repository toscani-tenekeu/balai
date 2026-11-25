import { existsSync } from 'node:fs'
import { backend, type InstalledPackage } from './pm.ts'
import { lines, readText, run } from './sys.ts'

/**
 * What the Apps page needs to know about packages, for each package manager:
 * the files a package installed, who owns a file, what depends on a package,
 * which packages form one app, and which ones came with the system.
 */

const id = () => backend?.id ?? null

/** Files a package installed. */
export async function packageFiles(name: string): Promise<string[]> {
  switch (id()) {
    case 'apt': {
      const base = name.split(':')[0]!
      for (const file of [`/var/lib/dpkg/info/${name}.list`, `/var/lib/dpkg/info/${base}.list`]) {
        if (existsSync(file)) return lines(readText(file))
      }
      // Architecture-qualified names (libc6:amd64) keep their list under that name.
      const found = await run(['dpkg-query', '-L', name], { timeout: 30_000 })
      return lines(found.stdout).filter((line) => line.startsWith('/'))
    }
    case 'dnf':
    case 'yum':
    case 'zypper':
      return lines((await run(['rpm', '-ql', name], { timeout: 30_000 })).stdout).filter((line) => line.startsWith('/'))
    case 'pacman':
      return lines((await run(['pacman', '-Qlq', name], { timeout: 30_000 })).stdout)
    case 'apk':
      return lines((await run(['apk', 'info', '-L', name], { timeout: 30_000 })).stdout)
        .filter((line) => !line.endsWith(':') && line.trim())
        .map((line) => `/${line.trim()}`)
    default:
      return []
  }
}

/** The package that installed each file, for the files a package manager knows. */
export async function ownersOf(files: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>()
  if (!files.length) return owners
  switch (id()) {
    case 'apt': {
      // With merged /usr, systemd reports /usr/lib/… where dpkg recorded /lib/…, so both spellings are asked.
      const alias = (file: string) => (file.startsWith('/usr/lib/') ? file.slice(4) : file.startsWith('/lib/') ? `/usr${file}` : file)
      const result = await run(['dpkg-query', '-S', ...new Set(files.flatMap((file) => [file, alias(file)]))], { timeout: 30_000 })
      for (const line of lines(result.stdout)) {
        const match = line.match(/^(.+?): (\/.*)$/)
        if (!match) continue
        const name = match[1]!.split(', ')[0]!.split(':')[0]!
        owners.set(match[2]!, name)
        owners.set(alias(match[2]!), name)
      }
      break
    }
    case 'dnf':
    case 'yum':
    case 'zypper': {
      for (const file of files) {
        const result = await run(['rpm', '-qf', '--qf', '%{NAME}\\n', file], { timeout: 15_000 })
        if (result.ok) owners.set(file, result.stdout.trim().split('\n')[0]!)
      }
      break
    }
    case 'pacman': {
      for (const file of files) {
        const result = await run(['pacman', '-Qqo', file], { timeout: 15_000 })
        if (result.ok) owners.set(file, result.stdout.trim())
      }
      break
    }
    case 'apk': {
      for (const file of files) {
        const result = await run(['apk', 'info', '-q', '--who-owns', file], { timeout: 15_000 })
        const name = result.stdout.trim().split(/\s+/)[0]
        if (result.ok && name) owners.set(file, name.replace(/-\d[^-]*-r\d+$/, ''))
      }
      break
    }
  }
  return owners
}

/** Installed packages that depend on each of the given ones. */
export async function requiredBy(names: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (!names.length) return result
  switch (id()) {
    case 'apt': {
      const out = await run(
        ['apt-cache', 'rdepends', '--installed', '--no-recommends', '--no-suggests', '--no-enhances', '--no-conflicts',
          '--no-breaks', '--no-replaces', ...names],
        { timeout: 60_000 },
      )
      let current = ''
      for (const raw of out.stdout.split('\n')) {
        if (!raw.trim()) continue
        if (!raw.startsWith(' ') && raw.trim() !== 'Reverse Depends:') {
          current = raw.trim()
          result.set(current, [])
        } else if (raw.startsWith(' ') && current) {
          const name = raw.trim().replace(/^\|/, '').split(':')[0]!
          if (name && name !== current && !result.get(current)!.includes(name)) result.get(current)!.push(name)
        }
      }
      break
    }
    case 'dnf':
    case 'yum':
    case 'zypper':
      for (const name of names) {
        const out = await run(['rpm', '-q', '--whatrequires', '--qf', '%{NAME}\\n', name], { timeout: 30_000 })
        result.set(name, out.ok ? [...new Set(lines(out.stdout))] : [])
      }
      break
    case 'pacman': {
      const out = await run(['pacman', '-Qi', ...names], { timeout: 30_000 })
      for (const block of out.stdout.split(/\n\s*\n/)) {
        const name = block.match(/^Name\s*:\s*(.*)$/m)?.[1]?.trim()
        const by = block.match(/^Required By\s*:\s*(.*)$/m)?.[1]?.trim()
        if (name) result.set(name, by && by !== 'None' ? by.split(/\s+/) : [])
      }
      break
    }
    case 'apk':
      for (const name of names) {
        const out = await run(['apk', 'info', '-r', name], { timeout: 30_000 })
        result.set(name, lines(out.stdout).filter((line) => !line.endsWith(':')))
      }
      break
  }
  return result
}

/** The source each package was built from, so related packages (docker-ce, docker-ce-cli…) form one app. */
export async function sourcesOf(): Promise<Map<string, string>> {
  const sources = new Map<string, string>()
  switch (id()) {
    case 'apt': {
      const out = await run(['dpkg-query', '-W', '-f=${binary:Package}\\t${source:Package}\\n'], { timeout: 30_000 })
      for (const line of lines(out.stdout)) {
        const [name, source] = line.split('\t')
        if (name && source) sources.set(name, source)
      }
      break
    }
    case 'dnf':
    case 'yum':
    case 'zypper': {
      const out = await run(['rpm', '-qa', '--qf', '%{NAME}\\t%{SOURCERPM}\\n'], { timeout: 60_000 })
      for (const line of lines(out.stdout)) {
        const [name, rpm] = line.split('\t')
        if (name && rpm && rpm !== '(none)') sources.set(name, rpm.replace(/-[^-]+-[^-]+\.src\.rpm$/, ''))
      }
      break
    }
  }
  return sources
}

/**
 * Packages that came with the system rather than being added later.
 * Debian and Ubuntu: what the installed meta packages (ubuntu-server, task-…) pull in.
 * Elsewhere: what was installed in the first hour of the system's life.
 */
export async function shippedWithSystem(installed: InstalledPackage[]): Promise<Set<string>> {
  const shipped = new Set<string>()
  switch (id()) {
    case 'apt': {
      const metas = installed
        .map((item) => item.name.split(':')[0]!)
        .filter((name) => /^(ubuntu-(server|minimal|standard|cloud-minimal|server-minimal|desktop)|task-|debian-|linuxmint-|mint-meta-)/.test(name))
      for (const name of metas) shipped.add(name)
      if (metas.length) {
        const out = await run(
          ['apt-cache', 'depends', '--installed', '--no-suggests', '--no-conflicts', '--no-breaks', '--no-replaces',
            '--no-enhances', ...metas],
          { timeout: 60_000 },
        )
        for (const line of lines(out.stdout)) {
          const match = line.match(/^\|?(Depends|Recommends|PreDepends):\s+<?([^\s>]+)>?/)
          if (match) shipped.add(match[2]!.split(':')[0]!)
        }
      }
      // The cloud and installer tools of a fresh system.
      for (const name of ['cloud-init', 'openssh-server', 'ssh-import-id', 'shim-signed', 'grub-pc', 'grub-efi-amd64',
        'linux-virtual', 'linux-generic', 'linux-image-generic']) shipped.add(name)
      // Priority "standard" is the Debian base set.
      const priorities = await run(['dpkg-query', '-W', '-f=${binary:Package}\\t${Priority}\\n'], { timeout: 30_000 })
      for (const line of lines(priorities.stdout)) {
        const [name, priority] = line.split('\t')
        if (name && priority === 'standard') shipped.add(name.split(':')[0]!)
      }
      break
    }
    case 'dnf':
    case 'yum':
    case 'zypper': {
      const out = await run(['rpm', '-qa', '--qf', '%{NAME}\\t%{INSTALLTIME}\\n'], { timeout: 60_000 })
      firstHour(lines(out.stdout).map((line) => line.split('\t')).map(([name, time]) => [name!, Number(time) * 1000]), shipped)
      break
    }
    case 'pacman': {
      const out = await run(['pacman', '-Qi'], { timeout: 60_000 })
      const times: [string, number][] = []
      for (const block of out.stdout.split(/\n\s*\n/)) {
        const name = block.match(/^Name\s*:\s*(.*)$/m)?.[1]?.trim()
        const date = block.match(/^Install Date\s*:\s*(.*)$/m)?.[1]?.trim()
        if (name && date) times.push([name, Date.parse(date)])
      }
      firstHour(times, shipped)
      break
    }
    case 'apk': {
      // Packages the user asked for are listed in /etc/apk/world; the base system is alpine-base and what it needs.
      shipped.add('alpine-base')
      const out = await run(['apk', 'info', '-R', 'alpine-base'], { timeout: 30_000 })
      for (const line of lines(out.stdout)) if (!line.endsWith(':')) shipped.add(line.replace(/[<>=].*$/, ''))
      break
    }
  }
  return shipped
}

function firstHour(times: [string, number][], into: Set<string>) {
  const valid = times.filter(([, time]) => Number.isFinite(time) && time > 0)
  if (!valid.length) return
  const first = Math.min(...valid.map(([, time]) => time))
  for (const [name, time] of valid) if (time - first < 3_600_000) into.add(name)
}

/** Packages pinned to their version, which updates leave alone. */
export async function heldPackages(): Promise<Set<string>> {
  switch (id()) {
    case 'apt':
      return new Set(lines((await run(['apt-mark', 'showhold'], { timeout: 30_000 })).stdout))
    case 'dnf':
    case 'yum': {
      const out = await run(['dnf', '-q', 'versionlock', 'list'], { timeout: 30_000 })
      return new Set(lines(out.stdout).map((line) => line.replace(/^\d+:/, '').replace(/-\d.*$/, '')))
    }
    case 'pacman': {
      const ignored = readText('/etc/pacman.conf').match(/^\s*IgnorePkg\s*=\s*(.*)$/m)?.[1]
      return new Set(ignored ? ignored.trim().split(/\s+/) : [])
    }
    default:
      return new Set()
  }
}
