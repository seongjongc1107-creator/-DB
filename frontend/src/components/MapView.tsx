import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../api/client'
import Map, { Source, Layer, Marker, type MapRef, type MapLayerMouseEvent } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as turf from '@turf/turf'
import { useApp } from '../AppContext'
import { classifyLevel, getThresholds, highlightSegments } from '../lib/weatherClassify'
import { SELECT_COLORS } from '../lib/selectionColors'

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

function drawPlaneImageData(color: string, outline = 'rgba(0,0,0,0.7)'): ImageData {
  const SZ = 32
  const canvas = document.createElement('canvas')
  canvas.width = SZ
  canvas.height = SZ
  const ctx = canvas.getContext('2d')!
  const cx = SZ / 2  // 16

  function shape() {
    ctx.beginPath()
    // 기수 (top)
    ctx.moveTo(cx, 1)
    // 동체 우측 → 주익 뿌리
    ctx.lineTo(cx + 1.5, 10)
    // 우측 주익 끝
    ctx.lineTo(cx + 14, 17)
    // 우익 trailing edge
    ctx.lineTo(cx + 9,  19)
    // 동체 우측 (주익 후방)
    ctx.lineTo(cx + 1.5, 18)
    // 우측 꼬리익
    ctx.lineTo(cx + 6,  28)
    ctx.lineTo(cx + 3,  29)
    // 동체 후단
    ctx.lineTo(cx,      24)
    ctx.lineTo(cx - 3,  29)
    ctx.lineTo(cx - 6,  28)
    // 좌측 꼬리익
    ctx.lineTo(cx - 1.5, 18)
    ctx.lineTo(cx - 9,  19)
    ctx.lineTo(cx - 14, 17)
    ctx.lineTo(cx - 1.5, 10)
    ctx.closePath()
  }

  // 외곽선
  ctx.lineWidth = 1.5
  ctx.strokeStyle = outline
  shape()
  ctx.stroke()

  // 채우기
  ctx.fillStyle = color
  shape()
  ctx.fill()

  return ctx.getImageData(0, 0, SZ, SZ)
}

function addPlaneIcons(map: import('maplibre-gl').Map) {
  const icons: [string, string, string][] = [
    ['plane-other',  '#93C5FD', 'rgba(0,0,0,0.6)'],  // 타사 — 하늘색
    ['plane-jja',    '#F97316', 'rgba(0,0,0,0.7)'],  // JJA — 오렌지
    ['plane-ground', '#9CA3AF', 'rgba(0,0,0,0.5)'],  // 지상 — 회색
  ]
  for (const [id, color, outline] of icons) {
    if (!map.hasImage(id)) {
      map.addImage(id, drawPlaneImageData(color, outline))
    }
  }
}

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] }

// 화산재 구역 시간대 — 색은 신호등처럼 OBS(빨강, 가장 급함)부터 +18h(옅은 노랑)까지
const ASH_STEP_INDEX: Record<string, number> = { OBS: 0, '+6HR': 1, '+12HR': 2, '+18HR': 3 }
const ASH_STEP_COLOR: any = [
  'match', ['get', 'step_label'],
  'OBS', '#ef4444',
  '+6HR', '#f97316',
  '+12HR', '#eab308',
  '+18HR', '#fde047',
  '#a8a29e',
]

