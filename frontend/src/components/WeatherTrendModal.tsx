import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart,
  Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from 'recharts'
import { Download, RefreshCw, TrendingUp, X } from 'lucide-react'
import { api } from '../api/client'
import type {
  CollectStatus, MetarPoint, MonthlyStats, TafPeriod,
  WeatherHistoryMonthly, WeatherHistoryTrend, WeatherTrendData,
} from '../types'

// ─── TAF forecast computer ─────────────────────────────────────────────────

interface TafState { wdir: number | null; wspd: number | null; wgst: number | null; vis_m: number | null; ceiling_ft: number | null }

function buildTafFn(periods: TafPeriod[]): (timeMs: number) => TafState {
  const base = periods.find(p => p.type === 'BASE')
  const changes = periods
    .filter(p => !['BASE', 'TEMPO'].includes(p.type) && !p.type.startsWith('PROB'))
    .sort((a, b) => new Date(a.from ?? 0).getTime() - new Date(b.from ?? 0).getTime())

  return (timeMs: number): TafState => {
    const s: TafState = { wdir: null, wspd: null, wgst: null, vis_m: null, ceiling_ft: null }

    if (base) {
      if (base.wdir !== null) s.wdir = base.wdir
      if (base.wspd !== null) s.wspd = base.wspd
      if (base.wgst !== null) s.wgst = base.wgst
      if (base.vis_m !== null) s.vis_m = base.vis_m
      if (base.ceiling_ft !== null) s.ceiling_ft = base.ceiling_ft
    }

    for (const p of changes) {
      const effMs = p.type === 'BECMG'
        ? (p.to ? new Date(p.to).getTime() : Infinity)
        : (p.from ? new Date(p.from).getTime() : Infinity)
      if (timeMs >= effMs) {
        if (p.wdir !== null) s.wdir = p.wdir
        if (p.wspd !== null) s.wspd = p.wspd
        if (p.wgst !== null) s.wgst = p.wgst
        if (p.vis_m !== null) s.vis_m = p.vis_m
        if (p.ceiling_ft !== null) s.ceiling_ft = p.ceiling_ft
      }
    }
    return s
  }
}

// ─── Chart data builder ────────────────────────────────────────────────────

interface ChartPoint {
  time: string
  wspd: number | null; wgst: number | null; wdir: number | null
  vis_m: number | null; ceiling_ft: number | null
  temp_c: number | null; dewpoint_c: number | null; qnh_hpa: number | null
  taf_wspd: number | null; taf_wdir: number | null
  taf_vis_m: number | null; taf_ceiling_ft: number | null
}

function buildChartData(points: MetarPoint[], tafPeriods: TafPeriod[]): ChartPoint[] {
  const getTaf = buildTafFn(tafPeriods)
  return points.map(m => {
    const timeMs = new Date(m.obs_time).getTime()
    const taf = getTaf(timeMs)
    return {
      time: m.obs_time,
      wspd: m.wspd, wgst: m.wgst, wdir: m.wdir,
      vis_m: m.vis_m !== null ? Math.min(m.vis_m, 9999) : null,
      ceiling_ft: m.ceiling_ft,
      temp_c: m.temp_c, dewpoint_c: m.dewpoint_c, qnh_hpa: m.qnh_hpa,
      taf_wspd: taf.wspd, taf_wdir: taf.wdir,
      taf_vis_m: taf.vis_m !== null ? Math.min(taf.vis_m, 9999) : null,
      taf_ceiling_ft: taf.ceiling_ft,
    }
  })
}

// ─── Shared chart config ────────────────────────────────────────────────────

const GRID = <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />

