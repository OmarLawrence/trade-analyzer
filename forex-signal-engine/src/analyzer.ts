import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';
import type { DocumentReference } from 'firebase-admin/firestore';
import { db } from './config/firebase.js';
import { mkdirSync, writeFileSync, renameSync } from 'fs';
import path from 'path';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Missing GEMINI_API_KEY in .env');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';

const VALID_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'USDCAD'];
const VALID_BIAS = ['BULLISH', 'BEARISH', 'NEUTRAL'];

interface Signal {
  pair: string;
  bias: string;
  confidenceScore: number;
  summaryCatalyst: string;
  suggestedAction: string;
}

// Folder MetaTrader's FILE_COMMON flag reads from. Override with MT_COMMON_FILES in .env if needed.
const MT_DIR =
  process.env.MT_COMMON_FILES ??
  path.join(process.env.APPDATA ?? '', 'MetaQuotes', 'Terminal', 'Common', 'Files');

// Writes a simple text file for the EA:
//   line 1: unix timestamp (seconds, UTC)
//   next lines: PAIR,BIAS,CONFIDENCE,ACTION
function writeSignalsForMetaTrader(signals: Signal[]) {
  try {
    const clean = (s: string) => s.replace(/[,\r\n]+/g, ' ').trim();
    const lines = [
      String(Math.floor(Date.now() / 1000)),
      ...signals.map((s) =>
        [s.pair, s.bias, Math.round(s.confidenceScore), clean(s.suggestedAction)].join(',')
      ),
    ];
    mkdirSync(MT_DIR, { recursive: true });
    const target = path.join(MT_DIR, 'news_bias.txt');
    const tmp = target + '.tmp';
    writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
    renameSync(tmp, target); // swap in one step so the EA never reads a half-written file
    console.log(`Wrote MetaTrader signal file: ${target}`);
  } catch (err) {
    console.error('Could not write MetaTrader signal file:', err);
  }
}

// ---- Free-tier protection -------------------------------------------------
// The free tier allows only a small number of requests per day per model
// (20/day for gemini-3.8-flash at the time of writing; check ai.dev/rate-limit).
// These guards keep the scheduled task from burning the whole day's quota early.
const DAILY_LIMIT = Number(process.env.GEMINI_DAILY_LIMIT ?? 20);
const MIN_INTERVAL_MIN = Number(process.env.GEMINI_MIN_INTERVAL_MIN ?? 90);
const USAGE_DOC = db.collection('system').doc('gemini_usage');

class BudgetExhausted extends Error {}

interface Usage {
  day: string;
  model: string;
  count: number;
  lastCallAt: number;
}