export default function MapView() {
  const { state, dispatch } = useApp()
  const mapRef = useRef<MapRef>(null)
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; props: Record<string, unknown> } | null>(null)
  const [mousePos, setMousePos] = useState<[number, number] | null>(null)
  // 화산재 상세 팝업 — 호버 툴팁과 달리 클릭으로 열고 닫으며, 마우스가 빠져나가도
  // 안 사라져서 전문을 스크롤해서 끝까지 읽을 수 있음
  const [ashPopup, setAshPopup] = useState<{ x: number; y: number; props: Record<string, unknown> } | null>(null)
  // 드래그로 옮긴 화산재 팝업 위치 — null이면 클릭 지점 기준 기본 위치 사용
  const [ashPopupPos, setAshPopupPos] = useState<{ x: number; y: number } | null>(null)
  const ashDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [planeIconsReady, setPlaneIconsReady] = useState(false)

  // Plane icon 로딩 — traffic 레이어 켤 때 + 맵 로드 후 실행 (동기 ImageData 방식)
  useEffect(() => {
    if (!state.layers.traffic || !mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) { console.warn('[traffic] map not ready'); return }
    try {
      addPlaneIcons(map)
      console.log('[traffic] plane icons ready, gray:', map.hasImage('plane-gray'))
      setPlaneIconsReady(true)
    } catch (e) {
      console.error('[traffic] addPlaneIcons failed:', e)
    }
  }, [state.layers.traffic, mapLoaded])

  // Traffic auto-refresh (30s, only when layer is on)
  useEffect(() => {
    if (!state.layers.traffic) return
    async function fetchTraffic() {
      dispatch({ type: 'SET_TRAFFIC_LOADING', payload: true })
      try {
        const res = await api.traffic.fetch()
        console.log('[traffic] fetched:', res.count, 'jja:', res.jja_count, 'error:', res.error)
        dispatch({ type: 'SET_TRAFFIC_DATA', payload: { aircraft: res.aircraft, updated: res.updated } })
      } catch {
        // keep stale data
      } finally {
        dispatch({ type: 'SET_TRAFFIC_LOADING', payload: false })
      }
    }
    fetchTraffic()
    const id = setInterval(fetchTraffic, 30_000)
    return () => clearInterval(id)
  }, [state.layers.traffic, dispatch])

  // Waypoints 레이어를 처음 켤 때 전 세계 waypoint를 한 번만 불러옴
  useEffect(() => {
    if (!state.layers.waypoints || state.waypointsGeoJSON) return
    api.navdata.waypoints().then(data => {
      dispatch({ type: 'SET_WAYPOINTS_GEOJSON', payload: data })
    })
  }, [state.layers.waypoints, state.waypointsGeoJSON, dispatch])

  // 전체 Airway 레이어를 처음 켤 때 전 세계 airway를 한 번만 불러옴
  useEffect(() => {
    if (!state.layers.allAirways || state.allAirwaysGeoJSON) return
    api.navdata.allAirways().then(data => {
      dispatch({ type: 'SET_ALL_AIRWAYS_GEOJSON', payload: data })
    })
  }, [state.layers.allAirways, state.allAirwaysGeoJSON, dispatch])

  // 태풍 레이어를 처음 켤 때 현재 활성 태풍 + 예보 트랙을 자동으로 불러옴
  useEffect(() => {
    if (!state.layers.typhoon || state.typhoons.length > 0 || state.typhoonTrack) return
    api.typhoon.active().then(data => {
      if (!data.typhoons || data.typhoons.length === 0) return
      dispatch({ type: 'SET_TYPHOONS', payload: data.typhoons })
      // 한국(인천 부근)에서 가장 가까운 태풍을 기본으로 골라 트랙을 보여줌
      const KOREA_REF: [number, number] = [126.45, 37.47]
      const primary = [...data.typhoons].sort((a, b) =>
        turf.distance(KOREA_REF, [a.lon, a.lat]) - turf.distance(KOREA_REF, [b.lon, b.lat])
      )[0]
      return api.typhoon.track(primary.id).then(trackData => {
        if (!trackData.track || trackData.track.length === 0) return
        dispatch({ type: 'SET_TYPHOON_TRACK', payload: trackData.track })
        const lons = trackData.track.map(p => p.lon)
        const lats = trackData.track.map(p => p.lat)
        dispatch({ type: 'SET_FIT_BOUNDS', payload: [
          [Math.min(...lons) - 2, Math.min(...lats) - 2],
          [Math.max(...lons) + 2, Math.max(...lats) + 2],
        ] })
      })
    }).catch(() => {})
  }, [state.layers.typhoon, state.typhoons.length, state.typhoonTrack, dispatch])

  // 화산재 구역 레이어를 처음 켤 때 도쿄 VAAC 활성 권고를 불러옴
  useEffect(() => {
    if (!state.layers.volcanicAsh || state.volcanicAsh.length > 0) return
    dispatch({ type: 'SET_VOLCANIC_ASH_LOADING', payload: true })
    api.volcanicAsh.active()
      .then(data => { if (data.advisories) dispatch({ type: 'SET_VOLCANIC_ASH', payload: data.advisories }) })
      .catch(() => {})
      .finally(() => dispatch({ type: 'SET_VOLCANIC_ASH_LOADING', payload: false }))
  }, [state.layers.volcanicAsh, state.volcanicAsh.length, dispatch])

  // Convert traffic to GeoJSON
  const trafficGeoJSON = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: state.trafficData.map(a => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [a.lon, a.lat] },
      properties: {
        icao24:    a.icao24,
        callsign:  a.callsign || '???',
        alt_ft:    a.altitude_m !== null ? Math.round(a.altitude_m * 3.281) : null,
        speed_kt:  a.velocity_ms !== null ? Math.round(a.velocity_ms * 1.944) : null,
        heading:   a.heading ?? 0,
        on_ground: a.on_ground,
        is_jja:    a.is_jja,
      },
    })),
  }), [state.trafficData])

  // ESC → 그리기 모드 취소
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && state.spatialMode !== null) {
        dispatch({ type: 'CLEAR_SPATIAL' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.spatialMode, dispatch])

  // ── Click handler ────────────────────────────────────────────────
  const onClick = useCallback((e: MapLayerMouseEvent) => {
    setContextMenu(null)
    setAshPopup(null)
    setAshPopupPos(null)
    // Polygon drawing mode
    if (state.spatialMode === 'polygon') {
      dispatch({ type: 'ADD_SPATIAL_POINT', payload: [e.lngLat.lng, e.lngLat.lat] })
      return
    }
    // Circle center pick (only first click)
    if (state.spatialMode === 'circle' && state.spatialPoints.length === 0) {
      dispatch({ type: 'ADD_SPATIAL_POINT', payload: [e.lngLat.lng, e.lngLat.lat] })
      return
    }
    // Normal route/airway selection
    const features = e.features ?? []
    if (features.length === 0) {
      dispatch({ type: 'SET_SELECTED_ROUTES', payload: [] })
      dispatch({ type: 'SET_SELECTED_AIRPORT', payload: null })
      return
    }
    const f = features[0]
    // 화산재 구역/화산 위치 클릭 → 고정 팝업(전문 스크롤 가능)
    if (f.layer?.id === 'volcanic-ash-fill' || f.layer?.id === 'volcanic-ash-volcano-point') {
      setAshPopup({ x: e.point.x, y: e.point.y, props: f.properties ?? {} })
      setAshPopupPos(null)
      return
    }
    // Airport click → open METAR panel
    if (f.layer?.id === 'airports-circle-hit') {
      const icao = f.properties?.id as string | undefined
      if (icao) {
        dispatch({ type: 'SET_SELECTED_AIRPORT', payload: icao })
        import('../api/client').then(({ api }) => {
          // Fetch METAR if not yet loaded
          if (!state.weatherData[icao]) {
            api.weather.bulk([icao]).then(res => {
              if (res.data) dispatch({ type: 'SET_WEATHER_DATA', payload: res.data })
            })
          }
          // Fetch airport detail if not yet loaded
          if (!state.airportDetail[icao]) {
            dispatch({ type: 'SET_AIRPORT_DETAIL_LOADING', payload: true })
            api.navdata.airportDetail(icao)
              .then(detail => dispatch({ type: 'SET_AIRPORT_DETAIL', payload: detail }))
              .catch(() => {})
              .finally(() => dispatch({ type: 'SET_AIRPORT_DETAIL_LOADING', payload: false }))
          }
        })
      }
      return
    }
    const id = f.properties?.id as number | undefined
    if (id !== undefined) {
      const multi = e.originalEvent?.ctrlKey || e.originalEvent?.metaKey
      if (multi) dispatch({ type: 'TOGGLE_SELECTED_ROUTE', payload: id })
      else dispatch({ type: 'SET_SELECTED_ROUTES', payload: [id] })
      dispatch({ type: 'SET_SELECTED_AIRPORT', payload: null })
    }
  }, [state.spatialMode, state.spatialPoints.length, state.weatherData, dispatch])

  const onMouseMove = useCallback((e: MapLayerMouseEvent) => {
    if (state.spatialMode === 'polygon') {
      setMousePos([e.lngLat.lng, e.lngLat.lat])
      return
    }
    const features = e.features ?? []
    if (features.length === 0) {
      setHoveredId(null)
      setTooltip(null)
      return
    }
    // 겹친 항로가 여러 개여도 호버는 맨 위 하나만 바로 보여줌(전체 항로 포함) —
    // 겹친 목록은 우클릭으로 확인
    const f = features[0]
    const id = f.properties?.id as number | undefined
    setHoveredId(id ?? null)
    setTooltip({ x: e.point.x, y: e.point.y, props: f.properties ?? {} })
  }, [state.spatialMode])

  // ── 우클릭: 겹친 항로 목록 → 클릭해서 한 단계 더 들어가 상세 보기 ──
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number
    list: Record<string, unknown>[]
    expanded: Record<string, unknown> | null
  } | null>(null)

  const onContextMenu = useCallback((e: MapLayerMouseEvent) => {
    if (state.spatialMode !== null) return
    const features = e.features ?? []
    const routeHits = features.filter(f => f.layer?.id === 'routes-line-hit')
    if (routeHits.length === 0) {
      setContextMenu(null)
      return
    }
    e.preventDefault()
    const seenIds = new Set<number>()
    const list: Record<string, unknown>[] = []
    for (const f of routeHits) {
      const id = f.properties?.id as number | undefined
      if (id !== undefined && !seenIds.has(id)) {
        seenIds.add(id)
        list.push(f.properties ?? {})
      }
    }
    setContextMenu({ x: e.point.x, y: e.point.y, list, expanded: null })
  }, [state.spatialMode])

  // ESC로 우클릭 메뉴 닫기
  useEffect(() => {
    if (!contextMenu) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setContextMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [contextMenu])

  // ESC로 화산재 팝업 닫기
  useEffect(() => {
    if (!ashPopup) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setAshPopup(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ashPopup])

  // 화산재 팝업 드래그 — 헤더를 잡고 끌면 어디로든 옮길 수 있어서, 화면 아래쪽에
  // 열려 스크롤해도 끝까지 안 보일 때 위쪽으로 옮겨서 전문을 다 읽을 수 있음
  const onAshPopupDragStart = useCallback((e: React.MouseEvent) => {
    if (!ashPopup) return
    const base = ashPopupPos ?? {
      x: Math.min(ashPopup.x + 14, window.innerWidth - 340),
      y: Math.min(ashPopup.y - 8, window.innerHeight - 200),
    }
    ashDragRef.current = { startX: e.clientX, startY: e.clientY, origX: base.x, origY: base.y }
    e.preventDefault()
  }, [ashPopup, ashPopupPos])

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const drag = ashDragRef.current
      if (!drag) return
      const x = drag.origX + (e.clientX - drag.startX)
      const y = drag.origY + (e.clientY - drag.startY)
      setAshPopupPos({
        x: Math.min(Math.max(x, -260), window.innerWidth - 40),
        y: Math.min(Math.max(y, 0), window.innerHeight - 40),
      })
    }
    function onUp() { ashDragRef.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 우클릭 메뉴가 닫히면 목록 호버 강조도 같이 해제
  useEffect(() => {
    if (!contextMenu) dispatch({ type: 'SET_HOVERED_ROUTE', payload: null })
  }, [contextMenu, dispatch])

  const onMouseLeave = useCallback(() => {
    setHoveredId(null)
    setTooltip(null)
    setMousePos(null)
  }, [])

  const airwayData = state.airwayGeoJSON ?? EMPTY_FC

  // ── 검색한 항공로 자체가 지나는 waypoint (좌표·이름이 같은 순서로 옴) ──
  const airwayWaypointsData = useMemo(() => {
    const seen = new Set<string>()
    const features = airwayData.features.flatMap(f => {
      const fixes = (f.properties?.fixes as string[] | undefined) ?? []
      const coords = f.geometry.coordinates as number[][]
      return fixes.flatMap((id, i) => {
        const c = coords[i]
        if (!c || seen.has(id)) return []
        seen.add(id)
        return [{
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: c },
          properties: { id },
        }]
      })
    })
    return { type: 'FeatureCollection' as const, features }
  }, [airwayData])


  // ── FlyTo effect ─────────────────────────────────────────────────
  useEffect(() => {
    if (!state.pendingFlyTo || !mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    map.flyTo({
      center: [state.pendingFlyTo.lon, state.pendingFlyTo.lat],
      zoom: state.pendingFlyTo.zoom ?? 8,
      duration: 1200,
    })
    dispatch({ type: 'SET_FLY_TO', payload: null })
  }, [state.pendingFlyTo, dispatch, mapLoaded])

  // ── FitBounds effect (airway 전체 범위 표시) ──────────────────────
  useEffect(() => {
    if (!state.pendingFitBounds || !mapLoaded || !mapRef.current) return
    const bounds = state.pendingFitBounds
    mapRef.current.fitBounds(
      [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]],
      { padding: 100, duration: 1200 },
    )
    dispatch({ type: 'SET_FIT_BOUNDS', payload: null })
  }, [state.pendingFitBounds, dispatch, mapLoaded])

  // ── Highlight markers (DOM, pulsing) ─────────────────────────────
  const HIGHLIGHT_COLORS = {
    airport:  { ping: 'bg-orange-400',  dot: 'bg-orange-500',  text: 'text-orange-300' },
    // waypoint/airway 검색 = "검색한 대상 자체" 강조, airway-line과 같은 무채색 핑크로 통일
    waypoint: { ping: 'bg-[#C08497]',   dot: 'bg-[#C08497]',   text: 'text-[#D8A8B5]' },
    airway:   { ping: 'bg-[#C08497]',   dot: 'bg-[#C08497]',   text: 'text-[#D8A8B5]' },
    route:    { ping: 'bg-blue-400',    dot: 'bg-blue-500',    text: 'text-blue-300'  },
  }

  // ── Base data ────────────────────────────────────────────────────
  const routeData = state.routeGeoJSON ?? EMPTY_FC

  // Inject weatherLevel + configured flag into each airport feature
  const airportsDataWithWeather = useMemo(() => {
    const src = state.airportsGeoJSON ?? EMPTY_FC
    return {
      ...src,
      features: src.features.map(f => {
        const icao = f.properties?.id as string | undefined
        const metar = icao ? state.weatherData[icao] : undefined
        const thresholds = icao ? getThresholds(state.weatherConfig, icao) : undefined
        const levelFromData = metar && thresholds ? classifyLevel(metar, thresholds) : 0
        const maxTokenLevel = metar && thresholds
          ? highlightSegments(metar.raw || '', thresholds).reduce((m, s) => Math.max(m, s.level), 0)
          : 0
        const level = Math.max(levelFromData, maxTokenLevel)
        const configured = icao ? Boolean(state.weatherConfig.airports[icao]) : false
        const hasCurfew = icao ? Boolean(state.curfews[icao]) : false
        return { ...f, properties: { ...f.properties, weatherLevel: level, configured, hasCurfew } }
      }),
    }
  }, [state.airportsGeoJSON, state.weatherData, state.weatherConfig, state.curfews])

  const waypointsData = state.waypointsGeoJSON ?? EMPTY_FC
  const allAirwaysData = state.allAirwaysGeoJSON ?? EMPTY_FC
  const adhocRouteData = state.adhocRouteGeoJSON ?? EMPTY_FC
  const selectedIds = state.selectedRouteIds

  // ── Typhoon circles ──────────────────────────────────────────────
  const typhoonData = useMemo(() => {
    if (state.typhoons.length === 0) return EMPTY_FC
    const features = state.typhoons.flatMap(t => {
      const center: [number, number] = [t.lon, t.lat]
      const circle = turf.circle(center, t.radius_nm, { steps: 64, units: 'nauticalmiles' })
      return [
        { ...circle, properties: { id: t.id, name: t.name, color: t.color, radius_nm: t.radius_nm } },
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: center },
          properties: { id: t.id, name: t.name, color: t.color, wind_kt: t.wind_kt },
        },
      ]
    })
    return { type: 'FeatureCollection' as const, features: features as any[] }
  }, [state.typhoons])

  // ── 화산재 구역 — OBS(현재 관측) + 6/12/18시간 예보 구간 폴리곤 + 화산 위치 점 ──
  const volcanicAshData = useMemo(() => {
    if (state.volcanicAsh.length === 0) return EMPTY_FC
    const polyFeatures = state.volcanicAsh.flatMap(a =>
      a.steps
        .filter(s => s.polygon)
        .map(s => ({
          type: 'Feature' as const,
          geometry: { type: 'Polygon' as const, coordinates: [s.polygon!] },
          properties: {
            volcano: a.volcano, area: a.area, advisory_nr: a.advisory_nr,
            vaac: a.vaac, dtg: a.dtg, raw_text: a.raw_text,
            fl_min: s.fl_min, fl_max: s.fl_max,
            step_label: s.label, step_time: s.time,
            step_index: ASH_STEP_INDEX[s.label] ?? 0,
          },
        }))
    )
    // 화산 자체의 위치(정상 좌표, PSN) — 예상 확산 구역과는 별개로 항상 표시
    const volcanoPoints = state.volcanicAsh
      .filter(a => a.lat !== null && a.lon !== null)
      .map(a => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [a.lon!, a.lat!] },
        properties: { volcano: a.volcano, area: a.area, vaac: a.vaac, dtg: a.dtg, raw_text: a.raw_text, isVolcanoPoint: true },
      }))
    return { type: 'FeatureCollection' as const, features: [...polyFeatures, ...volcanoPoints] as any[] }
  }, [state.volcanicAsh])

  // turf.polygon()에 넘길 항로 교차 판정용 — 확산 구역 Polygon만 추려서 준비(화산 위치
  // 점은 교차 판정 대상이 아니므로 제외)
  const volcanicAshPolys = useMemo(() => {
    return volcanicAshData.features
      .filter(f => (f.geometry as any).type === 'Polygon')
      .map(f => { try { return turf.polygon((f.geometry as any).coordinates) } catch { return null } })
      .filter((p): p is NonNullable<typeof p> => p !== null)
  }, [volcanicAshData])

  // ── Typhoon track path ───────────────────────────────────────────
  const typhoonTrackData = useMemo(() => {
    const track = state.typhoonTrack
    if (!track || track.length < 2) return EMPTY_FC
    const step = state.typhoonTrackStep

    const histPts = track.filter(p => !p.is_forecast)
    const fcstPts = track.filter(p => p.is_forecast)
    // 예보선은 마지막 실측 포인트에서 시작해 연결
    const lastHist = histPts[histPts.length - 1]
    const fcstCoords = lastHist && fcstPts.length > 0
      ? [[lastHist.lon, lastHist.lat], ...fcstPts.map(p => [p.lon, p.lat])]
      : fcstPts.map(p => [p.lon, p.lat])

    const features: object[] = [
      // 실측 항적 (solid gray)
      ...(histPts.length >= 2 ? [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: histPts.map(p => [p.lon, p.lat]) },
        properties: { kind: 'hist' },
      }] : []),
      // 예보 항적 (dashed orange)
      ...(fcstCoords.length >= 2 ? [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: fcstCoords },
        properties: { kind: 'fcst' },
      }] : []),
      // 슬라이더 현재 위치까지 흰 선 강조
      ...(step > 0 ? [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: track.slice(0, step + 1).map(p => [p.lon, p.lat]) },
        properties: { kind: 'past' },
      }] : []),
      // 모든 위치 점
      ...track.map((p, i) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { kind: 'dot', past: i <= step, current: i === step, color: p.color, forecast: p.is_forecast ?? false },
      })),
    ]
    return { type: 'FeatureCollection' as const, features: features as any[] }
  }, [state.typhoonTrack, state.typhoonTrackStep])

  // ── In-progress drawing layer ────────────────────────────────────
  const drawingData = useMemo(() => {
    const pts = state.spatialPoints
    if (pts.length === 0) return EMPTY_FC

    const features: object[] = []

    if (state.spatialMode === 'polygon') {
      // Line through drawn points + live mouse preview
      const linePts = mousePos ? [...pts, mousePos] : pts
      if (linePts.length >= 2) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: linePts },
          properties: {},
        })
      }
      // Vertex dots
      pts.forEach((p, i) => {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: p },
          properties: { idx: i },
        })
      })
    } else if (state.spatialMode === 'circle' && pts.length === 1) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pts[0] },
        properties: {},
      })
    }

    return { type: 'FeatureCollection' as const, features: features as any[] }
  }, [state.spatialPoints, state.spatialMode, mousePos])

  // ── Active spatial filter layer (polygon/circle outline) ─────────
  const spatialFilterData = useMemo(() => {
    if (!state.spatialFilter) return EMPTY_FC
    return {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: [state.spatialFilter.ring] },
        properties: {},
      }],
    }
  }, [state.spatialFilter])

  // ── Spatial route filtering with turf ────────────────────────────
  // 항로명/공항으로 브라우징 중이면 routeData(OD 전체 geometry)를, waypoint·airway
  // 검색 결과를 보는 중이면 matchedRoutesGeoJSON을 기준으로 교차 판정해야
  // "지금 화면에 보이는 항로"와 "영향 항로" 판정이 어긋나지 않음.
  const spatialRoutesData = useMemo(() => {
    if (!state.spatialFilter) return null
    const filterPoly = turf.polygon([state.spatialFilter.ring])
    const source = state.matchedRoutesGeoJSON ?? routeData
    const features = source.features.filter(f => {
      try { return turf.booleanIntersects(f as any, filterPoly) }
      catch { return false }
    })
    return { type: 'FeatureCollection' as const, features }
  }, [state.spatialFilter, state.matchedRoutesGeoJSON, routeData])

  // 화산재 구역과 교차하는 항로 id — spatialFilter(단일 슬롯)와 별개로 항상 계산해서
  // 태풍 등 다른 공간 필터가 이미 켜져 있어도 같이 "영향 항로"에 잡히게 함
  const volcanicAshRouteIds = useMemo(() => {
    if (!state.layers.volcanicAsh || volcanicAshPolys.length === 0) return []
    const source = state.matchedRoutesGeoJSON ?? routeData
    const ids: number[] = []
    for (const f of source.features) {
      const hit = volcanicAshPolys.some(poly => {
        try { return turf.booleanIntersects(f as any, poly) } catch { return false }
      })
      if (hit) ids.push(f.properties?.id as number)
    }
    return ids
  }, [state.layers.volcanicAsh, volcanicAshPolys, state.matchedRoutesGeoJSON, routeData])

  // 공간 필터(태풍 등)와 교차하는 항로 id만 표시용으로 표시 — 목록 자체는 건드리지 않음
  // (예전엔 여기서 allRoutes를 교차하는 항로로 통째로 갈아치워서, 영향 없는 항로를
  // 고르면 지도에 아무것도 안 뜨는 버그가 있었음)
  useEffect(() => {
    const spatialIds = spatialRoutesData ? spatialRoutesData.features.map(f => f.properties?.id as number) : []
    const merged = Array.from(new Set([...spatialIds, ...volcanicAshRouteIds]))
    dispatch({ type: 'SET_AFFECTED_ROUTES', payload: merged })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spatialRoutesData, volcanicAshRouteIds])

  // Clear route list when spatial filter is removed
  useEffect(() => {
    if (state.spatialFilter === null && !state.spatialMode) {
      // Restore full list only if nothing else is filtering
      if (!state.origin && !state.destination && !state.activeAirway) {
        import('../api/client').then(({ api }) => {
          api.routes.list().then(d => dispatch({ type: 'SET_ALL_ROUTES', payload: d.routes }))
        })
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.spatialFilter])

  // ── Matched/searched routes data ────────────────────────────────
  const searchedRoutesData = useMemo(() => {
    // 대체 항로 모드: 클릭한 대체 항로를 우선 표시
    if (state.altRouteMode && state.matchedRoutesGeoJSON) return state.matchedRoutesGeoJSON
    if (spatialRoutesData) return spatialRoutesData
    if (state.matchedRoutesGeoJSON) return state.matchedRoutesGeoJSON
    if (selectedIds.length === 0) return EMPTY_FC
    const idSet = new Set(selectedIds)
    const features = routeData.features.filter(
      f => idSet.has(f.properties?.id as number)
    )
    return { type: 'FeatureCollection' as const, features }
  }, [state.altRouteMode, spatialRoutesData, state.matchedRoutesGeoJSON, selectedIds, routeData])

  // ── Selected route highlight (클릭한 항로만 색으로 강조) ──
  // spatialRoutesData(공간 필터 교차 항로만 남긴 집합)를 pool에 넣으면 필터에
  // 안 걸리는 항로를 선택했을 때 지도에 아무것도 안 그려지는 문제가 있어서 제외.
  // routeData는 현재 로드된 OD의 전체 항로 geometry를 항상 갖고 있음.
  const selectedRouteHighlightData = useMemo(() => {
    if (selectedIds.length === 0) return EMPTY_FC
    const idSet = new Set(selectedIds)
    const pool = state.matchedRoutesGeoJSON ?? routeData
    return {
      type: 'FeatureCollection' as const,
      features: pool.features.filter(f => idSet.has(f.properties?.id as number)),
    }
  }, [selectedIds, state.matchedRoutesGeoJSON, routeData])

  // ── 선택된 항로가 지나는 waypoint (줌 레벨/Waypoints 레이어 토글과 무관하게 항상 표시) ──
  const selectedRouteWaypointsData = useMemo(() => {
    const features = selectedRouteHighlightData.features.flatMap(f => {
      const wps = (f.properties?.waypoints as { id: string; lat: number; lon: number }[] | undefined) ?? []
      return wps.map(w => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [w.lon, w.lat] },
        properties: { id: w.id },
      }))
    })
    return { type: 'FeatureCollection' as const, features }
  }, [selectedRouteHighlightData])

  // ── 직접 입력한 항로가 지나는 waypoint ──
  const adhocRouteWaypointsData = useMemo(() => {
    const features = adhocRouteData.features.flatMap(f => {
      const wps = (f.properties?.waypoints as { id: string; lat: number; lon: number }[] | undefined) ?? []
      return wps.map(w => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [w.lon, w.lat] },
        properties: { id: w.id },
      }))
    })
    return { type: 'FeatureCollection' as const, features }
  }, [adhocRouteData])

  // ── 항로 목록(우클릭 메뉴/사이드바) 호버 강조 ──
  const hoveredRouteData = useMemo(() => {
    if (state.hoveredRouteId === null) return EMPTY_FC
    const pool = state.matchedRoutesGeoJSON ?? routeData
    return {
      type: 'FeatureCollection' as const,
      features: pool.features.filter(f => f.properties?.id === state.hoveredRouteId),
    }
  }, [state.hoveredRouteId, state.matchedRoutesGeoJSON, routeData])

  const inDrawMode = state.spatialMode !== null

  return (
    <div className="relative w-full h-full">
      <Map
        ref={mapRef}
        mapStyle={MAP_STYLE}
        initialViewState={{ longitude: 127, latitude: 35, zoom: 4 }}
        style={{ width: '100%', height: '100%' }}
        interactiveLayerIds={
          inDrawMode ? [] : [
            'routes-line-hit', 'airports-circle-hit', 'airway-line',
            'searched-routes-line', 'selected-route-line',
            'waypoints-circle-hit', 'all-airways-line-hit',
            ...(state.layers.traffic ? ['traffic-icon'] : []),
            ...(state.layers.volcanicAsh ? ['volcanic-ash-fill', 'volcanic-ash-volcano-point'] : []),
          ]
        }
        onLoad={() => setMapLoaded(true)}
        onClick={onClick}
        onMouseMove={onMouseMove}
        onMouseOut={onMouseLeave}
        onContextMenu={onContextMenu}
        cursor={inDrawMode ? 'crosshair' : hoveredId !== null ? 'pointer' : 'grab'}
      >
        {/* ── FIR Boundaries ──────────────────────────────────────── */}
        {state.firGeoJSON && (
          <Source id="fir" type="geojson" data={state.firGeoJSON}>
            <Layer
              id="fir-fill"
              type="fill"
              layout={{ visibility: state.layers.fir ? 'visible' : 'none' }}
              paint={{ 'fill-color': '#94A3B8', 'fill-opacity': 0.03 }}
            />
            <Layer
              id="fir-line"
              type="line"
              layout={{ visibility: state.layers.fir ? 'visible' : 'none' }}
              paint={{ 'line-color': '#94A3B8', 'line-width': 1.2, 'line-opacity': 0.55 }}
            />
            <Layer
              id="fir-label"
              type="symbol"
              layout={{
                visibility: state.layers.fir ? 'visible' : 'none',
                'text-field': ['get', 'icao'],
                'text-font': ['Noto Sans Regular'],
                'text-size': 12,
                'text-anchor': 'center',
              }}
              paint={{ 'text-color': '#94A3B8', 'text-opacity': 0.75, 'text-halo-color': '#0F172A', 'text-halo-width': 1.2 }}
            />
          </Source>
        )}

        {/* ── 전체 Airway (배경, waypoints처럼 줌인하면 표시) ──────── */}
        <Source id="all-airways" type="geojson" data={allAirwaysData}>
          {/* 보이지 않는 넓은 히트 영역 — 얇은 실선을 정확히 겨냥하지 않아도 호버되게 */}
          <Layer
            id="all-airways-line-hit"
            type="line"
            minzoom={5}
            layout={{ visibility: state.layers.allAirways ? 'visible' : 'none' }}
            paint={{ 'line-color': '#000000', 'line-width': 10, 'line-opacity': 0 }}
          />
          <Layer
            id="all-airways-line"
            type="line"
            minzoom={5}
            layout={{ visibility: state.layers.allAirways ? 'visible' : 'none' }}
            paint={{ 'line-color': '#A78BFA', 'line-width': 1, 'line-opacity': 0.35 }}
          />
          <Layer
            id="all-airways-label"
            type="symbol"
            minzoom={7}
            layout={{
              visibility: state.layers.allAirways ? 'visible' : 'none',
              'symbol-placement': 'line-center',
              'text-field': ['get', 'airway'],
              'text-font': ['Noto Sans Regular'],
              'text-size': 10,
            }}
            paint={{ 'text-color': '#A78BFA', 'text-opacity': 0.6, 'text-halo-color': '#0F172A', 'text-halo-width': 0.6 }}
          />
        </Source>

        {/* ── Navblue Routes ──────────────────────────────────────── */}
        <Source id="routes" type="geojson" data={routeData}>
          <Layer
            id="routes-line"
            type="line"
            layout={{ visibility: state.layers.routes ? 'visible' : 'none' }}
            paint={{
              'line-color': '#3B82F6',
              'line-width': 1.2,
              'line-opacity': 0.45,
            }}
          />
          {/* 보이지 않는 넓은 히트 영역 — 얇은 실선을 정확히 겨냥하지 않아도 호버되게 */}
          <Layer
            id="routes-line-hit"
            type="line"
            layout={{ visibility: state.layers.routes ? 'visible' : 'none' }}
            paint={{ 'line-color': '#000000', 'line-width': 14, 'line-opacity': 0 }}
          />
        </Source>

        {/* ── Airports ─────────────────────────────────────────────── */}
        <Source id="airports" type="geojson" data={airportsDataWithWeather}>
          {/* 보이지 않는 넓은 히트 영역 — 작은 점을 정확히 겨냥하지 않아도 호버되게 */}
          <Layer
            id="airports-circle-hit"
            type="circle"
            layout={{ visibility: state.layers.airports ? 'visible' : 'none' }}
            paint={{ 'circle-radius': 12, 'circle-color': '#000000', 'circle-opacity': 0 }}
          />
          <Layer
            id="airports-circle"
            type="circle"
            layout={{ visibility: state.layers.airports ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 5,
              'circle-color': [
                'match', ['get', 'weatherLevel'],
                1, '#22C55E',
                2, '#F59E0B',
                3, '#EF4444',
                '#6B7280',
              ],
              // 개별 최저치 미설정 공항: stroke를 점선 느낌으로 표현 (opacity 차이)
              'circle-stroke-color': [
                'case', ['get', 'configured'], '#ffffff', '#9CA3AF',
              ],
              'circle-stroke-width': 1.5,
              'circle-opacity': [
                'case', ['get', 'configured'], 1, 0.65,
              ],
            }}
          />
          <Layer
            id="airports-curfew-ring"
            type="circle"
            filter={['==', ['get', 'hasCurfew'], true]}
            layout={{ visibility: state.layers.curfew && state.layers.airports ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 9,
              'circle-color': 'transparent',
              'circle-stroke-color': '#EF4444',
              'circle-stroke-width': 2,
              'circle-opacity': 0,
              'circle-stroke-opacity': 0.85,
            }}
          />
          <Layer
            id="airports-label"
            type="symbol"
            minzoom={5}
            layout={{
              visibility: state.layers.airports ? 'visible' : 'none',
              'text-field': ['get', 'id'],
              'text-font': ['Noto Sans Regular'],
              'text-size': 11,
              'text-offset': [0, 1.2],
              'text-anchor': 'top',
            }}
            paint={{
              'text-color': [
                'match', ['get', 'weatherLevel'],
                1, '#22C55E',
                2, '#F59E0B',
                3, '#EF4444',
                '#6B7280',
              ],
              'text-halo-color': '#fff',
              'text-halo-width': 0.8,
            }}
          />
        </Source>

        {/* ── Waypoints ─────────────────────────────────────────────── */}
        <Source id="waypoints" type="geojson" data={waypointsData}>
          {/* 보이지 않는 넓은 히트 영역 — 작은 점을 정확히 겨냥하지 않아도 호버되게 */}
          <Layer
            id="waypoints-circle-hit"
            type="circle"
            minzoom={6}
            layout={{ visibility: state.layers.waypoints ? 'visible' : 'none' }}
            paint={{ 'circle-radius': 10, 'circle-color': '#000000', 'circle-opacity': 0 }}
          />
          <Layer
            id="waypoints-circle"
            type="circle"
            minzoom={6}
            layout={{ visibility: state.layers.waypoints ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 3,
              'circle-color': '#fff',
              'circle-stroke-color': '#6B7280',
              'circle-stroke-width': 1,
            }}
          />
          <Layer
            id="waypoints-label"
            type="symbol"
            minzoom={8}
            layout={{
              visibility: state.layers.waypoints ? 'visible' : 'none',
              'text-field': ['get', 'id'],
              'text-font': ['Noto Sans Regular'],
              'text-size': 10,
              'text-offset': [0, 1],
              'text-anchor': 'top',
            }}
            paint={{ 'text-color': '#4B5563', 'text-halo-color': '#fff', 'text-halo-width': 0.6 }}
          />
        </Source>

        {/* ── 검색 결과 항로 (초록 실선) ──────────────────────────── */}
        <Source id="searched-routes" type="geojson" data={searchedRoutesData}>
          <Layer
            id="searched-routes-line"
            type="line"
            layout={{ visibility: state.layers.matchedRoutes ? 'visible' : 'none' }}
            paint={{
              'line-color': '#10B981',
              'line-width': 2.5,
              'line-opacity': 0.9,
            }}
          />
        </Source>

        {/* ── 선택된 항로 강조 — 흰색 케이싱으로 배경 파란 항로들과 분리 ── */}
        <Source id="selected-route" type="geojson" data={selectedRouteHighlightData}>
          <Layer
            id="selected-route-casing"
            type="line"
            paint={{ 'line-color': '#ffffff', 'line-width': 5.5, 'line-opacity': 0.9 }}
          />
          <Layer
            id="selected-route-line"
            type="line"
            paint={{
              'line-color': selectedIds.length === 0
                ? SELECT_COLORS[0]
                : ['match', ['get', 'id'],
                    ...selectedIds.flatMap((id, i) => [id, SELECT_COLORS[i % SELECT_COLORS.length]]),
                    SELECT_COLORS[0],
                  ] as any,
              'line-width': 3,
              'line-opacity': 1,
            }}
          />
        </Source>

        {/* ── 선택된 항로가 지나는 waypoint — 줌/레이어 토글과 무관하게 항상 표시 ── */}
        <Source id="selected-route-waypoints" type="geojson" data={selectedRouteWaypointsData}>
          <Layer
            id="selected-route-waypoints-circle"
            type="circle"
            paint={{
              'circle-radius': 3.5,
              'circle-color': '#fff',
              'circle-stroke-color': '#F97316',
              'circle-stroke-width': 1.5,
            }}
          />
          <Layer
            id="selected-route-waypoints-label"
            type="symbol"
            layout={{
              'text-field': ['get', 'id'],
              'text-font': ['Noto Sans Regular'],
              'text-size': 11,
              'text-offset': [0, 1],
              'text-anchor': 'top',
              'text-allow-overlap': false,
            }}
            paint={{ 'text-color': '#FDBA74', 'text-halo-color': '#111827', 'text-halo-width': 0.8 }}
          />
        </Source>

        {/* ── Airway 자체 경로 — 흰색 케이싱 + 무채색 핑크 실선, 최상단 ── */}
        <Source id="airway" type="geojson" data={airwayData}>
          <Layer
            id="airway-line-casing"
            type="line"
            paint={{
              'line-color': '#ffffff',
              'line-width': 7,
              'line-opacity': state.layers.activeAirway ? 0.6 : 0,
            }}
          />
          <Layer
            id="airway-line"
            type="line"
            paint={{
              'line-color': '#C08497',
              'line-width': 4,
              'line-opacity': state.layers.activeAirway ? 1 : 0,
            }}
          />
        </Source>

        {/* ── 검색한 항공로가 지나는 waypoint ── */}
        <Source id="airway-waypoints" type="geojson" data={airwayWaypointsData}>
          <Layer
            id="airway-waypoints-circle"
            type="circle"
            layout={{ visibility: state.layers.activeAirway ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 3.5,
              'circle-color': '#fff',
              'circle-stroke-color': '#C08497',
              'circle-stroke-width': 1.5,
            }}
          />
          <Layer
            id="airway-waypoints-label"
            type="symbol"
            layout={{
              visibility: state.layers.activeAirway ? 'visible' : 'none',
              'text-field': ['get', 'id'],
              'text-font': ['Noto Sans Regular'],
              'text-size': 11,
              'text-offset': [0, 1],
              'text-anchor': 'top',
              'text-allow-overlap': false,
            }}
            paint={{ 'text-color': '#D8A8B5', 'text-halo-color': '#111827', 'text-halo-width': 0.8 }}
          />
        </Source>

        {/* ── Typhoon circles ─────────────────────────────────────── */}
        <Source id="typhoon" type="geojson" data={typhoonData}>
          <Layer
            id="typhoon-fill"
            type="fill"
            filter={['==', '$type', 'Polygon']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 }}
          />
          <Layer
            id="typhoon-stroke"
            type="line"
            filter={['==', '$type', 'Polygon']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{ 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [5, 3] }}
          />
          <Layer
            id="typhoon-center"
            type="circle"
            filter={['==', '$type', 'Point']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 6,
              'circle-color': ['get', 'color'],
              'circle-stroke-color': '#fff',
              'circle-stroke-width': 2,
            }}
          />
          <Layer
            id="typhoon-label"
            type="symbol"
            filter={['==', '$type', 'Point']}
            layout={{
              visibility: state.layers.typhoon ? 'visible' : 'none',
              'text-field': ['get', 'name'],
              'text-font': ['Noto Sans Regular'],
              'text-size': 11,
              'text-offset': [0, 1.5],
              'text-anchor': 'top',
            }}
            paint={{ 'text-color': ['get', 'color'], 'text-halo-color': '#111', 'text-halo-width': 2 }}
          />
        </Source>

        {/* ── Typhoon track path ──────────────────────────────────── */}
        <Source id="typhoon-track" type="geojson" data={typhoonTrackData}>
          {/* 실측 항적 — 회색 실선 */}
          <Layer
            id="typhoon-track-hist"
            type="line"
            filter={['==', ['get', 'kind'], 'hist']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{ 'line-color': '#9CA3AF', 'line-width': 2, 'line-opacity': 0.8 }}
          />
          {/* 예보 항적 — 주황 점선 */}
          <Layer
            id="typhoon-track-fcst"
            type="line"
            filter={['==', ['get', 'kind'], 'fcst']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{ 'line-color': '#FB923C', 'line-width': 2.5, 'line-dasharray': [6, 3] }}
          />
          {/* 슬라이더 강조 — 흰 반투명 선 */}
          <Layer
            id="typhoon-track-past"
            type="line"
            filter={['==', ['get', 'kind'], 'past']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{ 'line-color': '#fff', 'line-width': 2.5, 'line-opacity': 0.5 }}
          />
          {/* 위치 점 — 예보는 반투명 */}
          <Layer
            id="typhoon-track-dots"
            type="circle"
            filter={['==', ['get', 'kind'], 'dot']}
            layout={{ visibility: state.layers.typhoon ? 'visible' : 'none' }}
            paint={{
              'circle-radius': ['case', ['get', 'current'], 6, ['get', 'forecast'], 4, 4],
              'circle-color': ['get', 'color'],
              'circle-opacity': ['case', ['get', 'forecast'], 0.55, ['case', ['get', 'past'], 1, 0.4]],
              'circle-stroke-color': '#fff',
              'circle-stroke-width': ['case', ['get', 'current'], 2, ['get', 'forecast'], 1, 0],
            }}
          />
        </Source>

        {/* ── 화산재 구역 (Tokyo VAAC) — OBS(현재) + 6/12/18h 예보 전부 표시 */}
        {/* 시간대별로 색을 뚜렷하게 구분: OBS=빨강(가장 급함) → +6h 주황 → +12h/+18h
            노랑 계열로, 신호등처럼 시간이 지날수록 옅은 색으로 이동 */}
        <Source id="volcanic-ash" type="geojson" data={volcanicAshData}>
          <Layer
            id="volcanic-ash-fill"
            type="fill"
            filter={['==', '$type', 'Polygon']}
            layout={{ visibility: state.layers.volcanicAsh ? 'visible' : 'none' }}
            paint={{
              'fill-color': ASH_STEP_COLOR,
              'fill-opacity': ['interpolate', ['linear'], ['get', 'step_index'], 0, 0.38, 3, 0.2],
            }}
          />
          <Layer
            id="volcanic-ash-stroke"
            type="line"
            filter={['==', '$type', 'Polygon']}
            layout={{ visibility: state.layers.volcanicAsh ? 'visible' : 'none' }}
            paint={{
              'line-color': ASH_STEP_COLOR,
              'line-width': ['interpolate', ['linear'], ['get', 'step_index'], 0, 2.4, 3, 1.4],
              'line-opacity': 0.95,
              'line-dasharray': [3, 2],
            }}
          />
          <Layer
            id="volcanic-ash-label"
            type="symbol"
            filter={['==', '$type', 'Polygon']}
            layout={{
              visibility: state.layers.volcanicAsh ? 'visible' : 'none',
              // 고도(FL) 정보를 라벨에 바로 붙여서 클릭/호버 없이 지도에서 한눈에 확인 가능
              'text-field': [
                'case',
                ['!=', ['get', 'fl_min'], null],
                ['concat',
                  '🌋 ', ['get', 'volcano'], ' · ', ['get', 'step_label'],
                  '\nFL', ['to-string', ['round', ['/', ['get', 'fl_min'], 100]]],
                  '–FL', ['to-string', ['round', ['/', ['get', 'fl_max'], 100]]],
                ],
                ['concat', '🌋 ', ['get', 'volcano'], ' · ', ['get', 'step_label']],
              ] as any,
              'text-font': ['Noto Sans Regular'],
              'text-size': 10,
              'text-line-height': 1.15,
            }}
            paint={{
              'text-color': ASH_STEP_COLOR,
              'text-halo-color': '#1c1917',
              'text-halo-width': 1.4,
            }}
          />
          {/* 화산 실제 위치(정상 좌표) — 확산 구역과 별개로 항상 표시 */}
          <Layer
            id="volcanic-ash-volcano-point"
            type="circle"
            filter={['==', '$type', 'Point']}
            layout={{ visibility: state.layers.volcanicAsh ? 'visible' : 'none' }}
            paint={{
              'circle-radius': 6,
              'circle-color': '#dc2626',
              'circle-stroke-color': '#fff',
              'circle-stroke-width': 2,
            }}
          />
          <Layer
            id="volcanic-ash-volcano-label"
            type="symbol"
            filter={['==', '$type', 'Point']}
            layout={{
              visibility: state.layers.volcanicAsh ? 'visible' : 'none',
              'text-field': ['concat', '🌋 ', ['get', 'volcano']],
              'text-font': ['Noto Sans Regular'],
              'text-size': 11,
              'text-offset': [0, 1.3],
              'text-anchor': 'top',
            }}
            paint={{ 'text-color': '#fca5a5', 'text-halo-color': '#1c1917', 'text-halo-width': 1.4 }}
          />
        </Source>

        {/* ── Spatial filter polygon outline ───────────────────────── */}
        <Source id="spatial-filter" type="geojson" data={spatialFilterData}>
          <Layer
            id="spatial-fill"
            type="fill"
            paint={{ 'fill-color': '#A855F7', 'fill-opacity': 0.08 }}
          />
          <Layer
            id="spatial-outline"
            type="line"
            paint={{ 'line-color': '#A855F7', 'line-width': 2, 'line-dasharray': [4, 2] }}
          />
        </Source>

        {/* ── Airway endpoint markers ───────────────────────────────── */}
        {state.airwayEndpoints.map(ep => (
          <Marker key={ep.id} longitude={ep.lon} latitude={ep.lat} anchor="center">
            <div className="relative flex items-center justify-center pointer-events-none">
              <div className="absolute w-8 h-8 rounded-full bg-yellow-400 opacity-40 animate-ping" />
              <div className="w-4 h-4 rounded-full bg-yellow-400 border-2 border-white shadow-xl z-10" />
            </div>
          </Marker>
        ))}

        {/* ── Search highlight markers (pulsing DOM elements) ──────── */}
        {state.highlightPoints
          .filter(p => p.lat !== null && p.lon !== null)
          .map(p => {
            const c = HIGHLIGHT_COLORS[p.type] ?? HIGHLIGHT_COLORS.waypoint
            return (
              <Marker key={`hl-${p.id}`} longitude={p.lon!} latitude={p.lat!} anchor="center">
                <div className="relative flex items-center justify-center pointer-events-none">
                  <div className={`absolute w-10 h-10 rounded-full ${c.ping} opacity-50 animate-ping`} />
                  <div className={`w-5 h-5 rounded-full ${c.dot} border-2 border-white shadow-xl z-10`} />
                  <div className={`absolute top-6 left-1/2 -translate-x-1/2 text-[11px] font-bold ${c.text} bg-gray-900/90 px-1.5 py-0.5 rounded whitespace-nowrap shadow`}>
                    {p.name}
                  </div>
                </div>
              </Marker>
            )
          })
        }

        {/* ── In-progress drawing ──────────────────────────────────── */}
        <Source id="drawing" type="geojson" data={drawingData}>
          <Layer
            id="drawing-line"
            type="line"
            filter={['==', '$type', 'LineString']}
            paint={{ 'line-color': '#A855F7', 'line-width': 2, 'line-dasharray': [4, 2] }}
          />
          <Layer
            id="drawing-points"
            type="circle"
            filter={['==', '$type', 'Point']}
            paint={{ 'circle-radius': 5, 'circle-color': '#A855F7', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 }}
          />
        </Source>

        {/* ── Traffic ──────────────────────────────────────────────── */}
        {state.layers.traffic && planeIconsReady && (
          <Source id="traffic" type="geojson" data={trafficGeoJSON}>
            {/* 항공기 아이콘 (헤딩 방향으로 회전) */}
            <Layer
              id="traffic-icon"
              type="symbol"
              layout={{
                'icon-image': [
                  'case',
                  ['get', 'on_ground'], 'plane-ground',
                  ['get', 'is_jja'],    'plane-jja',
                  'plane-other',
                ],
                'icon-size': ['case', ['get', 'is_jja'], 0.9, 0.7],
                'icon-rotate': ['get', 'heading'],
                'icon-rotation-alignment': 'map',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
              }}
            />
            {/* 콜사인 라벨 (zoom 7+) */}
            <Layer
              id="traffic-label"
              type="symbol"
              minzoom={7}
              layout={{
                'text-field': ['get', 'callsign'],
                'text-font': ['Noto Sans Regular'],
                'text-size': 9,
                'text-offset': [0, 1.6],
                'text-anchor': 'top',
                'text-allow-overlap': false,
              }}
              paint={{
                'text-color': ['case', ['get', 'is_jja'], '#F97316', '#9CA3AF'],
                'text-halo-color': '#111827',
                'text-halo-width': 1.2,
              }}
            />
          </Source>
        )}

        {/* ── 겹친 항로 목록 호버 강조 (우클릭 메뉴에서 마우스오버) — 항상 최상단 ── */}
        <Source id="hovered-list-route" type="geojson" data={hoveredRouteData}>
          <Layer
            id="hovered-list-route-line"
            type="line"
            paint={{
              'line-color': '#FDE047',
              'line-width': 4,
              'line-opacity': 1,
            }}
          />
        </Source>

        {/* ── 직접 입력한 항로 (SkyVector 스타일) ── */}
        <Source id="adhoc-route" type="geojson" data={adhocRouteData}>
          <Layer
            id="adhoc-route-casing"
            type="line"
            paint={{ 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.5 }}
          />
          <Layer
            id="adhoc-route-line"
            type="line"
            paint={{ 'line-color': '#c084fc', 'line-width': 2.5 }}
          />
        </Source>

        {/* ── 직접 입력한 항로가 지나는 waypoint ── */}
        <Source id="adhoc-route-waypoints" type="geojson" data={adhocRouteWaypointsData}>
          <Layer
            id="adhoc-route-waypoints-circle"
            type="circle"
            paint={{
              'circle-radius': 3.5,
              'circle-color': '#fff',
              'circle-stroke-color': '#c084fc',
              'circle-stroke-width': 1.5,
            }}
          />
          <Layer
            id="adhoc-route-waypoints-label"
            type="symbol"
            layout={{
              'text-field': ['get', 'id'],
              'text-font': ['Noto Sans Regular'],
              'text-size': 11,
              'text-offset': [0, 1],
              'text-anchor': 'top',
              'text-allow-overlap': false,
            }}
            paint={{ 'text-color': '#d8b4fe', 'text-halo-color': '#111827', 'text-halo-width': 0.8 }}
          />
        </Source>
      </Map>

      {/* Tooltip */}
      {tooltip && !inDrawMode && (
        <div
          className="absolute bg-gray-900 border border-gray-700 text-white text-xs rounded-lg shadow-xl p-2.5 pointer-events-none z-10 max-w-sm"
          style={{ left: tooltip.x + 14, top: tooltip.y - 8 }}
        >
          {tooltip.props.origin && tooltip.props.destination ? (
            <>
              <div className="font-bold text-sm text-white">
                {tooltip.props.origin as string}–{tooltip.props.destination as string}
                <span className="ml-1 text-yellow-400 font-semibold">
                  #{tooltip.props.number as number}
                </span>
              </div>
              {tooltip.props.distance && (
                <div className="text-gray-400 mt-1">{tooltip.props.distance as number} NM</div>
              )}
              {tooltip.props.route && (
                <div className="text-gray-400 mt-1 break-all leading-relaxed">
                  {tooltip.props.route as string}
                </div>
              )}
            </>
          ) : tooltip.props.airway ? (
            <div className="font-semibold text-green-400">{tooltip.props.airway as string}</div>
          ) : tooltip.props.callsign ? (
            // Aircraft tooltip
            <div className="space-y-1">
              <div className={`font-bold text-sm ${tooltip.props.is_jja ? 'text-orange-400' : 'text-white'}`}>
                {tooltip.props.callsign as string}
                {!!tooltip.props.is_jja && <span className="ml-2 text-[10px] font-semibold px-1 py-0.5 rounded bg-orange-900/60 border border-orange-700 text-orange-300">제주항공</span>}
              </div>
              <div className="text-gray-400 text-[11px] space-y-0.5">
                {tooltip.props.alt_ft !== null && <div>고도 {(tooltip.props.alt_ft as number).toLocaleString()} ft</div>}
                {tooltip.props.speed_kt !== null && <div>속도 {tooltip.props.speed_kt as number} kt</div>}
                {tooltip.props.heading !== null && <div>헤딩 {(tooltip.props.heading as number).toFixed(0)}°</div>}
                {!!tooltip.props.on_ground && <div className="text-yellow-400">지상 (On Ground)</div>}
              </div>
            </div>
          ) : tooltip.props.volcano ? (
            // 화산재 구역 hover tooltip — 가볍게 요약만, 전문은 클릭해서 확인
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                {!!tooltip.props.step_label && (
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: {
                        OBS: '#ef4444', '+6HR': '#f97316', '+12HR': '#eab308', '+18HR': '#fde047',
                      }[tooltip.props.step_label as string] ?? '#a8a29e',
                    }}
                  />
                )}
                <span className="font-bold text-sm text-white">🌋 {tooltip.props.volcano as string}</span>
                {!!tooltip.props.step_label && <span className="text-gray-400 font-normal">· {tooltip.props.step_label as string}</span>}
              </div>
              <div className="text-gray-400 text-[11px] space-y-0.5">
                <div>{tooltip.props.area as string} · {tooltip.props.vaac as string} VAAC</div>
                {tooltip.props.fl_min != null && tooltip.props.fl_max != null && (
                  <div>고도 FL{Math.round((tooltip.props.fl_min as number) / 100)} – FL{Math.round((tooltip.props.fl_max as number) / 100)}</div>
                )}
              </div>
              <div className="text-gray-600 text-[10px] pt-0.5">클릭하면 전문 확인</div>
            </div>
          ) : 'elevation' in tooltip.props ? (
            // Airport tooltip
            <div>
              <span className="font-semibold text-red-400">{tooltip.props.id as string}</span>
              {!!tooltip.props.name && <span className="text-gray-300 ml-1.5">{tooltip.props.name as string}</span>}
            </div>
          ) : 'terminal' in tooltip.props ? (
            // Waypoint tooltip
            <div className="font-semibold text-gray-300">{tooltip.props.id as string}</div>
          ) : null}
        </div>
      )}

      {/* 화산재 구역/화산 위치 클릭 팝업 — 호버 툴팁과 달리 고정돼서 전문을
          스크롤해서 끝까지 읽을 수 있음. 닫기 버튼이나 다른 곳 클릭 시 닫힘 */}
      {ashPopup && (
        <div
          className="absolute bg-gray-900 border border-gray-700 text-white text-xs rounded-lg shadow-2xl z-20 w-80 max-h-[70vh] flex flex-col"
          style={{
            left: ashPopupPos?.x ?? Math.min(ashPopup.x + 14, window.innerWidth - 340),
            top: ashPopupPos?.y ?? Math.min(ashPopup.y - 8, window.innerHeight - 200),
          }}
        >
          <div
            onMouseDown={onAshPopupDragStart}
            className="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-700 shrink-0 cursor-move select-none"
            title="드래그해서 위치 옮기기"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              {!!ashPopup.props.step_label && (
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{
                    backgroundColor: {
                      OBS: '#ef4444', '+6HR': '#f97316', '+12HR': '#eab308', '+18HR': '#fde047',
                    }[ashPopup.props.step_label as string] ?? '#a8a29e',
                  }}
                />
              )}
              <span className="font-bold text-sm text-white truncate">🌋 {ashPopup.props.volcano as string}</span>
              {!!ashPopup.props.step_label && <span className="text-gray-400 font-normal shrink-0">· {ashPopup.props.step_label as string}</span>}
            </div>
            <button onClick={() => setAshPopup(null)} className="text-gray-500 hover:text-gray-200 shrink-0">
              <X size={14} />
            </button>
          </div>
          <div className="px-3 py-2 overflow-y-auto space-y-2">
            <div className="text-gray-400 text-[11px] space-y-0.5">
              <div>{ashPopup.props.area as string} · {ashPopup.props.vaac as string} VAAC</div>
              {!!ashPopup.props.step_time && <div>예보시각 {ashPopup.props.step_time as string}</div>}
              {ashPopup.props.fl_min != null && ashPopup.props.fl_max != null && (
                <div>고도 FL{Math.round((ashPopup.props.fl_min as number) / 100)} – FL{Math.round((ashPopup.props.fl_max as number) / 100)}
                  <span className="text-gray-500"> ({(ashPopup.props.fl_min as number).toLocaleString()}–{(ashPopup.props.fl_max as number).toLocaleString()} ft)</span>
                </div>
              )}
            </div>
            {!!ashPopup.props.raw_text && (
              <pre className="text-[10px] text-gray-300 bg-gray-950 border border-gray-800 rounded p-2 whitespace-pre-wrap break-words leading-relaxed font-mono">
                {ashPopup.props.raw_text as string}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* 우클릭: 겹친 항로 목록 → 클릭해서 한 단계 더 들어가 상세 보기 */}
      {contextMenu && (
        <div
          className="absolute bg-gray-900 border border-gray-700 text-white text-xs rounded-lg shadow-2xl z-20 w-64 max-h-72 overflow-hidden flex flex-col"
          style={{ left: contextMenu.x + 6, top: contextMenu.y + 6 }}
        >
          {contextMenu.expanded ? (
            <>
              <button
                onClick={() => { setContextMenu({ ...contextMenu, expanded: null }); dispatch({ type: 'SET_HOVERED_ROUTE', payload: null }) }}
                className="flex items-center gap-1 text-gray-400 hover:text-white px-2.5 py-1.5 border-b border-gray-700 shrink-0 transition-colors"
              >
                ← 목록으로 ({contextMenu.list.length}개)
              </button>
              <div className="p-2.5 overflow-y-auto">
                <div className="font-bold text-sm text-white">
                  {contextMenu.expanded.origin as string}–{contextMenu.expanded.destination as string}
                  <span className="ml-1 text-yellow-400 font-semibold">
                    #{contextMenu.expanded.number as number}
                  </span>
                </div>
                <div className="text-gray-400 mt-1">{contextMenu.expanded.distance as number} NM</div>
                <div className="text-gray-400 mt-1 break-all leading-relaxed">
                  {contextMenu.expanded.route as string}
                </div>
                <button
                  onClick={e => {
                    const id = contextMenu.expanded!.id as number
                    if (e.ctrlKey || e.metaKey) dispatch({ type: 'TOGGLE_SELECTED_ROUTE', payload: id })
                    else dispatch({ type: 'SET_SELECTED_ROUTES', payload: [id] })
                    setContextMenu(null)
                  }}
                  className="mt-2 w-full text-center bg-blue-700 hover:bg-blue-600 text-white rounded px-2 py-1 transition-colors"
                >
                  이 항로 지도에서 강조
                </button>
                <div className="text-[10px] text-gray-500 mt-1.5 text-center">
                  Cmd(⌘)+클릭하면 기존 선택에 추가돼요
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="px-2.5 py-1.5 border-b border-gray-700 text-gray-400 shrink-0">
                겹친 항로 {contextMenu.list.length}개
              </div>
              <div className="overflow-y-auto">
                {contextMenu.list.map((p, i) => (
                  <button
                    key={i}
                    onClick={() => { setContextMenu({ ...contextMenu, expanded: p }); dispatch({ type: 'SET_HOVERED_ROUTE', payload: p.id as number }) }}
                    onMouseEnter={() => dispatch({ type: 'SET_HOVERED_ROUTE', payload: p.id as number })}
                    onMouseLeave={() => dispatch({ type: 'SET_HOVERED_ROUTE', payload: null })}
                    className="w-full text-left flex items-center justify-between gap-2 px-2.5 py-1.5 hover:bg-gray-800 transition-colors"
                  >
                    <span className="text-white font-medium">
                      {p.origin as string}–{p.destination as string}
                      <span className="ml-1 text-yellow-400 font-semibold">#{p.number as number}</span>
                    </span>
                    <span className="text-gray-500 shrink-0">{p.distance as number} NM</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Draw mode hint */}
      {inDrawMode && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-gray-900/90 border border-purple-600 text-purple-300 text-xs rounded-lg px-3 py-2 pointer-events-none z-10">
          {state.spatialMode === 'polygon'
            ? `클릭으로 꼭짓점 추가 (${state.spatialPoints.length}개) — 사이드바에서 완료 버튼 클릭`
            : state.spatialPoints.length === 0
              ? '지도에서 중심점을 클릭하세요'
              : '사이드바에서 반경을 입력하고 적용하세요'}
        </div>
      )}
    </div>
  )
}
