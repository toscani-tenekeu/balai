import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const root = resolve(import.meta.dir, '..')

export const config = {
  host: process.env.BALAI_HOST ?? '127.0.0.1',
  port: Number(process.env.BALAI_PORT ?? 7070),
  /** Public address, used only to print the setup link. */
  url: process.env.BALAI_URL ?? '',
  dataDir: resolve(process.env.BALAI_DATA ?? join(root, 'data')),
  webDir: join(root, 'web', 'dist'),
  sessionDays: 7,
  sampleEverySeconds: 60,
  keepSamplesDays: 7,
  keepActivityDays: 90,
}

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
