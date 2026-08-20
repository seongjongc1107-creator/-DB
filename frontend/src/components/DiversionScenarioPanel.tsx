import { useEffect, useState } from 'react'
import { Info, RefreshCw, Search, Shuffle, Sparkles } from 'lucide-react'
import { api } from '../api/client'
import { airlineColor } from '../lib/airlineColors'
import type { CountryInfo, DiversionCandidate, ScenarioFlight, ScenarioQueryStatus, ScenarioReroute } from '../types'

// ─── 우회입항 시나리오 조회 ───────────────────────────────────────────────
// ATFM 우회입항 절차 대응용 — "지금 흐름관리가 걸리면 몇 편이나 영향권(제약
// waypoint 필드편)에 있고, 몇 편이 이미 우회 waypoint로 나가고 있는지"를
// 실시간으로 보여줌. fpl_archive(과거 이력)가 아니라 FOIS 라이브 스케줄+FPL을
// 그 자리에서 조회(백엔드가 아직 출발 안 한 편만 걸러줌).

// 입력창은 UTC 기준 — ATFM 쪽은 보통 Zulu로 소통하는 게 익숙해서. 백엔드는
// FOIS 스케줄(KST 기준)과 맞춰야 하니, 보낼 때만 UTC→KST(+9h)로 변환함.
function toUtcInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function utcInputToKstIso(value: string): string {
  const d = new Date(`${value}:00Z`) // 입력값을 UTC 벽시계로 명시 파싱
  const kst = new Date(d.getTime() + 9 * 3600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}T${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}`
}

// sched_dep은 KST 벽시계를 그대로 담은 naive ISO라, 브라우저가 로컬(KST)로
// 해석하도록 둔 뒤 UTC 필드로 읽으면(9시간 전) 결과가 정확한 UTC 표시가 됨
function timeOfUtc(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// datetime-local 네이티브 위젯은 브라우저 로케일에 따라 오전/오후로 표시돼서
// (lang 속성으로도 못 고치는 환경이 있음) 날짜(date, 오전/오후 문제 없음)와
// 시:분(순수 텍스트, 항상 24시간제)을 분리해서 직접 조합함
function splitDateTime(value: string): [string, string] {
  const [d, t] = value.split('T')
  return [d ?? '', t ?? '00:00']
}
function joinDateTime(datePart: string, timePart: string): string {
  return `${datePart}T${/^\d{2}:\d{2}$/.test(timePart) ? timePart : '00:00'}`
}

function FlightRow({ f }: { f: ScenarioFlight }) {
  return (
    <div className="text-[11px] bg-gray-950/60 border border-gray-800 rounded px-2 py-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-gray-500 shrink-0 font-mono">{timeOfUtc(f.sched_dep)}Z</span>
        <span className="font-mono shrink-0" style={{ color: airlineColor(f.callsign) }}>{f.callsign}</span>
        <span className="text-gray-400 shrink-0">{f.dep} → {f.arr}</span>
        <span className="text-gray-600 shrink-0">{f.ac_type}</span>
      </div>
      <div className="text-[10px] text-gray-500 font-mono break-all mt-0.5">{f.route}</div>
    </div>
  )
}

function RerouteBlock({ options }: { options: ScenarioReroute[] }) {
  if (options.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-gray-500 bg-gray-950/60 border border-gray-800 rounded-md px-2 py-1.5">
        <Shuffle size={12} className="text-gray-600 shrink-0" />
        추천 우회항로 없음 — 이 구간으로 우회 waypoint를 지난 전례가 없음
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      {options.map((r, i) => (
        <div key={i} className="bg-amber-500/10 border border-amber-600/50 rounded-md px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold text-amber-300">
            <Shuffle size={12} className="shrink-0" />
            추천 우회항로{options.length > 1 ? ` #${i + 1}` : ''}
            <span className="ml-auto text-[10px] font-normal text-amber-200/70">
              {r.count}회 사용 · 최근 {r.last_flown}
            </span>
          </div>
          <div className="flex items-center gap-1 flex-wrap mt-1">
            <span className="text-[10px] text-gray-500">사용 항공사:</span>
            {r.airlines.map(al => (
              <span key={al} className="text-[10px] font-mono font-semibold" style={{ color: airlineColor(al) }}>{al}</span>
            ))}
          </div>
          <div className="text-[10px] mt-1">
            {r.navblue_number != null
              ? <span className="text-green-400">✓ NAVBLUE 항로 DB #{r.navblue_number}와 일치</span>
              : <span className="text-gray-500">NAVBLUE 항로 DB엔 미등록 — 과거 제출 실적만 있음</span>}
          </div>
          <div className="text-[10px] font-mono break-all text-amber-100/90 mt-1">{r.route}</div>
        </div>
      ))}
    </div>
  )
}

