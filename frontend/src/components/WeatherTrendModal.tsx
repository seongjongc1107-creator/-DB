import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart,
  Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip,
  XAxis, YAxis,
} from 'recharts'
import { Download, RefreshCw, TrendingUp, X } from 'lucide-react'
import { api } from '../api/client'
import type {
  CollectStatus, MetarPoint, MonthlyStats, TafPeriod, TafSnapshot,
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
        if (p.type === 'FM') {
          // FM은 이전 상태를 통째로 갈아치우는 새 예보 구간 — 예를 들어 이전엔
          // BKN015로 운고가 있었다가 FM 구간에서 구름 언급이 없으면(SCT/FEW/SKC만
          // 있거나 아예 안 적힘) 실제로는 "운고 없음"이 된 건데, 이걸 예전 값을
          // 계속 들고 있으면 하늘이 갠 뒤에도 낡은 운고가 그대로 표출되는 버그가 됨
          s.wdir = p.wdir
          s.wspd = p.wspd
          s.wgst = p.wgst
          s.vis_m = p.vis_m
          s.ceiling_ft = p.ceiling_ft
        } else {
          // BECMG/PROB 등은 이전 상태 위에 언급된 항목만 부분적으로 갈아끼우는
          // 전환 구간 — 언급 안 된 나머지는 직전 상태를 그대로 유지
          if (p.wdir !== null) s.wdir = p.wdir
          if (p.wspd !== null) s.wspd = p.wspd
          if (p.wgst !== null) s.wgst = p.wgst
          if (p.vis_m !== null) s.vis_m = p.vis_m
          if (p.ceiling_ft !== null) s.ceiling_ft = p.ceiling_ft
        }
      }
    }
    return s
  }
}

// 과거 특정 시점의 "그때 유효했던 최신 TAF"를 골라 평가 — 현재 TAF 하나만으로
// 과거 전체를 평가하면 발표 시각 이전 구간이 전부 BASE값 일직선이 되어버리는
// 문제가 있어, TAF 발표 이력(taf_history)에서 해당 시점 직전에 발표된 걸 사용
function buildTafHistoryFn(history: TafSnapshot[]): (timeMs: number) => TafState {
  const evaluators = [...history]
    .sort((a, b) => new Date(a.issue_time).getTime() - new Date(b.issue_time).getTime())
    .map(h => ({ issueMs: new Date(h.issue_time).getTime(), fn: buildTafFn(h.periods) }))

  return (timeMs: number): TafState => {
    if (evaluators.length === 0) return { wdir: null, wspd: null, wgst: null, vis_m: null, ceiling_ft: null }
    let chosen = evaluators[0]
    for (const e of evaluators) {
      if (e.issueMs <= timeMs) chosen = e
      else break
    }
    return chosen.fn(timeMs)
  }
}

// ─── Chart data builder ────────────────────────────────────────────────────

interface ChartPoint {
  time: string
  t: number  // epoch ms — 실제 x축 값 (숫자축이라야 "지금" 기준선을 정확한 위치에 그릴 수 있음)
  isForecast?: boolean  // 실측 없이 TAF 예보만 있는 미래 지점
  wspd: number | null; wgst: number | null; wdir: number | null
  vis_m: number | null; ceiling_ft: number | null
  temp_c: number | null; dewpoint_c: number | null; qnh_hpa: number | null
  taf_wspd: number | null; taf_wdir: number | null
  taf_vis_m: number | null; taf_ceiling_ft: number | null
  tempo_wspd: number | null; tempo_wgst: number | null
  tempo_vis_m: number | null; tempo_ceiling_ft: number | null
}

// TAF 유효기간의 끝(가장 늦은 to) — 이 시각까지는 미래라도 예보선을 그려서
// "지금 이후 TAF가 어떻게 예보하는지"를 보여줌. BASE만 있고 변화군이 전혀 없으면
// 만료 시각을 알 수 없으니 관례상 24h로 가정.
function tafForecastEnd(periods: TafPeriod[]): Date | null {
  if (periods.length === 0) return null
  let maxTo: number | null = null
  for (const p of periods) {
    if (p.to) {
      const t = new Date(p.to).getTime()
      if (!isNaN(t) && (maxTo === null || t > maxTo)) maxTo = t
    }
  }
  return maxTo !== null ? new Date(maxTo) : new Date(Date.now() + 24 * 3600_000)
}

