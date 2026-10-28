import path from 'node:path';

export interface Config {
  port: number;
  dataDir: string;
  dbFile: string;
  screenshotsDir: string;
  updatesDir: string; // desktop installer feed: latest.yml + installer + blockmap, dropped in by the release process
  webSessionHours: number;
  deviceSessionDays: number;
  now: () => number;
  /** DEVELOPMENT ONLY (WEBHOOK_DEV=1): lets webhooks target http and private addresses so they can be tested locally. Never set in production. */
  webhookDev: boolean;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? process.env.TRACKER_DATA_DIR ?? path.resolve(import.meta.dirname, '..', 'data');
  return {
    port: Number(process.env.PORT ?? 4300),
    dataDir,
    dbFile: path.join(dataDir, 'tracker.sqlite'),
    screenshotsDir: path.join(dataDir, 'screenshots'),
    updatesDir: process.env.TRACKER_UPDATES_DIR ?? path.join(dataDir, 'updates'),
    webSessionHours: 12,
    deviceSessionDays: 90,
    now: () => Date.now(),
    webhookDev: process.env.WEBHOOK_DEV === '1',
    ...overrides,
  };
}