function isOwnAirline(callsign: string): boolean {
  return callsign.slice(0, 3).toUpperCase() === 'JJA'
}

// 출발공항/OD쌍 무관하게 시간순으로 쭉 — 궁금한 건 "우리 편 앞에 몇 대가
// 그 fix를 먼저 지나가는지"라, OD별로 쪼개놓으면 오히려 순서가 안 보임.
// 자사(JJA)편만 강조 표시하고, 우회항로 추천은 필요할 때만 펼쳐보게 토글로 뺌.
function ConstrainedTimeline({
  flights, recommendations, showReroute,
}: {
  flights: ScenarioFlight[]; recommendations: Record<string, ScenarioReroute[]>; showReroute: boolean
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  function toggle(pk: number) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(pk)) next.delete(pk)
      else next.add(pk)
      return next
    })
  }

  return (
    <div className="space-y-1">
      {flights.map((f, i) => {
        const own = isOwnAirline(f.callsign)
        const ahead = i // 이미 sched_dep 기준 정렬돼 있으니, 인덱스가 곧 앞서 지나가는 전체 편수
        const key = `${f.dep}-${f.arr}`
        const recs = recommendations[key] ?? []
        return (
          <div key={f.ams_rec_pk}>
            <div className={`text-[11px] rounded px-2 py-1.5 border ${own ? 'bg-orange-500/10 border-orange-600/60' : 'bg-gray-950/60 border-gray-800'}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-gray-500 shrink-0 font-mono">{timeOfUtc(f.sched_dep)}Z</span>
                <span className={`font-mono shrink-0 ${own ? 'font-bold' : ''}`} style={{ color: airlineColor(f.callsign) }}>{f.callsign}</span>
                {own && ahead > 0 && (
                  <span className="text-[9px] text-orange-300 bg-orange-900/40 px-1 py-0.5 rounded shrink-0">앞서 {ahead}편</span>
                )}
                <span className="text-gray-400 shrink-0">{f.dep} → {f.arr}</span>
                <span className="text-gray-600 shrink-0">{f.ac_type}</span>
                {own && showReroute && (
                  <button
                    onClick={() => toggle(f.ams_rec_pk)}
                    className="ml-auto flex items-center gap-1 text-[10px] text-amber-400 hover:text-amber-300 shrink-0"
                  >
                    <Shuffle size={10} /> 우회항로 {expanded.has(f.ams_rec_pk) ? '닫기' : '보기'}
                  </button>
                )}
              </div>
              <div className="text-[10px] text-gray-500 font-mono break-all mt-0.5">{f.route}</div>
            </div>
            {own && showReroute && expanded.has(f.ams_rec_pk) && (
              <div className="mt-1 ml-2">
                <RerouteBlock options={recs} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function DiversionScenarioPanel() {
  const [open, setOpen] = useState(false)
  const [constrained, setConstrained] = useState('')
  const [diversion, setDiversion] = useState('')
  const [mode, setMode] = useState<'country' | 'airport'>('country')
  const [locCode, setLocCode] = useState('')
  const [direction, setDirection] = useState<'dep' | 'arr'>('dep')
  const [start, setStart] = useState(() => toUtcInputValue(new Date()))
  const [end, setEnd] = useState(() => toUtcInputValue(new Date(Date.now() + 6 * 3600_000)))
  const [countries, setCountries] = useState<CountryInfo[]>([])
  const [showHelp, setShowHelp] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ScenarioQueryStatus | null>(null)
  const [queriedDiversion, setQueriedDiversion] = useState('')
  const [inferLoading, setInferLoading] = useState(false)
  const [inferError, setInferError] = useState<string | null>(null)
  const [inferCandidates, setInferCandidates] = useState<DiversionCandidate[] | null>(null)
  const [showAllCandidates, setShowAllCandidates] = useState(false)
  const [expandedCandidate, setExpandedCandidate] = useState<string | null>(null)

  useEffect(() => {
    if (open && countries.length === 0) {
      api.fois.countryList().then(r => setCountries(r.countries)).catch(() => {})
    }
  }, [open, countries.length])

  async function handleInferDiversion() {
    const c = constrained.trim().toUpperCase()
    if (!c) {
      setInferError('제약 waypoint를 먼저 입력하세요')
      return
    }
    setInferLoading(true); setInferError(null); setInferCandidates(null); setShowAllCandidates(false); setExpandedCandidate(null)
    try {
      // 위에서 이미 공항 단위로 노선을 좁혀뒀으면(국가 단위는 공항이 여러 개라
      // 하나의 dep/arr로 못 좁힘) 그 방향에 맞춰 추천도 같은 노선으로 좁힘 —
      // 예: MUGUS로 대만행이랑 필리핀행이 다른 fix로 우회했을 수 있어서
      const loc = mode === 'airport' ? locCode.trim().toUpperCase() : ''
      const scoped: { waypoint: string; dep?: string; arr?: string } = { waypoint: c }
      if (loc) {
        if (direction === 'dep') scoped.dep = loc
        else scoped.arr = loc
      }
      const res = await api.fois.inferDiversion(scoped)
      if (res.error) throw new Error(res.error)
      setInferCandidates(res.candidates)
    } catch (e) {
      setInferError(String(e instanceof Error ? e.message : e))
    } finally {
      setInferLoading(false)
    }
  }

  async function handleQuery() {
    const c = constrained.trim().toUpperCase()
    const dv = diversion.trim().toUpperCase()
    const loc = locCode.trim().toUpperCase()
    if (!c || !loc) {
      setError('제약 waypoint와 국가 또는 공항 코드를 입력하세요')
      return
    }
    setLoading(true); setError(null); setResult(null); setQueriedDiversion(dv)
    try {
      const params: Parameters<typeof api.fois.scenarioQuery>[0] = {
        direction,
        start: utcInputToKstIso(start),
        end: utcInputToKstIso(end),
        constrained: c,
      }
      if (dv) params.diversion = dv
      if (mode === 'country') params.country = loc
      else params.airport = loc

      const res = await api.fois.scenarioQuery(params)
      if (res.error) throw new Error(res.error)
      const taskId = res.task_id
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(async () => {
          const s = await api.fois.scenarioStatus(taskId)
          setResult(s)
          if (s.status === 'done' || s.status === 'error' || s.status === 'cancelled') {
            clearInterval(poll)
            if (s.status === 'error') reject(new Error(s.error ?? '조회 실패'))
            else resolve()
          }
        }, 2000)
      })
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-gray-900/60 border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-2.5 py-2 text-[11px] font-semibold text-gray-300 hover:text-white transition-colors"
      >
        <span className="flex items-center gap-1.5"><Shuffle size={12} className="text-gray-500" /> 우회입항 시나리오 조회</span>
        <span className="text-gray-600">{open ? '접기' : '펼치기'}</span>
      </button>

      {open && (
        <div className="px-2.5 pb-2.5 space-y-2.5">
          <div className="flex items-end gap-2 flex-wrap">
            <div className="text-[11px] text-gray-400">
              범위
              <div className="flex items-center gap-1 mt-1">
                <button
                  onClick={() => setMode('country')}
                  className={`text-[10px] px-1.5 py-1 rounded ${mode === 'country' ? 'bg-cyan-900/60 text-cyan-300' : 'bg-gray-800 text-gray-500'}`}
                >
                  국가
                </button>
                <button
                  onClick={() => setMode('airport')}
                  className={`text-[10px] px-1.5 py-1 rounded ${mode === 'airport' ? 'bg-cyan-900/60 text-cyan-300' : 'bg-gray-800 text-gray-500'}`}
                >
                  공항
                </button>
              </div>
            </div>
            <label className="text-[11px] text-gray-400 relative">
              {mode === 'country' ? '국가코드' : '공항코드'}
              <div className="flex items-center gap-1 mt-1">
                <input
                  value={locCode} onChange={e => setLocCode(e.target.value)}
                  placeholder={mode === 'country' ? 'JP' : 'RJAA'}
                  className="w-20 bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-xs text-white uppercase"
                />
                {mode === 'country' && (
                  <button type="button" onClick={() => setShowHelp(v => !v)} className="text-gray-500 hover:text-gray-300">
                    <Info size={12} />
                  </button>
                )}
              </div>
              {showHelp && mode === 'country' && (
                <div className="absolute z-10 top-full left-0 mt-1 w-60 max-h-48 overflow-y-auto bg-gray-950 border border-gray-700 rounded-lg p-2 text-[10px] text-gray-400 shadow-xl grid grid-cols-2 gap-x-2 gap-y-0.5">
                  {countries.length === 0
                    ? <span className="col-span-2 text-gray-600">불러오는 중…</span>
                    : countries.map(c => <div key={c.code}><b className="text-gray-300">{c.code}</b> {c.name}</div>)}
                </div>
              )}
            </label>
            <div className="text-[11px] text-gray-400">
              방향
              <div className="flex items-center gap-1 mt-1">
                <button
                  onClick={() => setDirection('dep')}
                  className={`text-[10px] px-1.5 py-1 rounded ${direction === 'dep' ? 'bg-cyan-900/60 text-cyan-300' : 'bg-gray-800 text-gray-500'}`}
                >
                  출발
                </button>
                <button
                  onClick={() => setDirection('arr')}
                  className={`text-[10px] px-1.5 py-1 rounded ${direction === 'arr' ? 'bg-cyan-900/60 text-cyan-300' : 'bg-gray-800 text-gray-500'}`}
                >
                  도착
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-end gap-2 flex-wrap">
            <label className="text-[11px] text-gray-400">
              시작 <span className="text-gray-600">(UTC, 24시간제)</span>
              <div className="flex items-center gap-1 mt-1">
                <input
                  type="date" value={splitDateTime(start)[0]}
                  onChange={e => setStart(joinDateTime(e.target.value, splitDateTime(start)[1]))}
                  className="bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-white"
                />
                <input
                  type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5}
                  value={splitDateTime(start)[1]}
                  onChange={e => setStart(joinDateTime(splitDateTime(start)[0], e.target.value))}
                  className="w-14 bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-white font-mono"
                />
              </div>
            </label>
            <label className="text-[11px] text-gray-400">
              종료 <span className="text-gray-600">(UTC, 24시간제)</span>
              <div className="flex items-center gap-1 mt-1">
                <input
                  type="date" value={splitDateTime(end)[0]}
                  onChange={e => setEnd(joinDateTime(e.target.value, splitDateTime(end)[1]))}
                  className="bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-white"
                />
                <input
                  type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5}
                  value={splitDateTime(end)[1]}
                  onChange={e => setEnd(joinDateTime(splitDateTime(end)[0], e.target.value))}
                  className="w-14 bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-white font-mono"
                />
              </div>
            </label>
          </div>

          <div className="border-t border-gray-800" />

          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-[11px] text-gray-400">
              제약 waypoint
              <input
                value={constrained} onChange={e => setConstrained(e.target.value)}
                placeholder="예: GUKDO"
                className="block mt-1 w-28 bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-xs text-white uppercase"
              />
            </label>
            <label className="text-[11px] text-gray-400">
              우회 waypoint <span className="text-gray-600">(선택)</span>
              <div className="flex items-center gap-1 mt-1">
                <input
                  value={diversion} onChange={e => setDiversion(e.target.value)}
                  placeholder="비우면 제약경로 통과편만"
                  className="w-40 bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-xs text-white uppercase"
                />
                <button
                  type="button" onClick={handleInferDiversion} disabled={inferLoading}
                  title={mode === 'airport' && locCode.trim()
                    ? `과거 실적으로 우회 waypoint 추천받기 (${direction === 'dep' ? locCode.trim().toUpperCase() + ' 출발' : locCode.trim().toUpperCase() + ' 도착'} 노선으로 좁혀서 추천)`
                    : '과거 실적으로 우회 waypoint 추천받기 (범위를 공항으로 좁히면 그 노선만 추천)'}
                  className="flex items-center gap-1 text-[10px] text-purple-400 hover:text-purple-300 disabled:opacity-50 shrink-0 px-1.5 py-1 bg-purple-900/30 border border-purple-700/50 rounded"
                >
                  {inferLoading ? <RefreshCw size={11} className="animate-spin" /> : <Sparkles size={11} />}
                  추천받기
                </button>
              </div>
            </label>
          </div>

          {mode === 'airport' && locCode.trim() && (
            <div className="text-[10px] text-purple-300/70">
              추천은 {locCode.trim().toUpperCase()} {direction === 'dep' ? '출발' : '도착'} 노선 기준으로 좁혀서 조회됩니다
            </div>
          )}

          {inferError && <div className="text-[10px] text-red-400">{inferError}</div>}

          {inferCandidates && (
            <div className="bg-purple-950/20 border border-purple-800/50 rounded-md p-2 space-y-1.5">
              <div className="text-[10px] text-purple-300 font-semibold">
                "{constrained.trim().toUpperCase()}" 대신 실제로 탄 waypoint (FIR 경계 우선순위, 필터 없음 — {inferCandidates.length}개)
              </div>
              {inferCandidates.length === 0 ? (
                <div className="text-[10px] text-gray-500">과거 실적에서 이 waypoint를 평시로 쓰던 OD를 못 찾았음</div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {(showAllCandidates ? inferCandidates : inferCandidates.slice(0, 15)).map(c => (
                    <button
                      key={c.waypoint}
                      onClick={() => {
                        setDiversion(c.waypoint)
                        setExpandedCandidate(prev => prev === c.waypoint ? null : c.waypoint)
                      }}
                      title={`${c.count}건 · 항공사 ${c.airlines.length}개 · ${c.fir_boundary ? `FIR 경계 ${c.boundary_dist_km}km` : '경계 아님'} — 클릭하면 상세 근거 펼침`}
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                        expandedCandidate === c.waypoint
                          ? 'ring-1 ring-cyan-400'
                          : ''
                      } ${
                        c.fir_boundary
                          ? 'bg-green-900/30 border-green-700 text-green-300 hover:bg-green-900/50'
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      {c.waypoint} <span className="opacity-70">{c.count}</span>
                      <span className="opacity-50">·{c.airlines.length}사</span>
                    </button>
                  ))}
                  {!showAllCandidates && inferCandidates.length > 15 && (
                    <button
                      onClick={() => setShowAllCandidates(true)}
                      className="text-[10px] text-cyan-400 hover:text-cyan-300 px-1.5 py-0.5"
                    >
                      {inferCandidates.length - 15}개 더 보기
                    </button>
                  )}
                </div>
              )}

              {expandedCandidate && (() => {
                const c = inferCandidates.find(x => x.waypoint === expandedCandidate)
                if (!c) return null
                return (
                  <div className="bg-gray-950/60 border border-gray-800 rounded p-2 space-y-2 mt-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-white">{c.waypoint} 근거</span>
                      <span className="text-[10px] text-gray-500">
                        {c.airlines.map(a => `${a.code}(${a.count})`).join(' · ')}
                      </span>
                    </div>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      {c.examples.map((ex, i) => (
                        <div key={i} className="text-[10px] border-l-2 border-gray-700 pl-1.5">
                          <div className="text-gray-300">
                            <b>{ex.dep} → {ex.arr}</b>{' '}
                            <span className="text-gray-500">{ex.count}건 · 겹침율 {Math.round(ex.common_ratio * 100)}% · {ex.airlines.map(a => a.code).join(', ')}</span>
                          </div>
                          <div className="text-gray-500">
                            {ex.flights.map(f => `${f.callsign}(${f.flight_date})`).join(', ')}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
            </div>
          )}

          <button
            onClick={handleQuery}
            disabled={loading}
            className="flex items-center gap-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-[11px] font-semibold px-2.5 py-1.5 rounded transition-colors"
          >
            {loading ? <RefreshCw size={11} className="animate-spin" /> : <Search size={11} />}
            조회
          </button>

          {error && <div className="text-[10px] text-red-400">{error}</div>}

          {loading && result && result.status === 'running' && (
            <div className="text-[10px] text-gray-500 flex items-center gap-1.5">
              <RefreshCw size={10} className="animate-spin text-blue-400" />
              {result.processed}/{result.total}편 확인 중…
            </div>
          )}

          {result && result.status === 'done' && (
            <div className="space-y-3">
              <div className="text-[10px] text-gray-500">
                제약경로 {result.constrained_flights.length}편
                {queriedDiversion && ` · 이미 우회 중 ${result.diversion_flights.length}편`}
              </div>

              {result.constrained_flights.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[10px] text-gray-500 uppercase tracking-wide">
                    제약 waypoint 통과편 — 출발시간순 (<span className="text-orange-300">제주항공</span> 강조)
                  </div>
                  <ConstrainedTimeline
                    flights={result.constrained_flights} recommendations={result.recommendations}
                    showReroute={!!queriedDiversion}
                  />
                </div>
              )}

              {queriedDiversion && result.diversion_flights.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] text-gray-500 uppercase tracking-wide">이미 우회 waypoint로 필드된 편</div>
                  {result.diversion_flights.map(f => <FlightRow key={f.ams_rec_pk} f={f} />)}
                </div>
              )}

              {result.constrained_flights.length === 0 && result.diversion_flights.length === 0 && (
                <div className="text-[10px] text-gray-500 text-center py-4">해당 조건에 걸리는 출발예정편이 없습니다</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