interface TempoRange {
  from: number; to: number
  wspd: number | null; wgst: number | null; vis_m: number | null; ceiling_ft: number | null
}

// TEMPO는 "한 시간 미만씩, 절반 미만의 시간 동안 일시적으로" 벗어나는 구간이라
// 대표 예보선(taf_wspd 등)에는 아예 반영 안 하고 있음(buildTafFn에서 제외) — 대신
// 이 구간을 차트에 음영+실제 예보값 선으로 표시해서 "이 시간대엔 일시적으로 이
// 정도까지 나빠질 수 있다"를 보여줌. 과거(taf_history)·현재(tafPeriods) TAF에
// 나온 TEMPO를 다 모아서 중복 제거.
function extractTempoRanges(tafPeriods: TafPeriod[], tafHistory: TafSnapshot[]): TempoRange[] {
  const all: TafPeriod[] = [...tafPeriods, ...tafHistory.flatMap(h => h.periods)]
  const seen = new Set<string>()
  const ranges: TempoRange[] = []
  for (const p of all) {
    if (p.type !== 'TEMPO' || !p.from || !p.to) continue
    const from = new Date(p.from).getTime()
    const to = new Date(p.to).getTime()
    if (isNaN(from) || isNaN(to) || to <= from) continue
    const key = `${from}_${to}`
    if (seen.has(key)) continue
    seen.add(key)
    ranges.push({
      from, to,
      wspd: p.wspd,
      wgst: p.wgst,  // 돌풍이 있어도 지속 풍속(wspd)을 따로 보여줘야지, 돌풍값으로 덮어쓰면 안 됨
      vis_m: p.vis_m !== null ? Math.min(p.vis_m, 9999) : null,
      ceiling_ft: p.ceiling_ft,
    })
  }
  return ranges.sort((a, b) => a.from - b.from)
}

function buildChartData(
  points: MetarPoint[], tafPeriods: TafPeriod[], tafHistory: TafSnapshot[],
  futureEnd?: Date | null, tempoRanges?: TempoRange[],
): ChartPoint[] {
  const getTaf = buildTafFn(tafPeriods)
  // 과거 구간은 그 시점에 실제 유효했던 TAF 이력으로 평가 — 이력이 없으면(장기
  // 조회 등) 현재 TAF로라도 대체 평가
  const getTafPast = tafHistory.length > 0 ? buildTafHistoryFn(tafHistory) : getTaf
  const past: ChartPoint[] = points.map(m => {
    const timeMs = new Date(m.obs_time).getTime()
    const taf = getTafPast(timeMs)
    return {
      time: m.obs_time,
      t: timeMs,
      wspd: m.wspd, wgst: m.wgst, wdir: m.wdir,
      vis_m: m.vis_m !== null ? Math.min(m.vis_m, 9999) : null,
      ceiling_ft: m.ceiling_ft,
      temp_c: m.temp_c, dewpoint_c: m.dewpoint_c, qnh_hpa: m.qnh_hpa,
      taf_wspd: taf.wspd, taf_wdir: taf.wdir,
      taf_vis_m: taf.vis_m !== null ? Math.min(taf.vis_m, 9999) : null,
      taf_ceiling_ft: taf.ceiling_ft,
      tempo_wspd: null, tempo_wgst: null, tempo_vis_m: null, tempo_ceiling_ft: null,
    }
  })

  let result = past

  if (futureEnd) {
    const lastMs = points.length > 0 ? new Date(points[points.length - 1].obs_time).getTime() : Date.now()
    const stepMs = 3600_000  // 1시간 간격
    // "지금"부터 정확히 1시간씩 띄우면 07:23, 08:23, 09:23…처럼 눈금이 어중간해짐 —
    // METAR/TAF가 정시 기준으로 도는 것과 맞춰 다음 정시로 올림해서 시작
    const startMs = Math.ceil(Math.max(lastMs, Date.now()) / stepMs) * stepMs
    const endMs = futureEnd.getTime()
    if (endMs > startMs) {
      const future: ChartPoint[] = []
      for (let t = startMs; t <= endMs; t += stepMs) {
        const taf = getTaf(t)
        future.push({
          time: new Date(t).toISOString(),
          t,
          isForecast: true,
          wspd: null, wgst: null, wdir: null, vis_m: null, ceiling_ft: null,
          temp_c: null, dewpoint_c: null, qnh_hpa: null,
          taf_wspd: taf.wspd, taf_wdir: taf.wdir,
          taf_vis_m: taf.vis_m !== null ? Math.min(taf.vis_m, 9999) : null,
          taf_ceiling_ft: taf.ceiling_ft,
          tempo_wspd: null, tempo_wgst: null, tempo_vis_m: null, tempo_ceiling_ft: null,
        })
      }
      result = [...past, ...future]
    }
  }

  if (tempoRanges && tempoRanges.length > 0) {
    // 구간 시작·끝 경계점을 끼워 넣어서 정확히 그 시각에 선이 시작/끝나게 함
    const tempoPoints: ChartPoint[] = []
    for (const r of tempoRanges) {
      for (const t of [r.from, r.to]) {
        tempoPoints.push({
          time: new Date(t).toISOString(), t,
          wspd: null, wgst: null, wdir: null, vis_m: null, ceiling_ft: null,
          temp_c: null, dewpoint_c: null, qnh_hpa: null,
          taf_wspd: null, taf_wdir: null, taf_vis_m: null, taf_ceiling_ft: null,
          tempo_wspd: null, tempo_wgst: null, tempo_vis_m: null, tempo_ceiling_ft: null,
        })
      }
    }
    result = [...result, ...tempoPoints].sort((a, b) => a.t - b.t)

    // 경계점만 채우면 그 사이에 낀 실측 관측점들이 tempo_*=null이라 선이 뚝뚝
    // 끊겨서 점 두 개짜리로 보임(connectNulls 없이는 안 이어짐) — 구간 안의
    // 모든 점을 다 채워야 하나로 이어진 수평선이 됨
    result = result.map(p => {
      const r = tempoRanges.find(r => p.t >= r.from && p.t <= r.to)
      if (!r) return p
      return { ...p, tempo_wspd: r.wspd, tempo_wgst: r.wgst, tempo_vis_m: r.vis_m, tempo_ceiling_ft: r.ceiling_ft }
    })
  }

  return result
}

