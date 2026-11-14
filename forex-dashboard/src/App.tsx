import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { db } from './firebase';
import { collection, getDocs, doc, getDoc } from 'firebase/firestore';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Activity,
  DollarSign,
  ShieldCheck,
  Clock,
} from 'lucide-react';

interface Signal {
  pair: string;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidenceScore: number;
  summaryCatalyst: string;
  suggestedAction: string;
}

interface Trade {
  ticket: string;
  symbol: string;
  type: string;
  profit: number;
  openPrice: number;
  closePrice: number;
  openTime: string;
  closeTime: string;
}

const PAIR_ORDER = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCAD', 'XAUUSD'];
const STALE_HOURS = 6; // matches the EAs' default news-file age limit
const MAX_ROWS = 50;

const BIAS_STYLE = {
  BULLISH: {
    badge: 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/30',
    bar: 'bg-emerald-500',
    edge: 'border-l-emerald-500',
    Icon: TrendingUp,
  },
  BEARISH: {
    badge: 'bg-rose-500/10 text-rose-400 ring-1 ring-rose-500/30',
    bar: 'bg-rose-500',
    edge: 'border-l-rose-500',
    Icon: TrendingDown,
  },
  NEUTRAL: {
    badge: 'bg-slate-700/40 text-slate-300 ring-1 ring-slate-600/50',
    bar: 'bg-slate-500',
    edge: 'border-l-slate-600',
    Icon: Minus,
  },
} as const;