// Google's daily quota resets at midnight Pacific time
function pacificDay(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

async function readUsage(): Promise<Usage> {
  const d = (await USAGE_DOC.get()).data() as Partial<Usage> | undefined;
  const day = pacificDay();
  const lastCallAt = d?.model === MODEL ? d.lastCallAt ?? 0 : 0;
  if (!d || d.day !== day || d.model !== MODEL) return { day, model: MODEL, count: 0, lastCallAt };
  return { day, model: MODEL, count: d.count ?? 0, lastCallAt };
}

// Checked before any other work, so skipped runs cost almost nothing
async function geminiAllowed(): Promise<boolean> {
  const u = await readUsage();
  if (u.count >= DAILY_LIMIT) {
    console.log(`Daily Gemini budget used (${u.count}/${DAILY_LIMIT} for ${MODEL}). Skipping until the quota resets (midnight Pacific).`);
    return false;
  }
  
  // Allow bypassing the interval check if --force or --now is passed as a command-line argument
  const forceRun = process.argv.includes('--force') || process.argv.includes('--now');
  if (forceRun) {
    console.log('Force flag detected — bypassing minimum interval time check.');
    return true;
  }

  /*const sinceMin = (Date.now() - u.lastCallAt) / 60000;
  if (sinceMin < MIN_INTERVAL_MIN) {
    console.log(`Last Gemini call was ${sinceMin.toFixed(0)} min ago (minimum ${MIN_INTERVAL_MIN}). Skipping this run.`);
    return false;
  }*/
  return true;
}

// Counts one request. Every attempt counts, including retries.
async function reserveRequest(): Promise<void> {
  const u = await readUsage();
  if (u.count >= DAILY_LIMIT) {
    throw new BudgetExhausted(`Daily Gemini budget reached (${u.count}/${DAILY_LIMIT}). Stopping.`);
  }
  await USAGE_DOC.set({ day: u.day, model: MODEL, count: u.count + 1, lastCallAt: Date.now() });
}

// Retry on temporary Google-side errors (503 overloaded, 500, short-term 429 rate limit).
async function withRetry<T>(fn: () => Promise<T>, retries = 4, delayMs = 5000): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const is503 = error?.status === 503 || error?.message?.includes('503') || error?.message?.includes('UNAVAILABLE');
      
      if (is503 && attempt < retries) {
        console.warn(`[Warning] Model experiencing high demand (503). Retrying in ${delayMs / 1000}s (Attempt ${attempt}/${retries})...`);
        await new Promise((res) => setTimeout(res, delayMs));
        delayMs *= 2; // Exponential backoff: 5s -> 10s -> 20s -> 40s
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries reached for API call.');
}
async function analyzeNewsAndGenerateSignals() {
  const runStart = Date.now();
  console.log(`[${new Date().toISOString()}] Running AI market analysis...`);

  if (!(await geminiAllowed())) return;

  // 1. Fetch unprocessed news from Firestore
  const snapshot = await db
    .collection('raw_news')
    .where('processed', '==', false)
    .limit(15) // batch size controls token usage
    .get();

  if (snapshot.empty) {
    console.log('No new articles to process.');
    return;
  }

  const articles: string[] = [];
  const docRefs: DocumentReference[] = [];

  snapshot.forEach((doc) => {
    const data = doc.data();
    const pairs = (data.matchedPairs ?? []).join(', ');
    articles.push(`- [Pairs: ${pairs}] ${data.title}: ${data.contentSnippet ?? ''}`);
    docRefs.push(doc.ref);
  });

  const prompt = `
You are an expert institutional forex quantitative analyst.
Analyze the following recent financial news headlines and snippets.
Focus exclusively on these 5 assets: EURUSD, GBPUSD, USDJPY, XAUUSD (Gold), and USDCAD.

Recent News:
${articles.join('\n')}

Return exactly one entry for EACH of the 5 assets: EURUSD, GBPUSD, USDJPY, XAUUSD and USDCAD. Give each an up-to-date market bias and trade option based on this news. If the news gives no clear direction for an asset, return bias NEUTRAL with a low confidenceScore (1-30), a summaryCatalyst saying there is no clear catalyst, and suggestedAction STAND ASIDE.
`;

  // 2. Ask Gemini for structured JSON
  const geminiStart = Date.now();
  const response = await withRetry(async () => { await reserveRequest(); return ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        description: 'List of trade signals derived from current news sentiment',
        items: {
          type: Type.OBJECT,
          properties: {
            pair: { type: Type.STRING, enum: VALID_PAIRS },
            bias: { type: Type.STRING, enum: VALID_BIAS },
            confidenceScore: {
              type: Type.INTEGER,
              description: 'Confidence percentage from 1 to 100',
            },
            summaryCatalyst: {
              type: Type.STRING,
              description: '1-2 sentence executive summary explaining the fundamental driver',
            },
            suggestedAction: {
              type: Type.STRING,
              description: 'Specific trading stance e.g. BUY ON DIP, SELL RALLY, AWAIT BREAKOUT',
            },
          },
          required: ['pair', 'bias', 'confidenceScore', 'summaryCatalyst', 'suggestedAction'],
        },
      },
    },
  }); });

  console.log(`Gemini responded in ${((Date.now() - geminiStart) / 1000).toFixed(1)}s`);

  const jsonText = response.text;
  if (!jsonText) {
    console.log('No structured response returned from AI. Articles left unprocessed for retry.');
    return;
  }

  // 3. Parse and validate (never trust model output blindly)
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    console.error('AI returned invalid JSON. Articles left unprocessed for retry.');
    return;
  }

  const validSignals: Signal[] = (Array.isArray(parsed) ? parsed : []).filter(
    (s): s is Signal =>
      s &&
      VALID_PAIRS.includes(s.pair) &&
      VALID_BIAS.includes(s.bias) &&
      Number.isFinite(s.confidenceScore) &&
      typeof s.summaryCatalyst === 'string' &&
      typeof s.suggestedAction === 'string'
  );

  // One signal per pair (first one wins if the model repeats a pair), in a fixed order
  const byPair = new Map<string, Signal>();
  for (const s of validSignals) if (!byPair.has(s.pair)) byPair.set(s.pair, s);
  const signals: Signal[] = VALID_PAIRS.filter((p) => byPair.has(p)).map((p) => byPair.get(p)!);

  const missing = VALID_PAIRS.filter((p) => !byPair.has(p));
  if (missing.length > 0) console.log(`Note: AI returned no entry for: ${missing.join(', ')}`);

  console.log('Generated Signals:', JSON.stringify(signals, null, 2));

  // 4. Save signals + mark articles processed in one atomic batch
  const batch = db.batch();
  const updatedAt = new Date().toISOString();

  // Only overwrite the latest bias if there is something new to say
  if (signals.length > 0) {
    batch.set(db.collection('active_signals').doc('latest_market_bias'), {
      updatedAt,
      signals,
    });
    // Keep a history, since "latest" is overwritten every run
    batch.set(db.collection('signal_history').doc(), { updatedAt, signals });
  } else {
    console.log('No clear signals this run; keeping the previous latest_market_bias.');
  }

  for (const ref of docRefs) {
    batch.update(ref, { processed: true });
  }

  await batch.commit();

  if (signals.length > 0) writeSignalsForMetaTrader(signals);
  console.log(`Done. Marked ${docRefs.length} articles as processed.`);
  console.log(`Total run time: ${((Date.now() - runStart) / 1000).toFixed(1)}s`);
}

analyzeNewsAndGenerateSignals()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof BudgetExhausted) {
      console.log(err.message);
      process.exit(0);
    }
    console.error('Error during AI analysis:', err);
    process.exit(1);
  });