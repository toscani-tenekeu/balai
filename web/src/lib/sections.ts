import {
  CpuIcon, FileSearchIcon, HardDriveIcon, HistoryIcon, LayoutDashboardIcon, NetworkIcon, PackageIcon,
  ServerCogIcon, Trash2Icon,
} from '@lucide/vue'
import type { Component } from 'vue'

export interface Tab { to: string; label: string; icon: Component }
export interface Section { id: string; label: string; icon: Component; tabs: Tab[] }

/** The sidebar holds these sections; each page is a tab of one of them (four tabs at most). */
export const sections: Section[] = [
  {
    id: 'overview', label: 'Overview', icon: LayoutDashboardIcon,
    tabs: [
      { to: '/', label: 'Overview', icon: LayoutDashboardIcon },
      { to: '/activity', label: 'Activity', icon: HistoryIcon },
    ],
  },
  {
    id: 'system', label: 'System', icon: CpuIcon,
    tabs: [
      { to: '/processes', label: 'Processes', icon: CpuIcon },
      { to: '/services', label: 'Services', icon: ServerCogIcon },
      { to: '/ports', label: 'Ports', icon: NetworkIcon },
    ],
  },
  {
    id: 'storage', label: 'Storage', icon: HardDriveIcon,
    tabs: [
      { to: '/files', label: 'Files', icon: FileSearchIcon },
      { to: '/cleanup', label: 'Cleanup', icon: Trash2Icon },
      { to: '/disk', label: 'Disk', icon: HardDriveIcon },
    ],
  },
  {
    id: 'packages', label: 'Packages', icon: PackageIcon,
    tabs: [{ to: '/packages', label: 'Packages', icon: PackageIcon }],
  },
]

export const sectionOf = (path: string) => sections.find((s) => s.tabs.some((t) => t.to === path))