const TOOLTIP_STYLE = {
  contentStyle: { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 10, padding: '6px 10px' },
  labelStyle: { color: '#94a3b8' },
  itemStyle: { color: '#cbd5e1' },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function xFmt(val: any): string {
  const d = new Date(val as string)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0
    ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
    : `${hh}:${mm}`
}

const MONTH_KO = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']

function xAxis(data: ChartPoint[]) {
  if (data.length === 0) return <XAxis dataKey="time" tick={false} />

  const spanMs = new Date(data[data.length - 1].time).getTime() - new Date(data[0].time).getTime()
  const spanDays = spanMs / 86400_000

  let fmt: (v: any) => string
  let interval: number

  if (spanDays > 90) {
    // Show YYYY년 MM월 at each tick
    fmt = (v: any) => {
      const d = new Date(v as string)
      return `${d.getUTCFullYear()}/${MONTH_KO[d.getUTCMonth()]}`
    }
    interval = Math.max(0, Math.floor(data.length / 14) - 1)
  } else if (spanDays > 3) {
    fmt = (v: any) => {
      const d = new Date(v as string)
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
    }
    interval = Math.max(0, Math.floor(data.length / 8) - 1)
  } else {
    fmt = xFmt
    interval = Math.max(0, Math.floor(data.length / 8) - 1)
  }

  return (
    <XAxis dataKey="time" tickFormatter={fmt} interval={interval}
      tick={{ fill: '#64748b', fontSize: 9 }} tickLine={false} axisLine={false} />
  )
}

function yAxis(unit?: string, width = 44) {
  return (
    <YAxis tick={{ fill: '#64748b', fontSize: 9 }} tickLine={false} axisLine={false}
      width={width} unit={unit} />
  )
}

// ─── Sub-components ────────────────────────────────────────────────────────

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-950 rounded-xl border border-gray-800/60 px-3 pt-2 pb-1">
      <p className="text-[10px] font-semibold text-gray-500 mb-1 uppercase tracking-wide">{title}</p>
      {children}
    </div>
  )
}

