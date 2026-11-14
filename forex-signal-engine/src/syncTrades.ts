import * as fs from 'fs';
import * as path from 'path';
import { db } from './config/firebase.js';

// Path to MetaTrader common files folder (adjust to your MT terminal path)
const MT_COMMON_FILES = 'C:\\Users\\DOS Remote\\AppData\\Roaming\\MetaQuotes\\Terminal\\Common\\Files\\trade_journal.csv';

async function syncTrades() {
  if (!fs.existsSync(MT_COMMON_FILES)) {
    console.log('No MetaTrader trade journal found yet.');
    return;
  }

  const fileContent = fs.readFileSync(MT_COMMON_FILES, 'utf-8');
  const lines = fileContent.split('\n').filter(Boolean);

  const batch = db.batch();
  let syncedCount = 0;

  for (const line of lines) {
    const [ticket, symbol, type, profit, openPrice, closePrice, openTime, closeTime] = line.split(',');
    
    if (!ticket) continue;

    const tradeRef = db.collection('trade_history').doc(ticket.trim());
    
    batch.set(tradeRef, {
      ticket: ticket.trim(),
      symbol: symbol.trim(),
      type: type.trim(),
      profit: parseFloat(profit),
      openPrice: parseFloat(openPrice),
      closePrice: parseFloat(closePrice),
      openTime: openTime.trim(),
      closeTime: closeTime.trim(),
      syncedAt: new Date().toISOString()
    }, { merge: true });

    syncedCount++;
  }

  await batch.commit();
  console.log(`Successfully synced ${syncedCount} trades from MetaTrader to Firestore.`);
}

syncTrades()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });