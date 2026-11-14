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

// Retry on temporary Google-side errors (503 overloaded, 429 rate limit, 500)
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.code;
      const retryable = status === 503 || status === 429 || status === 500;
      if (!retryable || attempt >= maxAttempts) throw err;
      const waitSec = Math.min(2 ** attempt, 30); // 2s, 4s, 8s, 16s...
      console.warn(`Gemini error ${status} (attempt ${attempt}/${maxAttempts}). Retrying in ${waitSec}s...`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
  }
}

async function analyzeNewsAndGenerateSignals() {
  const runStart = Date.now();
  console.log(`[${new Date().toISOString()}] Running AI market analysis...`);

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
  const response = await withRetry(() => ai.models.generateContent({
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
  }));

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
    console.error('Error during AI analysis:', err);
    process.exit(1);
  });