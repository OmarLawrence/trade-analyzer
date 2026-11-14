import Parser from 'rss-parser';
import { createHash } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './config/firebase.js'; // .js extension required by NodeNext

const parser = new Parser();

const RSS_FEEDS = [
  'https://xml.fxstreet.com/news/forex-news/index.xml',
  'https://www.investing.com/rss/news_25.rss', // Forex News
  'https://www.investing.com/rss/news_301.rss', // Commodities / Gold (XAU)
];

// The five monitored pairs (keep in sync with analyzer.ts)
const ALL_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCAD', 'XAUUSD'];

// Pair-specific keywords (text is upper-cased before matching)
const PAIR_PATTERNS: Record<string, RegExp> = {
  EURUSD: /\b(EUR|EURO|EUR\/USD)\b/,
  GBPUSD: /\b(GBP|POUND|STERLING|GBP\/USD)\b/,
  USDJPY: /\b(JPY|YEN|BANK OF JAPAN|USD\/JPY)\b/,
  USDCAD: /\b(CAD|CANADIAN|LOONIE|USD\/CAD)\b/,
  XAUUSD: /\b(GOLD|XAU|BULLION|XAU\/USD)\b/,
};

// US-dollar-wide drivers: these move all five pairs, so they tag every pair.
// "DOLLAR" is ignored when it belongs to another currency (Canadian dollar, etc.).
const USD_DRIVER_PATTERN =
  /(?<!CANADIAN |AUSTRALIAN |AUSSIE |NEW ZEALAND |NZ |KIWI |HONG KONG |SINGAPORE )\bDOLLARS?\b|\b(GREENBACK|DXY|FED|FOMC|FEDERAL RESERVE|POWELL|NONFARM|NON-FARM|NFP)\b/;

interface RawArticle {
  title: string;
  link: string;
  pubDate: string;
  contentSnippet: string;
  matchedPairs: string[];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchAndStoreNews() {
  console.log(`[${new Date().toISOString()}] Starting RSS news ingestion...`);

  // Collect articles keyed by link-hash so duplicates across feeds collapse
  const articles = new Map<string, RawArticle>();
  let usdTagged = 0;

  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);

      for (const item of feed.items ?? []) {
        if (!item.title || !item.link || !item.pubDate) continue;

        const text = `${item.title} ${item.contentSnippet ?? ''}`.toUpperCase();

        const matched = new Set<string>();
        for (const [pair, pattern] of Object.entries(PAIR_PATTERNS)) {
          if (pattern.test(text)) matched.add(pair);
        }

        // Dollar / Fed / NFP style news affects every monitored pair
        if (USD_DRIVER_PATTERN.test(text)) {
          ALL_PAIRS.forEach((p) => matched.add(p));
          usdTagged++;
        }

        if (matched.size === 0) continue;

        const id = createHash('sha1').update(item.link).digest('hex');
        articles.set(id, {
          title: item.title,
          link: item.link,
          pubDate: item.pubDate,
          contentSnippet: item.contentSnippet ?? '',
          matchedPairs: [...matched],
        });
      }
    } catch (error) {
      console.error(`Error fetching feed ${feedUrl}:`, error);
    }
  }

  const collection = db.collection('raw_news');
  let totalSaved = 0;

  for (const ids of chunk([...articles.keys()], 400)) {
    const refs = ids.map((id) => collection.doc(id));
    const existing = await db.getAll(...refs);
    const batch = db.batch();

    existing.forEach((snap, i) => {
      if (snap.exists) return; // already stored
      batch.set(refs[i], {
        ...articles.get(ids[i])!,
        createdAt: FieldValue.serverTimestamp(),
        processed: false,
      });
      totalSaved++;
    });

    await batch.commit();
  }

  console.log(
    `Ingestion complete. ${articles.size} relevant articles found (${usdTagged} via dollar/Fed keywords), saved ${totalSaved} new to Firestore.`
  );
}

fetchAndStoreNews()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });