import { useState } from 'react'
import { Hexagon, CircleDot, Trash2, CheckCheck, PenLine, Keyboard, Play } from 'lucide-react'
import * as turf from '@turf/turf'
import { useApp } from '../AppContext'

type ShapeType = 'polygon' | 'circle' | null
type InputMethod = 'draw' | 'text'

// "192000N" → 19°20'00"N (DDMMSS, 초 생략 가능: DDMM)
function parseDmsLat(token: string): number | null {
  const m = token.match(/^(\d{2})(\d{2})(\d{2})?([NS])$/)
  if (!m) return null
  const [, deg, min, sec, dir] = m
  const val = Number(deg) + Number(min) / 60 + Number(sec ?? 0) / 3600
  return dir === 'S' ? -val : val
}

// "1232600E" → 123°26'00"E (DDDMMSS, 초 생략 가능: DDDMM)
function parseDmsLon(token: string): number | null {
  const m = token.match(/^(\d{3})(\d{2})(\d{2})?([EW])$/)
  if (!m) return null
  const [, deg, min, sec, dir] = m
  const val = Number(deg) + Number(min) / 60 + Number(sec ?? 0) / 3600
  return dir === 'W' ? -val : val
}

function parseLatLon(raw: string): [number, number] | null {
  // 항공용 좌표 목록은 흔히 줄 끝에 "-"로 다음 줄과 이어붙임 — 구분자로만 쓰이니 제거
  const cleaned = raw.trim().replace(/-+$/, '').trim()
  const parts = cleaned.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 2) return null

  // DMS 압축 표기: "192000N 1232600E"
  const dmsLat = parseDmsLat(parts[0].toUpperCase())
  const dmsLon = parseDmsLon(parts[1].toUpperCase())
  if (dmsLat !== null && dmsLon !== null) return [dmsLon, dmsLat]

  // 십진수 좌표: "37.5167, 126.9000"
  const lat = parseFloat(parts[0])
  const lon = parseFloat(parts[1])
  if (isNaN(lat) || isNaN(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return [lon, lat]
}

// ── 자유 형식 DMS 좌표열 추출 ──────────────────────────────────────────────
// 국가/출처마다 위경도 좌표를 표기하는 방식이 다 달라서(예: "213600N 1202500E"처럼
// 숫자+문자 순서인 곳도 있고, "N360100E1211600"처럼 문자+숫자 순서로 공백 하나 없이
// 붙여서 "-"로만 좌표쌍을 이어놓는 곳도 있음) 구분자를 일일이 알아내서 자르기보다,
// "좌표처럼 생긴 조각"만 순서대로 전부 찾아내서 위도·경도가 번갈아 나온다고 보고
// 짝짓는 방식이 훨씬 더 튼튼함 — 사이에 뭐가 껴있든(-, TO, TERRITORY, 줄바꿈, 공백)
// 상관없이 동작함.
// 위도: 2자리(도)+2자리(분)+2자리(초, 생략가능) = 4 또는 6자리 숫자 + N/S
// 경도: 3자리(도)+2자리(분)+2자리(초, 생략가능) = 5 또는 7자리 숫자 + E/W
// 문자가 숫자 앞이든 뒤든 둘 다 인식.
const DMS_TOKEN_RE =
  /(?:[NS](?:\d{6}|\d{4}))|(?:[EW](?:\d{7}|\d{5}))|(?:(?:\d{6}|\d{4})[NS])|(?:(?:\d{7}|\d{5})[EW])/g

function dmsTokenToValue(token: string): { axis: 'lat' | 'lon'; value: number } | null {
  let m = token.match(/^([NS])(\d{2})(\d{2})(\d{2})?$/)
  if (m) {
    const [, dir, deg, min, sec] = m
    const val = Number(deg) + Number(min) / 60 + Number(sec ?? 0) / 3600
    return { axis: 'lat', value: dir === 'S' ? -val : val }
  }
  m = token.match(/^([EW])(\d{3})(\d{2})(\d{2})?$/)
  if (m) {
    const [, dir, deg, min, sec] = m
    const val = Number(deg) + Number(min) / 60 + Number(sec ?? 0) / 3600
    return { axis: 'lon', value: dir === 'W' ? -val : val }
  }
  m = token.match(/^(\d{2})(\d{2})(\d{2})?([NS])$/)
  if (m) {
    const [, deg, min, sec, dir] = m
    const val = Number(deg) + Number(min) / 60 + Number(sec ?? 0) / 3600
    return { axis: 'lat', value: dir === 'S' ? -val : val }
  }
  m = token.match(/^(\d{3})(\d{2})(\d{2})?([EW])$/)
  if (m) {
    const [, deg, min, sec, dir] = m
    const val = Number(deg) + Number(min) / 60 + Number(sec ?? 0) / 3600
    return { axis: 'lon', value: dir === 'W' ? -val : val }
  }
  return null
}

// 전체 텍스트에서 좌표쌍을 몽땅 뽑아냄 — 못 찾으면 빈 배열(이 경우 호출부에서
// 십진수 등 기존 줄 단위 파서로 대체 처리)
function extractDmsPairs(raw: string): [number, number][] {
  // 소수점은 DMS 자리수 계산을 틀어지게 하니 미리 제거(3단계: 소수점 제거)
  const stripped = raw.replace(/\./g, '')
  const tokens = stripped.toUpperCase().match(DMS_TOKEN_RE) ?? []
  const values = tokens.map(dmsTokenToValue).filter((v): v is NonNullable<typeof v> => v !== null)

  const pairs: [number, number][] = []
  for (let i = 0; i + 1 < values.length; i += 2) {
    const a = values[i], b = values[i + 1]
    if (a.axis === 'lat' && b.axis === 'lon') pairs.push([b.value, a.value])
    else if (a.axis === 'lon' && b.axis === 'lat') pairs.push([a.value, b.value])
    else return []  // 위/경도가 번갈아 나오지 않으면 이 방식으로 못 읽는 형식이니 포기
  }
  return pairs
}

export default function SpatialSearchPanel() {
  const { state, dispatch } = useApp()

  // Local UI state — shape type and input method are just UI choices until explicitly activated
  const [shapeType, setShapeType] = useState<ShapeType>(null)
  const [method, setMethod] = useState<InputMethod>('draw')
  const [radiusNm, setRadiusNm] = useState('50')
  const [polyText, setPolyText] = useState('')
  const [polyError, setPolyError] = useState('')
  const [circleLat, setCircleLat] = useState('')
  const [circleLon, setCircleLon] = useState('')
  const [circleError, setCircleError] = useState('')

  const isDrawing = state.spatialMode !== null          // map is in active draw mode
  const hasCenter = state.spatialMode === 'circle' && state.spatialPoints.length > 0
  const hasFilter = state.spatialFilter !== null

  function selectShape(s: ShapeType) {
    // Selecting a shape type does NOT activate map draw mode
    setShapeType(s)
    setPolyError('')
    setCircleError('')
    // Cancel any active drawing
    if (isDrawing) dispatch({ type: 'CLEAR_SPATIAL' })
  }

  function startDrawing() {
    if (!shapeType) return
    dispatch({ type: 'CLEAR_SPATIAL' })
    dispatch({ type: 'SET_SPATIAL_MODE', payload: shapeType })
  }

  // ── Polygon finish (draw mode) ──────────────────────────────────
  function finishPolygon() {
    const pts = state.spatialPoints
    if (pts.length < 3) return
    dispatch({ type: 'SET_SPATIAL_FILTER', payload: { type: 'polygon', ring: [...pts, pts[0]] } })
  }

  // ── Polygon from text ───────────────────────────────────────────
  function applyPolyText() {
    // 국가/출처마다 좌표 표기 방식이 다 달라도(공백 없이 붙여쓰거나, "-"/"TO"/
    // "TERRITORY" 등 뭘로 이어붙였든) 한 번에 인식하는 방식을 먼저 시도 —
    // 안 먹히면(위경도가 안 맞게 나오면 등) 기존 줄 단위 파서로 대체
    let pts = extractDmsPairs(polyText)
    if (pts.length === 0) {
      const lines = polyText.trim().split('\n').filter(l => l.trim())
      const parsed: [number, number][] = []
      for (const line of lines) {
        const pt = parseLatLon(line)
        if (!pt) { setPolyError(`파싱 오류: "${line}"`); return }
        parsed.push(pt)
      }
      pts = parsed
    }
    if (pts.length < 3) { setPolyError('꼭짓점이 3개 이상이어야 합니다.'); return }
    setPolyError('')
    dispatch({ type: 'SET_SPATIAL_FILTER', payload: { type: 'polygon', ring: [...pts, pts[0]] } })
  }

  // ── Circle (draw mode) ──────────────────────────────────────────
  function applyCircleDraw() {
    const center = state.spatialPoints[0]
    if (!center) return
    const nm = parseFloat(radiusNm)
    if (!nm || nm <= 0) return
    const circle = turf.circle(center, nm, { steps: 64, units: 'nauticalmiles' })
    const ring = circle.geometry.coordinates[0] as number[][]
    dispatch({ type: 'SET_SPATIAL_FILTER', payload: { type: 'circle', ring, center, radiusNm: nm } })
  }

  // ── Circle from text ────────────────────────────────────────────
  function applyCircleText() {
    const lat = parseFloat(circleLat)
    const lon = parseFloat(circleLon)
    const nm = parseFloat(radiusNm)
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setCircleError('위도(-90~90), 경도(-180~180)를 확인하세요.'); return
    }
    if (!nm || nm <= 0) { setCircleError('반경(NM)을 입력하세요.'); return }
    setCircleError('')
    const center: [number, number] = [lon, lat]
    const circle = turf.circle(center, nm, { steps: 64, units: 'nauticalmiles' })
    const ring = circle.geometry.coordinates[0] as number[][]
    dispatch({ type: 'SET_SPATIAL_FILTER', payload: { type: 'circle', ring, center, radiusNm: nm } })
  }

  function clear() {
    dispatch({ type: 'CLEAR_SPATIAL' })
    setShapeType(null)
    setPolyError('')
    setCircleError('')
  }

  const centerPt = state.spatialPoints[0]

  // ── Active filter summary ───────────────────────────────────────
  if (hasFilter) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-purple-300 font-semibold">
            {state.spatialFilter!.type === 'circle'
              ? `반경 ${state.spatialFilter!.radiusNm} NM`
              : '폴리곤 영역'} 적용 중
          </span>
          <button onClick={clear} className="text-gray-500 hover:text-red-400 transition-colors">
            <Trash2 size={13} />
          </button>
        </div>
        {state.spatialFilter!.center && (
          <div className="text-[11px] text-gray-500 font-mono">
            중심 {state.spatialFilter!.center[1].toFixed(4)}°N {state.spatialFilter!.center[0].toFixed(4)}°E
          </div>
        )}
        <button onClick={clear} className="text-xs text-gray-500 hover:text-red-400 transition-colors">
          영역 지우기
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Shape type selector */}
      <div className="flex gap-2">
        <button
          onClick={() => selectShape('polygon')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium transition-colors border ${
            shapeType === 'polygon'
              ? 'bg-purple-700 text-white border-purple-500'
              : 'bg-gray-800 text-gray-400 hover:text-white border-gray-600'
          }`}
        >
          <Hexagon size={12} /> 폴리곤
        </button>
        <button
          onClick={() => selectShape('circle')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium transition-colors border ${
            shapeType === 'circle'
              ? 'bg-purple-700 text-white border-purple-500'
              : 'bg-gray-800 text-gray-400 hover:text-white border-gray-600'
          }`}
        >
          <CircleDot size={12} /> 반경
        </button>
      </div>

      {/* Options — shown after shape is selected */}
      {shapeType && (
        <>
          {/* Input method tabs */}
          <div className="flex gap-1 bg-gray-800 rounded p-0.5">
            <button
              onClick={() => { setMethod('draw'); if (isDrawing) dispatch({ type: 'CLEAR_SPATIAL' }) }}
              className={`flex-1 flex items-center justify-center gap-1 py-1 rounded text-xs transition-colors ${
                method === 'draw' ? 'bg-gray-600 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <PenLine size={11} /> 지도 그리기
            </button>
            <button
              onClick={() => { setMethod('text'); if (isDrawing) dispatch({ type: 'CLEAR_SPATIAL' }) }}
              className={`flex-1 flex items-center justify-center gap-1 py-1 rounded text-xs transition-colors ${
                method === 'text' ? 'bg-gray-600 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <Keyboard size={11} /> 좌표 입력
            </button>
          </div>

          {/* ── Polygon / Draw ── */}
          {shapeType === 'polygon' && method === 'draw' && (
            <div className="space-y-2">
              {!isDrawing ? (
                <button
                  onClick={startDrawing}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded text-xs font-semibold transition-colors"
                >
                  <Play size={11} /> 그리기 시작
                </button>
              ) : (
                <>
                  <p className="text-xs text-purple-300">
                    지도 클릭으로 꼭짓점 추가 —{' '}
                    <span className="font-semibold">{state.spatialPoints.length}개</span>
                    <span className="text-gray-500 ml-1">(ESC: 취소)</span>
                  </p>
                  {state.spatialPoints.length >= 3 && (
                    <button
                      onClick={finishPolygon}
                      className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-xs font-medium transition-colors"
                    >
                      <CheckCheck size={12} /> 폴리곤 완료
                    </button>
                  )}
                  <button
                    onClick={() => dispatch({ type: 'CLEAR_SPATIAL' })}
                    className="w-full text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    취소
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── Polygon / Text ── */}
          {shapeType === 'polygon' && method === 'text' && (
            <div className="space-y-2">
              <p className="text-[11px] text-gray-500">
                십진수(위도, 경도) 또는 항공용 DMS 아무 형식이나 붙여넣기 가능 — 공백 없이
                붙어있거나(N360100E1211600) "-"·"TO"로 이어붙인 형식도 자동 인식
              </p>
              <textarea
                rows={5}
                placeholder={"37.5167, 126.9000\n35.1000, 129.0333\n33.5000, 126.4667\n\n또는\n\n192000N 1232600E\n191500N 1242600E"}
                value={polyText}
                onChange={e => { setPolyText(e.target.value); setPolyError('') }}
                className="w-full bg-gray-800 border border-gray-600 text-white text-xs rounded px-2 py-1.5 outline-none font-mono resize-none placeholder-gray-600 focus:border-purple-500"
              />
              {polyError && <p className="text-xs text-red-400">{polyError}</p>}
              <button
                onClick={applyPolyText}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-xs font-medium transition-colors"
              >
                <CheckCheck size={12} /> 폴리곤 적용
              </button>
            </div>
          )}

          {/* ── Circle / Draw ── */}
          {shapeType === 'circle' && method === 'draw' && (
            <div className="space-y-2">
              {!isDrawing ? (
                <button
                  onClick={startDrawing}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded text-xs font-semibold transition-colors"
                >
                  <Play size={11} /> 중심점 선택 시작
                </button>
              ) : !hasCenter ? (
                <p className="text-xs text-purple-300">
                  지도에서 중심점을 클릭하세요
                  <span className="text-gray-500 ml-1">(ESC: 취소)</span>
                </p>
              ) : (
                <>
                  <div className="text-xs text-gray-400 font-mono">
                    {centerPt[1].toFixed(4)}°N, {centerPt[0].toFixed(4)}°E
                  </div>
                  <RadiusInput value={radiusNm} onChange={setRadiusNm} />
                  <button
                    onClick={applyCircleDraw}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-xs font-medium transition-colors"
                  >
                    <CheckCheck size={12} /> 반경 적용
                  </button>
                  <button
                    onClick={() => dispatch({ type: 'CLEAR_SPATIAL' })}
                    className="w-full text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    취소
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── Circle / Text ── */}
          {shapeType === 'circle' && method === 'text' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-gray-500 mb-1 block">위도 (N)</label>
                  <input
                    type="number" placeholder="37.5167" value={circleLat}
                    onChange={e => { setCircleLat(e.target.value); setCircleError('') }}
                    className="w-full bg-gray-800 border border-gray-600 text-white text-xs rounded px-2 py-1.5 outline-none focus:border-purple-500"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-gray-500 mb-1 block">경도 (E)</label>
                  <input
                    type="number" placeholder="126.9000" value={circleLon}
                    onChange={e => { setCircleLon(e.target.value); setCircleError('') }}
                    className="w-full bg-gray-800 border border-gray-600 text-white text-xs rounded px-2 py-1.5 outline-none focus:border-purple-500"
                  />
                </div>
              </div>
              <RadiusInput value={radiusNm} onChange={setRadiusNm} />
              {circleError && <p className="text-xs text-red-400">{circleError}</p>}
              <button
                onClick={applyCircleText}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-xs font-medium transition-colors"
              >
                <CheckCheck size={12} /> 반경 적용
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function RadiusInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-400 shrink-0">반경</span>
      <input
        type="number" min="1" max="9999" value={value}
        onChange={e => onChange(e.target.value)}
        className="flex-1 w-0 bg-gray-800 border border-gray-600 text-white text-xs rounded px-2 py-1 outline-none focus:border-purple-500"
      />
      <span className="text-xs text-gray-400 shrink-0">NM</span>
    </div>
  )
}