// Wind speed + gust vs TAF
function WindSpeedChart({ data }: { data: ChartPoint[] }) {
  const hasGust = data.some(d => d.wgst !== null)
  const hasTaf = data.some(d => d.taf_wspd !== null)
  return (
    <ChartCard title="풍속 (kt)">
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          {GRID}
          {xAxis(data)}
          {yAxis('kt')}
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={xFmt}
            formatter={(v: any, name: any) => [`${v ?? '—'} kt`, name]} />
          {hasTaf && (
            <Area type="stepAfter" dataKey="taf_wspd" name="TAF 예보"
              stroke="#f97316" strokeWidth={1} strokeDasharray="4 2"
              fill="#f97316" fillOpacity={0.10} dot={false} connectNulls />
          )}
          <Line type="monotone" dataKey="wspd" name="실측 풍속"
            stroke="#60a5fa" strokeWidth={1.5} dot={false} connectNulls />
          {hasGust && (
            <Line type="monotone" dataKey="wgst" name="실측 돌풍"
              stroke="#f87171" strokeWidth={1} strokeDasharray="3 2" dot={false} connectNulls />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// Wind direction dots vs TAF step
function WindDirChart({ data }: { data: ChartPoint[] }) {
  const hasTaf = data.some(d => d.taf_wdir !== null)
  return (
    <ChartCard title="풍향 (°)">
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          {GRID}
          {xAxis(data)}
          <YAxis domain={[0, 360]} ticks={[0, 90, 180, 270, 360]}
            tickFormatter={(v: number) => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N' }[v] ?? `${v}`)}
            tick={{ fill: '#64748b', fontSize: 9 }} tickLine={false} axisLine={false} width={24} />
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={xFmt}
            formatter={(v: any, name: any) => [`${v ?? '—'}°`, name]} />
          {hasTaf && (
            <Line type="stepAfter" dataKey="taf_wdir" name="TAF 예보"
              stroke="#f97316" strokeWidth={1.5} strokeDasharray="4 2" dot={false} connectNulls />
          )}
          {/* dots only, no line */}
          <Line type="linear" dataKey="wdir" name="실측 풍향"
            stroke="transparent" strokeWidth={0}
            dot={{ r: 2, fill: '#60a5fa', strokeWidth: 0 }}
            activeDot={{ r: 3, fill: '#93c5fd' }} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// Visibility vs TAF
function VisChart({ data }: { data: ChartPoint[] }) {
  const hasTaf = data.some(d => d.taf_vis_m !== null)
  const visFmt = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}km` : `${v}m`
  return (
    <ChartCard title="시정 (m)">
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          {GRID}
          {xAxis(data)}
          <YAxis tickFormatter={visFmt} domain={[0, 10000]}
            tick={{ fill: '#64748b', fontSize: 9 }} tickLine={false} axisLine={false} width={36} />
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={xFmt}
            formatter={(v: any, name: any) => [v !== null ? visFmt(v) : '—', name]} />
          {/* CAT I/II/III reference lines */}
          <ReferenceLine y={550} stroke="#f87171" strokeDasharray="2 4" strokeWidth={0.8} label={{ value: 'CAT I', fill: '#f87171', fontSize: 8, position: 'insideTopRight' }} />
          <ReferenceLine y={300} stroke="#fb923c" strokeDasharray="2 4" strokeWidth={0.8} label={{ value: 'CAT II', fill: '#fb923c', fontSize: 8, position: 'insideTopRight' }} />
          {hasTaf && (
            <Area type="stepAfter" dataKey="taf_vis_m" name="TAF 예보"
              stroke="#f97316" strokeWidth={1} strokeDasharray="4 2"
              fill="#f97316" fillOpacity={0.10} dot={false} connectNulls />
          )}
          <Line type="monotone" dataKey="vis_m" name="실측 시정"
            stroke="#34d399" strokeWidth={1.5} dot={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// QNH — METAR only (TAF doesn't forecast QNH)
function QnhChart({ data }: { data: ChartPoint[] }) {
  return (
    <ChartCard title="기압 QNH (hPa)">
      <ResponsiveContainer width="100%" height={110}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
          {GRID}
          {xAxis(data)}
          {yAxis('hPa', 50)}
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={xFmt}
            formatter={(v: any) => [`${v ?? '—'} hPa`, 'QNH']} />
          <Line type="monotone" dataKey="qnh_hpa" name="QNH"
            stroke="#a78bfa" strokeWidth={1.5} dot={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// Ceiling vs TAF
function CeilingChart({ data }: { data: ChartPoint[] }) {
  const hasTaf = data.some(d => d.taf_ceiling_ft !== null)
  const ceilFmt = (v: number) => `${v.toLocaleString()}ft`
  return (
    <ChartCard title="운고 (ft)">
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
          {GRID}
          {xAxis(data)}
          <YAxis tickFormatter={ceilFmt} tick={{ fill: '#64748b', fontSize: 9 }} tickLine={false} axisLine={false} width={52} />
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={xFmt}
            formatter={(v: any, name: any) => [v !== null ? ceilFmt(v) : '—', name]} />
          <ReferenceLine y={1000} stroke="#facc15" strokeDasharray="2 4" strokeWidth={0.8} label={{ value: 'IFR', fill: '#facc15', fontSize: 8, position: 'insideTopRight' }} />
          <ReferenceLine y={3000} stroke="#86efac" strokeDasharray="2 4" strokeWidth={0.8} label={{ value: 'VFR', fill: '#86efac', fontSize: 8, position: 'insideTopRight' }} />
          {hasTaf && (
            <Area type="stepAfter" dataKey="taf_ceiling_ft" name="TAF 예보"
              stroke="#f97316" strokeWidth={1} strokeDasharray="4 2"
              fill="#f97316" fillOpacity={0.10} dot={false} connectNulls />
          )}
          <Line type="monotone" dataKey="ceiling_ft" name="실측 운고"
            stroke="#fbbf24" strokeWidth={1.5} dot={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// Temperature & Dewpoint
function TempChart({ data }: { data: ChartPoint[] }) {
  return (
    <ChartCard title="기온 / 이슬점 (°C)">
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
          {GRID}
          {xAxis(data)}
          {yAxis('°C')}
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={xFmt}
            formatter={(v: any, name: any) => [`${v ?? '—'} °C`, name]} />
          <Area type="monotone" dataKey="temp_c" name="기온"
            stroke="#fb923c" strokeWidth={1.5} fill="#fb923c" fillOpacity={0.08} dot={false} connectNulls />
          <Line type="monotone" dataKey="dewpoint_c" name="이슬점"
            stroke="#22d3ee" strokeWidth={1} strokeDasharray="4 2" dot={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// Monthly stats charts
const CAT_COLORS = { VFR: '#34d399', MVFR: '#facc15', IFR: '#f97316', LIFR: '#f87171' }

function MonthlyCharts({ months }: { months: MonthlyStats[] }) {
  const labels = months.map(m => m.month.slice(5) + '월')
  const catData = months.map((m, i) => ({
    month: labels[i],
    VFR: Math.round(m.cat_vfr * 100),
    MVFR: Math.round(m.cat_mvfr * 100),
    IFR: Math.round(m.cat_ifr * 100),
    LIFR: Math.round(m.cat_lifr * 100),
  }))
  const wspd = months.map((m, i) => ({ month: labels[i], avg: m.avg_wspd, p10: m.p10_wspd, p90: m.p90_wspd }))
  const vis = months.map((m, i) => ({ month: labels[i], avg: m.avg_vis_m, p10: m.p10_vis_m }))
  const temp = months.map((m, i) => ({ month: labels[i], avg: m.avg_temp_c }))

  const barTick = { fill: '#64748b', fontSize: 9 }
  const barMargin = { top: 4, right: 8, left: -18, bottom: 0 }

  return (
    <div className="space-y-3">
      <ChartCard title="월별 평균 풍속 (kt)">
        <ResponsiveContainer width="100%" height={140}>
          <ComposedChart data={wspd} margin={barMargin}>
            {GRID}
            <XAxis dataKey="month" tick={barTick} tickLine={false} axisLine={false} />
            <YAxis tick={barTick} tickLine={false} axisLine={false} unit="kt" />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: any, n: any) => [`${v ?? '—'} kt`, n]} />
            <Bar dataKey="p10" name="P10" fill="#1e3a5f" radius={[2, 2, 0, 0]} />
            <Bar dataKey="avg" name="평균" fill="#3b82f6" radius={[2, 2, 0, 0]} />
            <Bar dataKey="p90" name="P90" fill="#1d4ed8" radius={[2, 2, 0, 0]} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="월별 평균 시정 (m)">
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={vis} margin={barMargin}>
            {GRID}
            <XAxis dataKey="month" tick={barTick} tickLine={false} axisLine={false} />
            <YAxis tick={barTick} tickLine={false} axisLine={false}
              tickFormatter={(v: number) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(v)} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: any) => [v !== null ? `${v}m` : '—']} />
            <Bar dataKey="p10" name="P10" fill="#065f46" radius={[2, 2, 0, 0]} />
            <Bar dataKey="avg" name="평균" fill="#34d399" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="월별 플라이트 카테고리 분포 (%)">
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={catData} margin={barMargin}>
            {GRID}
            <XAxis dataKey="month" tick={barTick} tickLine={false} axisLine={false} />
            <YAxis tick={barTick} tickLine={false} axisLine={false} unit="%" />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: any, n: any) => [`${v}%`, n]} />
            <Legend iconSize={8} wrapperStyle={{ fontSize: 10, color: '#64748b' }} />
            {(['VFR', 'MVFR', 'IFR', 'LIFR'] as const).map(cat => (
              <Bar key={cat} dataKey={cat} stackId="cat" fill={CAT_COLORS[cat]} radius={cat === 'LIFR' ? [2, 2, 0, 0] : undefined} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="월별 평균 기온 (°C)">
        <ResponsiveContainer width="100%" height={110}>
          <ComposedChart data={temp} margin={barMargin}>
            {GRID}
            <XAxis dataKey="month" tick={barTick} tickLine={false} axisLine={false} />
            <YAxis tick={barTick} tickLine={false} axisLine={false} unit="°C" />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: any) => [`${v ?? '—'} °C`, '기온']} />
            <Bar dataKey="avg" name="평균 기온" fill="#f97316" radius={[3, 3, 0, 0]} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  )
}

// ─── CSV download ───────────────────────────────────────────────────────────

function downloadCsv(filename: string, headers: string[], rows: (string | number | null)[][]) {
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(row.map(v => v === null || v === undefined ? '' : String(v)).join(','))
  }
  const blob = new Blob(['﻿' + lines.join('\n'), ], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// ─── TAF summary ────────────────────────────────────────────────────────────

function TafSummary({ raw, periods }: { raw: string | null; periods: TafPeriod[] }) {
  const [open, setOpen] = useState(false)
  if (!raw) return null
  return (
    <div className="text-[10px] bg-gray-900 rounded-lg border border-gray-800 px-3 py-1.5">
      <button onClick={() => setOpen(v => !v)} className="flex items-center gap-2 w-full text-left text-gray-500 hover:text-gray-300">
        <span className="font-semibold text-gray-400">TAF 요약</span>
        <span className="font-mono truncate">{raw.slice(0, 60)}…</span>
        <span className="ml-auto">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-0.5">
          {periods.map((p, i) => (
            <div key={i} className="flex gap-3 font-mono text-gray-400">
              <span className={`w-20 ${p.type === 'BASE' ? 'text-blue-400' : p.type === 'BECMG' ? 'text-amber-400' : p.type === 'TEMPO' ? 'text-purple-400' : 'text-green-400'}`}>{p.type}</span>
              <span>{p.from?.slice(5, 16)} → {p.to?.slice(5, 16) ?? '…'}</span>
              {p.wspd !== null && <span>풍속 {p.wdir ?? 'VRB'}/{p.wspd}{p.wgst ? `G${p.wgst}` : ''}kt</span>}
              {p.vis_m !== null && <span>시정 {p.vis_m >= 9999 ? 'CAVOK' : `${p.vis_m}m`}</span>}
              {p.ceiling_ft !== null && <span>운고 {p.ceiling_ft}ft</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Collect status bar ──────────────────────────────────────────────────────

function CollectBar({ status }: { status: CollectStatus | null }) {
  if (!status) return null
  const pct = status.total_months > 0 ? Math.round(status.processed / status.total_months * 100) : 0
  const isDone = status.status === 'done'
  return (
    <div className="text-[10px] space-y-1">
      <div className="flex items-center gap-2 text-gray-400">
        {!isDone && <RefreshCw size={10} className="animate-spin text-blue-400" />}
        {isDone ? (
          <span className="text-green-400">수집 완료 — {status.inserted.toLocaleString()}건 저장됨</span>
        ) : status.status === 'error' ? (
          <span className="text-red-400">오류: {status.error}</span>
        ) : (
          <span>{status.processed}/{status.total_months}개월 처리 중…</span>
        )}
      </div>
      {!isDone && status.total_months > 0 && (
        <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

// ─── Main modal ─────────────────────────────────────────────────────────────

interface Props { icao: string; onClose: () => void }

export default function WeatherTrendModal({ icao, onClose }: Props) {
  const [mode, setMode] = useState<'realtime' | 'history'>('realtime')
  const [hours, setHours] = useState(24)
  const [histView, setHistView] = useState<'raw' | 'monthly'>('raw')

  const today = new Date().toISOString().slice(0, 10)
  const lastYear = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10)
  const [histStart, setHistStart] = useState(lastYear)
  const [histEnd, setHistEnd] = useState(today)

  const [trendData, setTrendData] = useState<WeatherTrendData | null>(null)
  const [histPoints, setHistPoints] = useState<MetarPoint[] | null>(null)
  const [monthlyData, setMonthlyData] = useState<MonthlyStats[] | null>(null)
  const [collectStatus, setCollectStatus] = useState<CollectStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load real-time data on open / hours change
  useEffect(() => {
    if (mode === 'realtime') loadRealtime()
  }, [mode, hours, icao])

  async function loadRealtime() {
    setLoading(true); setError(null)
    try {
      const d = await api.weather.trend(icao, hours)
      if (d.error) setError(d.error)
      setTrendData(d)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleCollect() {
    setCollectStatus(null); setError(null)
    const res = await api.weather.historyCollect(icao, histStart, histEnd)
    if (res.error) { setError(res.error); return }
    const taskId = res.task_id
    pollRef.current = setInterval(async () => {
      const s = await api.weather.historyStatus(taskId)
      setCollectStatus(s)
      if (s.status === 'done' || s.status === 'error') {
        clearInterval(pollRef.current!)
        pollRef.current = null
      }
    }, 2000)
  }

  async function handleHistLoad() {
    setLoading(true); setError(null)
    try {
      if (histView === 'raw') {
        const d: WeatherHistoryTrend = await api.weather.historyTrend(icao, histStart, histEnd)
        if (d.error) setError(d.error)
        setHistPoints(d.points ?? [])
      } else {
        const d: WeatherHistoryMonthly = await api.weather.historyMonthly(icao, histStart, histEnd)
        if (d.error) setError(d.error)
        setMonthlyData(d.months ?? [])
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  function handleDownloadCsv() {
    if (mode === 'history' && histView === 'monthly' && monthlyData && monthlyData.length > 0) {
      const headers = ['month','count','avg_wspd_kt','p10_wspd','p90_wspd','avg_vis_m','p10_vis_m','avg_ceiling_ft','avg_temp_c','avg_qnh_hpa','vfr_pct','mvfr_pct','ifr_pct','lifr_pct']
      const rows = monthlyData.map(m => [
        m.month, m.count,
        m.avg_wspd, m.p10_wspd, m.p90_wspd,
        m.avg_vis_m, m.p10_vis_m, m.avg_ceiling_ft,
        m.avg_temp_c, m.avg_qnh_hpa,
        Math.round(m.cat_vfr * 100), Math.round(m.cat_mvfr * 100),
        Math.round(m.cat_ifr * 100), Math.round(m.cat_lifr * 100),
      ])
      downloadCsv(`${icao}_monthly_${histStart}_${histEnd}.csv`, headers, rows)
      return
    }
    const pts = mode === 'realtime' ? (trendData?.metar ?? []) : (histPoints ?? [])
    if (pts.length === 0) return
    const headers = ['obs_time','wdir_deg','wspd_kt','wgst_kt','vis_m','ceiling_ft','temp_c','dewpoint_c','qnh_hpa','flight_category']
    const rows = pts.map(p => [p.obs_time, p.wdir, p.wspd, p.wgst, p.vis_m, p.ceiling_ft, p.temp_c, p.dewpoint_c, p.qnh_hpa, p.flight_category])
    const suffix = mode === 'realtime' ? `realtime_${hours}h` : `${histStart}_${histEnd}`
    downloadCsv(`${icao}_metar_${suffix}.csv`, headers, rows)
  }

  const hasCsvData = mode === 'realtime'
    ? (trendData?.metar?.length ?? 0) > 0
    : histView === 'monthly' ? (monthlyData?.length ?? 0) > 0 : (histPoints?.length ?? 0) > 0

  // Cleanup poll on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const metarPoints = mode === 'realtime' ? (trendData?.metar ?? []) : (histPoints ?? [])
  const tafPeriods = mode === 'realtime' ? (trendData?.taf_periods ?? []) : []
  const chartData = useMemo(() => buildChartData(metarPoints, tafPeriods), [metarPoints, tafPeriods])

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl">

        {/* ── Header ── */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800 shrink-0 flex-wrap">
          <TrendingUp size={14} className="text-blue-400 shrink-0" />
          <span className="font-bold text-white text-sm">{icao}</span>
          <span className="text-gray-500 text-xs hidden sm:inline">날씨 트렌드</span>

          {/* Mode tabs */}
          <div className="flex bg-gray-800 rounded-lg p-0.5 text-xs ml-1">
            {(['realtime', 'history'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-2.5 py-1 rounded-md transition-colors ${mode === m ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                {m === 'realtime' ? '실시간' : '장기 조회'}
              </button>
            ))}
          </div>

          {/* Real-time hours selector */}
          {mode === 'realtime' && (
            <div className="flex gap-0.5 ml-1">
              {([12, 24, 48] as const).map(h => (
                <button key={h} onClick={() => setHours(h)}
                  className={`px-2 py-0.5 rounded text-xs font-mono transition-colors border ${hours === h ? 'bg-blue-900/50 text-blue-300 border-blue-700' : 'text-gray-500 border-transparent hover:text-gray-300'}`}>
                  {h}h
                </button>
              ))}
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            {loading && <RefreshCw size={12} className="animate-spin text-blue-400" />}
            {hasCsvData && (
              <button onClick={handleDownloadCsv} title="CSV 다운로드"
                className="text-gray-500 hover:text-green-400 transition-colors">
                <Download size={13} />
              </button>
            )}
            {mode === 'realtime' && (
              <button onClick={loadRealtime} className="text-gray-500 hover:text-gray-300">
                <RefreshCw size={13} />
              </button>
            )}
            <button onClick={onClose} className="text-gray-500 hover:text-gray-200"><X size={15} /></button>
          </div>
        </div>

        {/* ── History controls ── */}
        {mode === 'history' && (
          <div className="px-4 py-2 border-b border-gray-800 flex flex-wrap items-center gap-2 text-xs shrink-0">
            <input type="date" value={histStart} onChange={e => setHistStart(e.target.value)} max={histEnd}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 text-xs" />
            <span className="text-gray-600">~</span>
            <input type="date" value={histEnd} onChange={e => setHistEnd(e.target.value)} min={histStart} max={today}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 text-xs" />
            <button onClick={handleCollect}
              className="px-3 py-1 bg-blue-700 hover:bg-blue-600 text-white rounded font-semibold">
              데이터 수집
            </button>
            <div className="flex bg-gray-800 rounded-lg p-0.5">
              {(['raw', 'monthly'] as const).map(v => (
                <button key={v} onClick={() => setHistView(v)}
                  className={`px-2.5 py-0.5 rounded-md transition-colors ${histView === v ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                  {v === 'raw' ? '원시 데이터' : '월별 통계'}
                </button>
              ))}
            </div>
            <button onClick={handleHistLoad}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded font-semibold">
              조회
            </button>
          </div>
        )}

        {/* ── Scrollable body ── */}
        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-3">
          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</div>
          )}

          {mode === 'history' && <CollectBar status={collectStatus} />}

          {mode === 'realtime' && trendData?.taf_raw && (
            <TafSummary raw={trendData.taf_raw} periods={trendData.taf_periods} />
          )}

          {/* Charts — 원시 시계열 */}
          {(mode === 'realtime' || histView === 'raw') && chartData.length > 0 && (
            <>
              <WindSpeedChart data={chartData} />
              <WindDirChart data={chartData} />
              <VisChart data={chartData} />
              <QnhChart data={chartData} />
              <CeilingChart data={chartData} />
              <TempChart data={chartData} />
            </>
          )}

          {/* Monthly stats */}
          {mode === 'history' && histView === 'monthly' && monthlyData && monthlyData.length > 0 && (
            <MonthlyCharts months={monthlyData} />
          )}

          {/* Empty states */}
          {!loading && chartData.length === 0 && (mode === 'realtime' || histView === 'raw') && (
            <p className="text-xs text-gray-500 text-center py-8">
              {mode === 'history' ? '기간을 선택하고 [조회]를 눌러주세요.' : 'METAR 데이터가 없습니다.'}
            </p>
          )}
          {!loading && mode === 'history' && histView === 'monthly' && (!monthlyData || monthlyData.length === 0) && (
            <p className="text-xs text-gray-500 text-center py-8">기간을 선택하고 [조회]를 눌러주세요.</p>
          )}
        </div>

        {/* ── Legend footer ── */}
        {mode === 'realtime' && chartData.length > 0 && (trendData?.taf_periods?.length ?? 0) > 0 && (
          <div className="px-4 py-2 border-t border-gray-800 flex gap-4 text-[10px] text-gray-500 shrink-0">
            <span className="flex items-center gap-1"><span className="w-4 h-0.5 bg-blue-400 inline-block" /> 실측값</span>
            <span className="flex items-center gap-1"><span className="w-4 h-0.5 border-t border-dashed border-orange-400 inline-block" /> TAF 예보</span>
            <span className="ml-auto">UTC 기준</span>
          </div>
        )}
      </div>
    </div>
  )
}
