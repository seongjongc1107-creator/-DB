import { useState } from 'react'
import { Hexagon, CircleDot, Trash2, CheckCheck, PenLine, Keyboard, Play } from 'lucide-react'
import * as turf from '@turf/turf'
import { useApp } from '../AppContext'

type ShapeType = 'polygon' | 'circle' | null
type InputMethod = 'draw' | 'text'

function parseLatLon(raw: string): [number, number] | null {
  const parts = raw.trim().split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 2) return null
  const lat = parseFloat(parts[0])
  const lon = parseFloat(parts[1])
  if (isNaN(lat) || isNaN(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return [lon, lat]
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
    const lines = polyText.trim().split('\n').filter(l => l.trim())
    const pts: [number, number][] = []
    for (const line of lines) {
      const pt = parseLatLon(line)
      if (!pt) { setPolyError(`파싱 오류: "${line}"`); return }
      pts.push(pt)
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
              <p className="text-[11px] text-gray-500">한 줄에 하나 (위도, 경도)</p>
              <textarea
                rows={5}
                placeholder={"37.5167, 126.9000\n35.1000, 129.0333\n33.5000, 126.4667"}
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
