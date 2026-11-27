// scripts/sync.js
import fs from 'node:fs/promises';
import path from 'node:path';

const COMMON_FILES_DIR = path.resolve(
  process.env.APPDATA || '',
  'MetaQuotes/Terminal/Common/Files'
);
const PUBLIC_DIR = path.resolve('public');

const SOURCE_BIAS_FILE = path.resolve('Common\Files\trade_log.csv');
const COMMON_BIAS_FILE = path.join(COMMON_FILES_DIR, 'news_bias.txt');
const COMMON_TRADE_LOG = path.join(COMMON_FILES_DIR, 'trade_log.csv');

async function copyIfExists(src, dest, label, required = false) {
  try {
    await fs.access(src);
  } catch {
    if (required) {
      throw new Error(`Missing required ${label} at: ${src}`);
    }
    console.log(`Optional ${label} not found at ${src} (skipping).`);
    return false;
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tempDest = `${dest}.tmp`;
  await fs.copyFile(src, tempDest);
  await fs.rename(tempDest, dest);
  console.log(`Synced ${label}: ${src} -> ${dest}`);
  return true;
}

async function syncFiles() {
  console.log('Starting file synchronization...');

  // 1. Optional: sync analyzer output to Common\Files/news_bias.txt if present
  try {
    await fs.access(SOURCE_BIAS_FILE);
    const content = await fs.readFile(SOURCE_BIAS_FILE, 'utf8');
    await fs.mkdir(COMMON_FILES_DIR, { recursive: true });
    const tempBias = `${COMMON_BIAS_FILE}.tmp`;
    await fs.writeFile(tempBias, content, 'utf8');
    await fs.rename(tempBias, COMMON_BIAS_FILE);
    console.log(`Synced ${SOURCE_BIAS_FILE} -> ${COMMON_BIAS_FILE}`);
  } catch {
    console.log(`No local analyzer file at ${SOURCE_BIAS_FILE}; keeping existing Common/Files state.`);
  }

  // 2. Copy trade_log.csv from MT5 Common\Files into public/ for the dashboard
  await copyIfExists(
    COMMON_TRADE_LOG,
    path.join(PUBLIC_DIR, 'trade_log.csv'),
    'trade_log.csv',
    true
  );

  // 3. Optional: copy news_bias.txt into public/ in case the dashboard displays bias status
  await copyIfExists(
    COMMON_BIAS_FILE,
    path.join(PUBLIC_DIR, 'news_bias.txt'),
    'news_bias.txt',
    false
  );

  console.log('File synchronization completed successfully.');
}

syncFiles().catch((err) => {
  console.error('File synchronization failed:', err);
  process.exit(1);
});