// ─── Shared chart config ────────────────────────────────────────────────────

const GRID = <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />

const TOOLTIP_STYLE = {
  contentStyle: { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 10, padding: '6px 10px' },
  labelStyle: { color: '#94a3b8' },
  itemStyle: { color: '#cbd5e1' },
}

// Tooltip에는 항상 날짜+시각을 같이 보여줘서 "몇 일자 몇 시"인지 헷갈리지 않게 함
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function xFmt(val: any): string {
  const d = new Date(val)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hh}:${mm}Z`
}

const MONTH_KO = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']

function xAxis(data: ChartPoint[]) {
  if (data.length === 0) return <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tick={false} />

  const spanMs = data[data.length - 1].t - data[0].t
  const spanDays = spanMs / 86400_000

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fmt: (v: any) => string
  let interval: number

  if (spanDays > 90) {
    // Show YYYY년 MM월 at each tick
    fmt = (v: any) => {
      const d = new Date(v)
      return `${d.getUTCFullYear()}/${MONTH_KO[d.getUTCMonth()]}`
    }
    interval = Math.max(0, Math.floor(data.length / 14) - 1)
  } else if (spanDays > 3) {
    fmt = (v: any) => {
      const d = new Date(v)
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
    }
    interval = Math.max(0, Math.floor(data.length / 8) - 1)
  } else {
    // 자정에 걸리는 눈금이 우연히 없으면 날짜가 안 보일 수 있으니, 실시간(≤3일)
    // 구간에서는 매 눈금마다 "M/D HH:MM"을 항상 같이 표시 — 자정 근처에서만
    // 날짜를 보여주면 간격이 안 맞아 며칠짜리인지 못 알아보는 경우가 있었음
    fmt = (v: any) => {
      const d = new Date(v)
      const hh = String(d.getUTCHours()).padStart(2, '0')
      const mm = String(d.getUTCMinutes()).padStart(2, '0')
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hh}:${mm}`
    }
    interval = Math.max(0, Math.floor(data.length / 6) - 1)
  }

  return (
    <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time"
      tickFormatter={fmt} interval={interval}
      tick={{ fill: '#64748b', fontSize: 9 }} tickLine={false} axisLine={false} />
  )
}

function yAxis(unit?: string, width = 44) {
  return (
    <YAxis tick={{ fill: '#64748b', fontSize: 9 }} tickLine={false} axisLine={false}
      width={width} unit={unit} />
  )
}

