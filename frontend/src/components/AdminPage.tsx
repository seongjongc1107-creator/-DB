import { useEffect, useState } from 'react'
import { X, ShieldCheck, Upload, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Database, Cloud, Wind, Mountain, Moon } from 'lucide-react'
import { api } from '../api/client'
import type { AdminDataStatus, AdminMinimaUploadResult, AdminUploadResult, MetarData } from '../types'

interface Props {
  onClose: () => void
}

// 대표 표본 — 이 몇 개만 봐도 aviationweather.gov가 지금 살아있는지 감이 옴
const SAMPLE_ICAOS = ['RKSI', 'RKPC', 'RKPK', 'RJTT', 'RCTP', 'VHHH', 'WSSS', 'VTBS']
const STALE_MIN = 180 // 3시간 넘게 관측 갱신 없으면 오래된 걸로 표시

function minutesAgo(iso: string): number | null {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.round((Date.now() - t) / 60000)
}

// ─── 외부 실시간 데이터 소스 상태 (읽기 전용, 비밀번호 불필요) ──────────────

type SourceState = 'checking' | 'ok' | 'error'

function SourceCard({
  icon, label, state, detail, warn,
}: {
  icon: React.ReactNode
  label: string
  state: SourceState
  detail: string
  warn?: boolean
}) {
  return (
    <div className="flex items-start gap-2.5 bg-gray-900/60 border border-gray-700 rounded-lg p-3">
      <div className="text-gray-500 mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-bold text-white">{label}</span>
          {state === 'checking' && <RefreshCw size={11} className="animate-spin text-gray-500" />}
          {state === 'ok' && !warn && <CheckCircle2 size={12} className="text-green-500" />}
          {(state === 'error' || warn) && state !== 'checking' && <XCircle size={12} className="text-red-500" />}
        </div>
        <div className="text-[11px] text-gray-400 mt-0.5 whitespace-pre-line">{detail}</div>
      </div>
    </div>
  )
}

function ExternalSourcesStatus() {
  const [metar, setMetar] = useState<{ state: SourceState; detail: string; warn: boolean }>(
    { state: 'checking', detail: '확인 중…', warn: false },
  )
  const [typhoon, setTyphoon] = useState<{ state: SourceState; detail: string }>(
    { state: 'checking', detail: '확인 중…' },
  )
  const [ash, setAsh] = useState<{ state: SourceState; detail: string }>(
    { state: 'checking', detail: '확인 중…' },
  )
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)

  function runChecks() {
    setMetar({ state: 'checking', detail: '확인 중…', warn: false })
    setTyphoon({ state: 'checking', detail: '확인 중…' })
    setAsh({ state: 'checking', detail: '확인 중…' })
    setCheckedAt(new Date())

    api.weather.bulk(SAMPLE_ICAOS).then(res => {
      if (res.error || !res.data) {
        setMetar({ state: 'error', detail: res.error || '응답 없음', warn: true })
        return
      }
      // /weather/metar는 관측 이력을 여러 건 섞어서 주기 때문에(공항당 최근 몇 시간치),
      // 그냥 마지막 항목을 집으면 station별로 가장 오래된 게 남을 수 있음 — obs_time이
      // 가장 최신인 것만 골라야 실제로 얼마나 갱신이 밀렸는지 정확히 나옴
      const byIcao = new Map<string, MetarData>()
      for (const d of res.data) {
        const prev = byIcao.get(d.icao)
        if (!prev || d.obs_time > prev.obs_time) byIcao.set(d.icao, d)
      }
      const ages = SAMPLE_ICAOS.map(icao => {
        const d = byIcao.get(icao)
        const age = d ? minutesAgo(d.obs_time) : null
        return { icao, age }
      })
      const stale = ages.filter(a => a.age == null || a.age > STALE_MIN)
      const lines = ages.map(a => `${a.icao} ${a.age == null ? '— 관측 없음' : `${a.age}분 전`}`).join('  ·  ')
      setMetar({
        state: 'ok', warn: stale.length > 0,
        detail: `${lines}${stale.length > 0 ? `\n⚠ ${stale.map(s => s.icao).join(', ')} 오래됨/누락(${STALE_MIN}분 기준)` : ''}`,
      })
    }).catch(e => setMetar({ state: 'error', detail: String(e), warn: true }))

    api.typhoon.active().then(res => {
      if (res.error) { setTyphoon({ state: 'error', detail: res.error }); return }
      setTyphoon({ state: 'ok', detail: `출처: ${res.source} · 활성 태풍 ${res.count}개` })
    }).catch(e => setTyphoon({ state: 'error', detail: String(e) }))

    api.volcanicAsh.active().then(res => {
      if (res.error) { setAsh({ state: 'error', detail: res.error }); return }
      setAsh({ state: 'ok', detail: `출처: ${res.source} · 활성 권고 ${res.count}건` })
    }).catch(e => setAsh({ state: 'error', detail: String(e) }))
  }

  useEffect(() => { runChecks() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-bold text-gray-300">외부 실시간 데이터 소스 상태</h3>
        <div className="flex items-center gap-2">
          {checkedAt && <span className="text-[10px] text-gray-600">{checkedAt.toLocaleTimeString('ko-KR')} 확인</span>}
          <button
            onClick={runChecks}
            className="flex items-center gap-1 text-[10px] text-cyan-400 hover:text-cyan-300"
          >
            <RefreshCw size={10} /> 새로고침
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2">
        <SourceCard icon={<Cloud size={14} />} label="METAR/TAF (aviationweather.gov)" {...metar} />
        <SourceCard icon={<Wind size={14} />} label="태풍 (GDACS)" {...typhoon} />
        <SourceCard icon={<Mountain size={14} />} label="화산재 (BOM VAAC 집계)" {...ash} />
      </div>
    </div>
  )
}