// MetaTrader dates look like "2026.11.14 18:20:00"; normalise before parsing
function parseTime(s: string): number {
  if (!s) return 0;
  const t = Date.parse(s.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3').replace(' ', 'T'));
  return Number.isNaN(t) ? 0 : t;
}

function formatTime(s: string): string {
  const t = parseTime(s);
  if (!t) return s || '-';
  return new Date(t).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function timeAgo(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

const money = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

function Kpi(props: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="mb-2 flex items-center gap-2 text-sm text-slate-400">
        {props.icon}
        {props.label}
      </div>
      <div className={`font-mono text-2xl font-bold tabular-nums ${props.tone ?? 'text-slate-100'}`}>
        {props.value}
      </div>
      {props.sub && <div className="mt-1 text-xs text-slate-500">{props.sub}</div>}
    </div>
  );
}

function SignalCard({ sig }: { sig: Signal }) {
  const s = BIAS_STYLE[sig.bias] ?? BIAS_STYLE.NEUTRAL;
  const conf = Math.min(100, Math.max(0, Number(sig.confidenceScore) || 0));
  return (
    <div
      className={`flex flex-col justify-between rounded-xl border border-l-4 border-slate-800 ${s.edge} bg-slate-900/60 p-5`}
    >
      <div>
        <div className="mb-4 flex items-center justify-between">
          <span className="font-mono text-lg font-bold text-slate-100">{sig.pair}</span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold ${s.badge}`}
          >
            <s.Icon size={14} />
            {sig.bias}
          </span>
        </div>
        <div className="mb-4">
          <div className="mb-1.5 flex justify-between text-xs text-slate-400">
            <span>Confidence</span>
            <span className="font-mono tabular-nums">{conf}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-800">
            <div className={`h-1.5 rounded-full ${s.bar}`} style={{ width: `${conf}%` }} />
          </div>
        </div>
        <p className="mb-5 text-sm leading-relaxed text-slate-300">{sig.summaryCatalyst}</p>
      </div>
      <div className="rounded-lg bg-slate-950 px-3 py-2 text-xs">
        <span className="font-semibold text-cyan-400">Action: </span>
        <span className="text-slate-300">{sig.suggestedAction}</span>
      </div>
    </div>
  );
}

export default function App() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    setRefreshing(true);
    try {
      // Latest AI signals
      const signalSnap = await getDoc(doc(db, 'active_signals', 'latest_market_bias'));
      if (signalSnap.exists()) {
        const data = signalSnap.data();
        setSignals(data.signals || []);
        setLastUpdated(data.updatedAt || '');
      }

      // Synced trade history
      const tradeSnapshot = await getDocs(collection(db, 'trade_history'));
      const fetched: Trade[] = [];
      tradeSnapshot.forEach((d) => fetched.push(d.data() as Trade));
      setTrades(fetched);
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const sortedSignals = useMemo(() => {
    const rank = (p: string) => {
      const i = PAIR_ORDER.indexOf(p);
      return i === -1 ? PAIR_ORDER.length : i;
    };
    return [...signals].sort((a, b) => rank(a.pair) - rank(b.pair));
  }, [signals]);

  const sortedTrades = useMemo(
    () => [...trades].sort((a, b) => parseTime(b.closeTime) - parseTime(a.closeTime)),
    [trades]
  );

  const stats = useMemo(() => {
    const totalPnL = trades.reduce((acc, t) => acc + t.profit, 0);
    const wins = trades.filter((t) => t.profit > 0).length;
    const grossWin = trades.filter((t) => t.profit > 0).reduce((a, t) => a + t.profit, 0);
    const grossLoss = Math.abs(trades.filter((t) => t.profit < 0).reduce((a, t) => a + t.profit, 0));
    return {
      totalPnL,
      wins,
      winRate: trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '0.0',
      profitFactor: grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : '-',
    };
  }, [trades]);

  const lastMs = lastUpdated ? Date.parse(lastUpdated) : 0;
  const stale = !lastMs || Date.now() - lastMs > STALE_HOURS * 3600 * 1000;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
        <div className="flex items-center gap-3 text-cyan-400">
          <Activity className="animate-spin" size={24} /> Loading trading data...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 font-sans text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="mb-8 flex flex-col gap-4 border-b border-slate-800 pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-50">
              <Activity className="text-cyan-400" size={26} />
              FX Intelligence Hub
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              News-driven market bias and MetaTrader results for five pairs
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs ring-1 ${
                stale
                  ? 'bg-amber-500/10 text-amber-400 ring-amber-500/30'
                  : 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30'
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${stale ? 'bg-amber-400' : 'bg-emerald-400'}`}
              />
              {lastMs
                ? `${stale ? 'Signals stale' : 'Signals fresh'}, updated ${timeAgo(lastMs)}`
                : 'No signals yet'}
            </div>
            <button
              onClick={fetchData}
              disabled={refreshing}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-500/60 hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"
            >
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </header>

        {/* Metrics */}
        <div className="mb-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Kpi
            icon={<DollarSign size={16} className="text-emerald-400" />}
            label="Realized P&L"
            value={money(stats.totalPnL)}
            tone={stats.totalPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          />
          <Kpi
            icon={<ShieldCheck size={16} className="text-cyan-400" />}
            label="Win rate"
            value={`${stats.winRate}%`}
            sub={`${stats.wins} of ${trades.length} trades`}
            tone="text-cyan-400"
          />
          <Kpi
            icon={<TrendingUp size={16} className="text-violet-400" />}
            label="Profit factor"
            value={stats.profitFactor}
            sub="Gross profit / gross loss"
          />
          <Kpi
            icon={<Clock size={16} className="text-amber-400" />}
            label="Monitored pairs"
            value="5"
            sub="EURUSD, GBPUSD, USDJPY, USDCAD, XAUUSD"
          />
        </div>

        {/* AI signals */}
        <section className="mb-12">
          <h2 className="mb-4 text-lg font-semibold text-slate-100">Market bias by pair</h2>
          {sortedSignals.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 p-8 text-center text-sm text-slate-400">
              No signals yet. Run <code className="text-cyan-400">npm run analyze</code> to generate them.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
              {sortedSignals.map((sig) => (
                <SignalCard key={sig.pair} sig={sig} />
              ))}
            </div>
          )}
        </section>

        {/* Trade history */}
        <section>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-lg font-semibold text-slate-100">Closed trades</h2>
            {trades.length > MAX_ROWS && (
              <span className="text-xs text-slate-500">
                Showing latest {MAX_ROWS} of {trades.length}
              </span>
            )}
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="sticky top-0 bg-slate-900 text-xs text-slate-400">
                  <tr className="border-b border-slate-800">
                    <th className="hidden px-4 py-3 font-medium md:table-cell">Ticket</th>
                    <th className="px-4 py-3 font-medium">Symbol</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 text-right font-medium">Open</th>
                    <th className="px-4 py-3 text-right font-medium">Close</th>
                    <th className="px-4 py-3 text-right font-medium">Profit</th>
                    <th className="px-4 py-3 text-right font-medium">Closed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 tabular-nums">
                  {sortedTrades.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                        No trades synced yet. Run <code className="text-cyan-400">npm run sync</code> to
                        import them.
                      </td>
                    </tr>
                  ) : (
                    sortedTrades.slice(0, MAX_ROWS).map((t) => {
                      const isBuy = String(t.type).toUpperCase() === 'BUY';
                      return (
                        <tr key={t.ticket} className="hover:bg-slate-800/40">
                          <td className="hidden px-4 py-3 text-slate-500 md:table-cell">{t.ticket}</td>
                          <td className="px-4 py-3 font-semibold text-slate-100">{t.symbol}</td>
                          <td className="px-4 py-3">
                            <span
                              className={`rounded px-2 py-0.5 text-xs font-semibold ${
                                isBuy
                                  ? 'bg-emerald-500/10 text-emerald-400'
                                  : 'bg-rose-500/10 text-rose-400'
                              }`}
                            >
                              {String(t.type).toUpperCase()}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-slate-300">{t.openPrice}</td>
                          <td className="px-4 py-3 text-right text-slate-300">{t.closePrice}</td>
                          <td
                            className={`px-4 py-3 text-right font-semibold ${
                              t.profit >= 0 ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {t.profit >= 0 ? '+' : '-'}
                            {Math.abs(t.profit).toFixed(2)}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-500">{formatTime(t.closeTime)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