// "지금" 기준선 — 이 선을 기준으로 왼쪽은 실측(METAR), 오른쪽은 TAF 예보만 있는 미래 구간
function nowLine(nowMs?: number) {
  if (nowMs === undefined) return null
  return (
    <ReferenceLine x={nowMs} stroke="#94a3b8" strokeDasharray="2 2" strokeWidth={1}
      label={{ value: '지금', fill: '#94a3b8', fontSize: 8, position: 'insideTopLeft' }} />
  )
}

// ─── Sub-components ────────────────────────────────────────────────────────

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-950 rounded-xl border border-gray-800/60 px-3 pt-2 pb-1">
      <p className="text-[10px] font-semibold text-gray-500 mb-1 uppercase tracking-wide">
        {title}
        {subtitle && <span className="ml-1.5 normal-case font-normal text-gray-600">{subtitle}</span>}
      </p>
      {children}
    </div>
  )
}

// Wind speed + gust vs TAF
function WindSpeedChart({ data, nowMs, tempoRanges }: { data: ChartPoint[]; nowMs?: number; tempoRanges?: TempoRange[] }) {
  const hasGust = data.some(d => d.wgst !== null)
  const hasTaf = data.some(d => d.taf_wspd !== null)
  return (
    <ChartCard title="풍속 (kt)">
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          {GRID}
          {xAxis(data)}
          {yAxis('kt', 62)}
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={xFmt}
            formatter={(v: any, name: any) => [`${v ?? '—'} kt`, name]} />
          {nowLine(nowMs)}
          <Line type="linear" dataKey="wspd" name="실측 풍속"
            stroke="#60a5fa" strokeWidth={1.5} dot={{ r: 2, fill: '#60a5fa', strokeWidth: 0 }} connectNulls />
          {hasGust && (
            <Line type="linear" dataKey="wgst" name="실측 돌풍"
              stroke="#f87171" strokeWidth={1} strokeDasharray="3 2"
              dot={{ r: 2, fill: '#f87171', strokeWidth: 0 }} connectNulls />
          )}
          {hasTaf && (
            <Line type="stepAfter" dataKey="taf_wspd" name="TAF 예보"
              stroke="#f97316" strokeWidth={1.5} strokeDasharray="4 2" dot={false} connectNulls />
          )}
          {(tempoRanges?.length ?? 0) > 0 && (
            <>
              <Line type="linear" dataKey="tempo_wspd" name="TEMPO 예보(풍속)"
                stroke="#fdba74" strokeWidth={2} strokeDasharray="1 2" dot={{ r: 2, fill: '#fdba74', strokeWidth: 0 }} />
              {tempoRanges?.some(r => r.wgst !== null) && (
                <Line type="linear" dataKey="tempo_wgst" name="TEMPO 예보(돌풍)"
                  stroke="#ea580c" strokeWidth={1.5} strokeDasharray="1 1" dot={{ r: 2, fill: '#ea580c', strokeWidth: 0 }} />
              )}
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// Wind rose — 16방위 원형 차트. 꽃잎 반경 = 빈도, 우세 풍향은 강조색
const ROSE_SECTORS = 16
const ROSE_LABELS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

function polar(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = (angleDeg - 90) * (Math.PI / 180) // 0° = 위쪽(N), 시계방향
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
}

function sectorPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  if (r <= 0) return ''
  const [x1, y1] = polar(cx, cy, r, startDeg)
  const [x2, y2] = polar(cx, cy, r, endDeg)
  return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 0,1 ${x2},${y2} Z`
}

function WindRoseChart({ data }: { data: ChartPoint[] }) {
  const wdirs = data.map(d => d.wdir).filter((v): v is number => v !== null)
  const sectorWidth = 360 / ROSE_SECTORS
  const counts = new Array(ROSE_SECTORS).fill(0)
  for (const wdir of wdirs) {
    const idx = Math.round(wdir / sectorWidth) % ROSE_SECTORS
    counts[idx]++
  }
  const total = wdirs.length
  const maxCount = Math.max(...counts, 1)
  const dominantIdx = counts.indexOf(maxCount)
  const cx = 70, cy = 70, maxR = 46, minR = 8

  const latest = [...data].reverse().find(d => d.wdir !== null)?.wdir ?? null

  // 꽃잎 반지름 공식 — count===0이면 0, 아니면 minR~maxR 사이를 count/maxCount
  // 비율로 선형 보간(너무 작은 값도 최소한 보이게 minR만큼 밑깔림). 배경 기준원도
  // 반드시 이 식과 같은 비율로 그려야 "이 원 = 몇 %" 캡션이 실제로 맞음 — 예전엔
  // 원은 maxR*f로, 꽃잎은 minR+(maxR-minR)*f로 서로 다른 식을 써서 안 맞았음
  const ringR = (f: number) => minR + (maxR - minR) * f

  return (
    <ChartCard title="풍향 분포" subtitle="꽃잎 길이 = 방향별 관측 횟수 (제일 잦은 방향을 100%로 놓고 비교)">
      {total === 0 ? (
        <p className="text-xs text-gray-600 text-center py-6">풍향 데이터가 없습니다.</p>
      ) : (
        <div className="flex items-center gap-4 py-1">
          <svg width={140} height={140} viewBox="0 0 140 140" className="shrink-0">
            {/* 배경 기준 원 — 꽃잎과 같은 척도로 25/50/75/100% 표시 */}
            {[0.25, 0.5, 0.75, 1].map(f => (
              <circle key={f} cx={cx} cy={cy} r={ringR(f)} fill="none" stroke="#1f2937" strokeWidth={1} />
            ))}
            {/* 기준원 %값 라벨 — NE(45°) 방향에 겹치지 않게 표시 */}
            {[0.25, 0.5, 0.75, 1].map(f => {
              const [tx, ty] = polar(cx, cy, ringR(f), 45)
              return (
                <text key={`pct-${f}`} x={tx} y={ty} textAnchor="middle" dominantBaseline="middle"
                  fontSize={6} fill="#4b5563">
                  {Math.round(f * 100)}%
                </text>
              )
            })}
            {/* 꽃잎 */}
            {counts.map((count, i) => {
              const startDeg = i * sectorWidth - sectorWidth / 2
              const endDeg = startDeg + sectorWidth
              const r = count === 0 ? 0 : ringR(count / maxCount)
              const isDominant = i === dominantIdx && count > 0
              return (
                <path key={i} d={sectorPath(cx, cy, r, startDeg, endDeg)}
                  fill={isDominant ? '#f59e0b' : '#3b82f6'}
                  fillOpacity={isDominant ? 0.9 : 0.35 + 0.4 * (count / maxCount)}
                  stroke={isDominant ? '#fbbf24' : '#60a5fa'} strokeWidth={0.5} strokeOpacity={0.6} />
              )
            })}
            {/* 방위 라벨 (N/E/S/W) */}
            {[0, 90, 180, 270].map(deg => {
              const [lx, ly] = polar(cx, cy, maxR + 10, deg)
              return (
                <text key={deg} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
                  fontSize={9} fill="#64748b" fontWeight={600}>
                  {{ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[deg]}
                </text>
              )
            })}
            {/* 현재(최신) 풍향 마커 */}
            {latest !== null && (() => {
              const [mx, my] = polar(cx, cy, maxR + 4, latest)
              return <circle cx={mx} cy={my} r={2.5} fill="#fff" stroke="#0f172a" strokeWidth={1} />
            })()}
          </svg>
          <div className="text-[11px] text-gray-400 space-y-1">
            <div>
              <span className="text-gray-600">우세 풍향 </span>
              <span className="font-bold text-amber-400">{ROSE_LABELS[dominantIdx]}</span>
              <span className="text-gray-600"> ({Math.round(maxCount / total * 100)}%)</span>
            </div>
            {latest !== null && (
              <div>
                <span className="text-gray-600">최신 </span>
                <span className="font-semibold text-white">{Math.round(latest)}°</span>
              </div>
            )}
            <div className="text-gray-600">관측 {total}건</div>
          </div>
        </div>
      )}
    </ChartCard>
  )
}

// Visibility vs TAF
function VisChart({ data, nowMs, tempoRanges }: { data: ChartPoint[]; nowMs?: number; tempoRanges?: TempoRange[] }) {
  const hasTaf = data.some(d => d.taf_vis_m !== null)
  const visFmt = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}km` : `${v}m`
  return (
    <ChartCard title="시정 (m)">
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          {GRID}
          {xAxis(data)}
          <YAxis tickFormatter={visFmt} domain={[0, 10000]}
            tick={{ fill: '#64748b', fontSize: 9 }} tickLine={false} axisLine={false} width={62} />
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={xFmt}
            formatter={(v: any, name: any) => [v !== null ? visFmt(v) : '—', name]} />
          {/* CAT I reference line (RVR 기준) */}
          <ReferenceLine y={550} stroke="#f87171" strokeDasharray="2 4" strokeWidth={0.8} label={{ value: 'CAT I', fill: '#f87171', fontSize: 8, position: 'insideTopRight' }} />
          {nowLine(nowMs)}
          {hasTaf && (
            <Area type="stepAfter" dataKey="taf_vis_m" name="TAF 예보"
              stroke="#f97316" strokeWidth={1} strokeDasharray="4 2"
              fill="#f97316" fillOpacity={0.10} dot={false} connectNulls />
          )}
          <Line type="linear" dataKey="vis_m" name="실측 시정"
            stroke="#60a5fa" strokeWidth={1.5} dot={{ r: 2, fill: '#60a5fa', strokeWidth: 0 }} connectNulls />
          {(tempoRanges?.length ?? 0) > 0 && (
            <Line type="linear" dataKey="tempo_vis_m" name="TEMPO 예보"
              stroke="#fdba74" strokeWidth={2} strokeDasharray="1 2" dot={{ r: 2, fill: '#fdba74', strokeWidth: 0 }} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// QNH — METAR only (TAF doesn't forecast QNH)
function QnhChart({ data, nowMs }: { data: ChartPoint[]; nowMs?: number }) {
  // Y축 기본값(0부터 시작)으로 두면 990~1030대 QNH가 축 맨 위쪽에 다 뭉쳐서
  // 1~2hPa 변화가 안 보임 — 실측 데이터 범위에 맞춰 확대해서 보여줌
  return (
    <ChartCard title="기압 QNH (hPa)">
      <ResponsiveContainer width="100%" height={110}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          {GRID}
          {xAxis(data)}
          <YAxis domain={['dataMin - 1', 'dataMax + 1']} allowDecimals={false}
            tick={{ fill: '#64748b', fontSize: 9 }} tickLine={false} axisLine={false}
            width={62} unit="hPa" />
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={xFmt}
            formatter={(v: any) => [`${v ?? '—'} hPa`, 'QNH']} />
          {nowLine(nowMs)}
          <Line type="linear" dataKey="qnh_hpa" name="실측 QNH"
            stroke="#60a5fa" strokeWidth={1.5} dot={{ r: 2, fill: '#60a5fa', strokeWidth: 0 }} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// Ceiling vs TAF
function CeilingChart({ data, nowMs, tempoRanges }: { data: ChartPoint[]; nowMs?: number; tempoRanges?: TempoRange[] }) {
  const hasTaf = data.some(d => d.taf_ceiling_ft !== null)
  const ceilFmt = (v: number) => `${v.toLocaleString()}ft`
  return (
    <ChartCard title="운고 (ft)" subtitle="BKN·OVC(5/8 이상 뒤덮음)만 반영 — FEW·SCT는 하늘이 트여 있다고 봐서 제외">
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          {GRID}
          {xAxis(data)}
          <YAxis tickFormatter={ceilFmt} tick={{ fill: '#64748b', fontSize: 9 }} tickLine={false} axisLine={false} width={62} />
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={xFmt}
            formatter={(v: any, name: any) => [v !== null ? ceilFmt(v) : '—', name]} />
          <ReferenceLine y={200} stroke="#f87171" strokeDasharray="2 4" strokeWidth={0.8} label={{ value: 'CAT I', fill: '#f87171', fontSize: 8, position: 'insideTopRight' }} />
          {nowLine(nowMs)}
          {hasTaf && (
            <Area type="stepAfter" dataKey="taf_ceiling_ft" name="TAF 예보"
              stroke="#f97316" strokeWidth={1} strokeDasharray="4 2"
              fill="#f97316" fillOpacity={0.10} dot={false} connectNulls />
          )}
          <Line type="linear" dataKey="ceiling_ft" name="실측 운고"
            stroke="#60a5fa" strokeWidth={1.5} dot={{ r: 2, fill: '#60a5fa', strokeWidth: 0 }} connectNulls />
          {(tempoRanges?.length ?? 0) > 0 && (
            <Line type="linear" dataKey="tempo_ceiling_ft" name="TEMPO 예보"
              stroke="#fdba74" strokeWidth={2} strokeDasharray="1 2" dot={{ r: 2, fill: '#fdba74', strokeWidth: 0 }} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// Temperature & Dewpoint
function TempChart({ data, nowMs }: { data: ChartPoint[]; nowMs?: number }) {
  return (
    <ChartCard title="기온 / 이슬점 (°C)">
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          {GRID}
          {xAxis(data)}
          {yAxis('°C', 62)}
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={xFmt}
            formatter={(v: any, name: any) => [`${v ?? '—'} °C`, name]} />
          {nowLine(nowMs)}
          <Area type="linear" dataKey="temp_c" name="실측 기온"
            stroke="#60a5fa" strokeWidth={1.5} fill="#60a5fa" fillOpacity={0.08}
            dot={{ r: 2, fill: '#60a5fa', strokeWidth: 0 }} connectNulls />
          <Line type="linear" dataKey="dewpoint_c" name="실측 이슬점"
            stroke="#22d3ee" strokeWidth={1} strokeDasharray="4 2"
            dot={{ r: 2, fill: '#22d3ee', strokeWidth: 0 }} connectNulls />
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

// ─── Raw METAR / TAF ────────────────────────────────────────────────────────

function MetarBlock({ raw }: { raw: string | null }) {
  if (!raw) return null
  return (
    <div className="text-[10px] bg-gray-900 rounded-lg border border-gray-800 px-3 py-2">
      <div className="font-semibold text-gray-500 uppercase tracking-wide mb-1">METAR</div>
      <div className="font-mono text-gray-300 leading-relaxed break-all">{raw}</div>
    </div>
  )
}

// BECMG/TEMPO/PROBnn 그룹마다 줄바꿈 (PROBnn 바로 뒤 TEMPO는 같은 줄로 유지)
function formatTafLines(raw: string): string[] {
  const tokens = raw.split(/\s+/).filter(Boolean)
  const lines: string[][] = []
  let current: string[] = []
  for (const tok of tokens) {
    const isBreakKeyword = tok === 'BECMG' || tok === 'TEMPO' || /^PROB\d{2}$/.test(tok)
    const prevWasProb = current.length > 0 && /^PROB\d{2}$/.test(current[current.length - 1])
    if (isBreakKeyword && current.length > 0 && !(tok === 'TEMPO' && prevWasProb)) {
      lines.push(current)
      current = [tok]
    } else {
      current.push(tok)
    }
  }
  if (current.length > 0) lines.push(current)
  return lines.map(l => l.join(' '))
}

function TafBlock({ raw, periods }: { raw: string | null; periods: TafPeriod[] }) {
  const [open, setOpen] = useState(false)
  if (!raw) return null
  return (
    <div className="text-[10px] bg-gray-900 rounded-lg border border-gray-800 px-3 py-2">
      <div className="font-semibold text-gray-500 uppercase tracking-wide mb-1">TAF</div>
      <div className="font-mono text-gray-300 leading-relaxed break-all space-y-0.5">
        {formatTafLines(raw).map((line, i) => <div key={i}>{line}</div>)}
      </div>
      <button onClick={() => setOpen(v => !v)} className="mt-2 flex items-center gap-1 text-gray-600 hover:text-gray-300">
        <span>구간별 상세</span>
        <span>{open ? '▲' : '▼'}</span>
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

  // 근무자가 창을 켜놓고 계속 볼 수 있으니, 자동으로 5분마다 새로 받아와서
  // "지금" 이전 값이 옛날 TAF 스냅샷에 멈춰있는 일이 없게 함
  useEffect(() => {
    if (mode !== 'realtime') return
    const id = setInterval(loadRealtime, 5 * 60_000)
    return () => clearInterval(id)
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
  const tafHistory = mode === 'realtime' ? (trendData?.taf_history ?? []) : []
  // 실시간 모드에서만 "지금 이후" TAF 예보를 미래 구간까지 이어서 그림 (장기 조회엔 TAF가 없음)
  const futureEnd = useMemo(() => mode === 'realtime' ? tafForecastEnd(tafPeriods) : null, [mode, tafPeriods])
  const tempoRanges = useMemo(
    () => mode === 'realtime' ? extractTempoRanges(tafPeriods, tafHistory) : [],
    [mode, tafPeriods, tafHistory],
  )
  const chartData = useMemo(
    () => buildChartData(metarPoints, tafPeriods, tafHistory, futureEnd, tempoRanges),
    [metarPoints, tafPeriods, tafHistory, futureEnd, tempoRanges],
  )
  // "지금" 기준선도 미래 예보 시작점과 같은 정시 경계에 맞춤 — 실제 관측이 끝나고
  // TAF 전용 예보 구간이 시작되는 지점을 그대로 표시
  const nowMs = mode === 'realtime' && futureEnd ? Math.ceil(Date.now() / 3600_000) * 3600_000 : undefined

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

          {/* Real-time hours selector — 과거로 몇 시간치 METAR를 조회할지 (TAF는 항상 전체 예보기간을 표시) */}
          {mode === 'realtime' && (
            <div className="flex items-center gap-1 ml-1" title="지금 기준으로 과거 몇 시간치 METAR를 볼지 선택 — TAF 예보는 이 설정과 무관하게 항상 전체 유효기간까지 표시됩니다">
              <span className="text-[10px] text-gray-600">최근</span>
              <div className="flex gap-0.5">
                {([12, 24, 48] as const).map(h => (
                  <button key={h} onClick={() => setHours(h)}
                    className={`px-2 py-0.5 rounded text-xs font-mono transition-colors border ${hours === h ? 'bg-blue-900/50 text-blue-300 border-blue-700' : 'text-gray-500 border-transparent hover:text-gray-300'}`}>
                    {h}h
                  </button>
                ))}
              </div>
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

          {mode === 'realtime' && metarPoints.length > 0 && (
            <MetarBlock raw={metarPoints[metarPoints.length - 1].raw} />
          )}

          {mode === 'realtime' && trendData?.taf_raw && (
            <TafBlock raw={trendData.taf_raw} periods={trendData.taf_periods} />
          )}

          {/* Charts — 원시 시계열 */}
          {(mode === 'realtime' || histView === 'raw') && chartData.length > 0 && (
            <>
              <WindRoseChart data={chartData} />
              <WindSpeedChart data={chartData} nowMs={nowMs} tempoRanges={tempoRanges} />
              <VisChart data={chartData} nowMs={nowMs} tempoRanges={tempoRanges} />
              <CeilingChart data={chartData} nowMs={nowMs} tempoRanges={tempoRanges} />
              <TempChart data={chartData} nowMs={nowMs} />
              <QnhChart data={chartData} nowMs={nowMs} />
            </>
          )}

          {/* Monthly stats */}
          {mode === 'history' && histView === 'monthly' && monthlyData && monthlyData.length > 0 && (
            <MonthlyCharts months={monthlyData} />
          )}

          {/* Empty states — "아직 조회 안 함"과 "조회했는데 결과 0건"을 구분해서
              보여줌. 안 그러면 조회 버튼을 눌러도 초기 안내문구가 그대로 떠서
              마치 아무 반응이 없는 것처럼 보임 */}
          {!loading && chartData.length === 0 && (mode === 'realtime' || histView === 'raw') && (
            <p className="text-xs text-gray-500 text-center py-8">
              {mode === 'history'
                ? (histPoints === null
                    ? '기간을 선택하고 [조회]를 눌러주세요.'
                    : '선택한 기간에 수집된 데이터가 없습니다 — [데이터 수집]을 먼저 눌러주세요.')
                : 'METAR 데이터가 없습니다.'}
            </p>
          )}
          {!loading && mode === 'history' && histView === 'monthly' && (!monthlyData || monthlyData.length === 0) && (
            <p className="text-xs text-gray-500 text-center py-8">
              {monthlyData === null
                ? '기간을 선택하고 [조회]를 눌러주세요.'
                : '선택한 기간에 수집된 데이터가 없습니다 — [데이터 수집]을 먼저 눌러주세요.'}
            </p>
          )}
        </div>

        {/* ── Legend footer ── */}
        {mode === 'realtime' && chartData.length > 0 && (trendData?.taf_periods?.length ?? 0) > 0 && (
          <div className="px-4 py-2 border-t border-gray-800 flex gap-4 text-[10px] text-gray-500 shrink-0">
            <span className="flex items-center gap-1"><span className="w-4 h-0.5 bg-blue-400 inline-block" /> 실측값</span>
            <span className="flex items-center gap-1"><span className="w-4 h-0.5 border-t border-dashed border-orange-400 inline-block" /> TAF 예보</span>
            {nowMs !== undefined && (
              <span className="flex items-center gap-1"><span className="w-4 h-0.5 border-t border-dashed border-gray-500 inline-block" /> 지금 기준선 (이후는 TAF 예보만)</span>
            )}
            {tempoRanges.length > 0 && (
              <span className="flex items-center gap-1"><span className="w-4 h-0.5 border-t border-dashed border-orange-300 inline-block" /> TEMPO 예보값</span>
            )}
            <span className="ml-auto">UTC 기준</span>
          </div>
        )}
      </div>
    </div>
  )
}