// ─── 근간 데이터(NAVDATA/항로 DB) 업로드 (비밀번호 필요) ────────────────────

function UploadRow({
  target, label, password, onDone,
}: {
  target: 'navdata' | 'routes'
  label: string
  password: string
  onDone: (result: AdminUploadResult) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleUpload() {
    if (!file) return
    if (!password) { setError('비밀번호를 입력하세요'); return }
    setLoading(true); setError(null)
    try {
      const result = await api.admin.upload(target, file, password)
      onDone(result)
      setFile(null)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3 space-y-2">
      <div className="text-xs font-bold text-white">{label}</div>
      <div className="flex items-center gap-2">
        <input
          type="file" accept=".csv"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          className="flex-1 text-[11px] text-gray-400 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:bg-gray-800 file:text-gray-300 file:text-[10px]"
        />
        <button
          onClick={handleUpload}
          disabled={!file || loading}
          className="flex items-center gap-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-[11px] font-semibold px-2.5 py-1.5 rounded transition-colors shrink-0"
        >
          {loading ? <RefreshCw size={11} className="animate-spin" /> : <Upload size={11} />}
          업로드
        </button>
      </div>
      {error && <div className="text-[10px] text-red-400">{error}</div>}
    </div>
  )
}

function MinimaUploadRow({
  password, onDone,
}: {
  password: string
  onDone: (result: AdminMinimaUploadResult) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleUpload() {
    if (!file) return
    if (!password) { setError('비밀번호를 입력하세요'); return }
    setLoading(true); setError(null)
    try {
      const result = await api.admin.uploadMinima(file, password)
      onDone(result)
      setFile(null)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3 space-y-2">
      <div className="text-xs font-bold text-white">WX_Minima.csv (공항별 접근방식 RVR/VIS/DH → 기상 최저치)</div>
      <div className="flex items-center gap-2">
        <input
          type="file" accept=".csv"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          className="flex-1 text-[11px] text-gray-400 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:bg-gray-800 file:text-gray-300 file:text-[10px]"
        />
        <button
          onClick={handleUpload}
          disabled={!file || loading}
          className="flex items-center gap-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-[11px] font-semibold px-2.5 py-1.5 rounded transition-colors shrink-0"
        >
          {loading ? <RefreshCw size={11} className="animate-spin" /> : <Upload size={11} />}
          업로드
        </button>
      </div>
      {error && <div className="text-[10px] text-red-400">{error}</div>}
    </div>
  )
}

function CurfewUploadRow({ password }: { password: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ count: number } | null>(null)

  async function handleUpload() {
    if (!file) return
    if (!password) { setError('비밀번호를 입력하세요'); return }
    setLoading(true); setError(null)
    try {
      const res = await api.curfew.upload(file, password)
      setResult({ count: res.count })
      setFile(null)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3 space-y-2">
      <div className="text-xs font-bold text-white">curfew.csv/xlsx (공항별 커퓨 시간)</div>
      <div className="flex items-center gap-2">
        <input
          type="file" accept=".csv,.xlsx,.xls"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          className="flex-1 text-[11px] text-gray-400 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:bg-gray-800 file:text-gray-300 file:text-[10px]"
        />
        <button
          onClick={handleUpload}
          disabled={!file || loading}
          className="flex items-center gap-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-[11px] font-semibold px-2.5 py-1.5 rounded transition-colors shrink-0"
        >
          {loading ? <RefreshCw size={11} className="animate-spin" /> : <Upload size={11} />}
          업로드
        </button>
      </div>
      {error && <div className="text-[10px] text-red-400">{error}</div>}
      {result && <div className="text-[10px] text-green-400">업로드 완료 — {result.count}개 공항 반영됨</div>}
    </div>
  )
}

export default function AdminPage({ onClose }: Props) {
  const [status, setStatus] = useState<AdminDataStatus | null>(null)
  const [password, setPassword] = useState('')
  const [lastResult, setLastResult] = useState<AdminUploadResult | null>(null)
  const [lastMinimaResult, setLastMinimaResult] = useState<AdminMinimaUploadResult | null>(null)

  function loadStatus() {
    api.admin.status().then(setStatus).catch(() => {})
  }

  useEffect(() => { loadStatus() }, [])

  function handleDone(result: AdminUploadResult) {
    setLastResult(result)
    loadStatus()
  }

  function handleMinimaDone(result: AdminMinimaUploadResult) {
    setLastMinimaResult(result)
    loadStatus()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm pt-10 pb-10 overflow-y-auto">
      <div className="w-full max-w-2xl mx-4 bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-start gap-3 px-6 py-4 border-b border-gray-800 shrink-0">
          <div className="flex-1">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <ShieldCheck size={15} className="text-cyan-400" />
              관리자
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              근간 데이터(NAVDATA·항로 DB·공항 최저치·커퓨) 갱신 및 외부 데이터 소스 최신화 상태 확인
            </p>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors mt-0.5">
            <X size={17} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <ExternalSourcesStatus />

          <label className="block text-[11px] text-gray-400">
            관리자 비밀번호
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="아래 업로드에 공통으로 필요"
              className="block mt-1 w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-xs text-white"
            />
          </label>

          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Database size={13} className="text-gray-500" />
              <h3 className="text-xs font-bold text-gray-300">NAVDATA / 항로 DB</h3>
            </div>

            {status && (
              <div className="text-[11px] text-gray-400 mb-2.5 flex flex-wrap gap-x-3 gap-y-1">
                <span>공항 {status.airports.toLocaleString()}</span>
                <span>waypoint {status.waypoints.toLocaleString()}</span>
                <span>항공로 {status.airways.toLocaleString()}</span>
                <span>항로 {status.routes.toLocaleString()}</span>
                {status.suspicious_routes > 0 && (
                  <span className="text-amber-400 flex items-center gap-1">
                    <AlertTriangle size={11} /> 의심 항로 {status.suspicious_routes}건
                  </span>
                )}
              </div>
            )}

            <div className="space-y-2">
              <UploadRow target="navdata" label="NAVDATA.csv (공항·항공로·waypoint·절차)" password={password} onDone={handleDone} />
              <UploadRow target="routes" label="Navblue_Route.csv (항로 DB)" password={password} onDone={handleDone} />
            </div>

            {lastResult && (
              <div className="mt-3 text-[11px] bg-gray-950/60 border border-gray-800 rounded-lg p-2.5 space-y-1">
                <div className="text-green-400 font-semibold">
                  업로드 완료 — {lastResult.backup ? `기존 파일은 backups/${lastResult.backup}로 백업됨` : '기존 파일 없음(신규)'}
                </div>
                <div className="text-gray-400">
                  반영 결과: 공항 {lastResult.airports} · waypoint {lastResult.waypoints} · 항공로 {lastResult.airways} · 항로 {lastResult.routes}
                </div>
                {lastResult.suspicious_routes > 0 && (
                  <div className="text-amber-400">
                    ⚠ 좌표가 유독 적은 항로 {lastResult.suspicious_routes}건 — fix 이름이 airway/절차명과 겹쳤을 가능성
                    {lastResult.suspicious_sample.length > 0 && ` (예: ${lastResult.suspicious_sample.slice(0, 5).join(', ')})`}
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Moon size={13} className="text-gray-500" />
              <h3 className="text-xs font-bold text-gray-300">공항 최저치 / 커퓨</h3>
            </div>

            {status && (
              <div className="text-[11px] text-gray-400 mb-2.5">
                공항 최저치 반영 {status.minima_airports.toLocaleString()}개 공항
              </div>
            )}

            <div className="space-y-2">
              <MinimaUploadRow password={password} onDone={handleMinimaDone} />
              <CurfewUploadRow password={password} />
            </div>

            {lastMinimaResult && (
              <div className="mt-3 text-[11px] bg-gray-950/60 border border-gray-800 rounded-lg p-2.5 space-y-1">
                <div className="text-green-400 font-semibold">
                  업로드 완료 — {lastMinimaResult.backup ? `기존 파일은 backups/${lastMinimaResult.backup}로 백업됨` : '기존 파일 없음(신규)'}
                </div>
                <div className="text-gray-400">반영 결과: {lastMinimaResult.resolved}개 공항</div>
                {lastMinimaResult.unresolved_iata.length > 0 && (
                  <div className="text-amber-400">
                    ⚠ IATA→ICAO 매핑을 몰라서 건너뜀: {lastMinimaResult.unresolved_iata.join(', ')} — 코드에 매핑 추가 필요
                  </div>
                )}
              </div>
            )}
          </div>

          {status && status.backups.length > 0 && (
            <details>
              <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-400">
                이전 백업 {status.backups.length}개
              </summary>
              <div className="mt-1.5 text-[10px] text-gray-500 font-mono space-y-0.5 max-h-32 overflow-y-auto">
                {status.backups.map(b => <div key={b}>{b}</div>)}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
