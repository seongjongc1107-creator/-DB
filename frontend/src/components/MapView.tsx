import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import Map, { Source, Layer, Marker, type MapRef, type MapLayerMouseEvent } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as turf from '@turf/turf'
import { useApp } from '../AppContext'
import { classifyLevel, getThresholds, highlightSegments } from '../lib/weatherClassify'

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

const FIR_STATIC = {
  type: 'FeatureCollection' as const,
  features: [
    { type: 'Feature' as const, properties: { icao: 'RKRR', name: 'Incheon FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[122,40],[132,40],[135,37],[135,33],[130,32],[124,32],[122,34],[122,40]]] } },
    // 일본은 본토 전역이 단일 FIR(후쿠오카 FIR, ICAO RJJJ). "RJJF"·"Tokyo FIR"는
    // 실존하지 않는 코드/명칭이라 하나로 합침.
    { type: 'Feature' as const, properties: { icao: 'RJJJ', name: 'Fukuoka FIR' },
      geometry: { type: 'MultiPolygon' as const, coordinates: [
        [[[130,32],[135,33],[135,37],[148,40],[148,28],[135,24],[124,24],[124,32],[130,32]]],
        [[[135,40],[135,50],[145,60],[160,60],[160,50],[148,40],[135,40]]],
      ] } },
    { type: 'Feature' as const, properties: { icao: 'ZSHA', name: 'Shanghai FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[110,26],[122,26],[124,32],[122,34],[122,40],[110,40],[110,26]]] } },
    { type: 'Feature' as const, properties: { icao: 'ZJSA', name: 'Sanya FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[107,10],[122,10],[122,26],[110,26],[107,22],[107,10]]] } },
    { type: 'Feature' as const, properties: { icao: 'RPHI', name: 'Manila FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[116,4],[130,4],[136,10],[136,22],[124,24],[122,18],[122,10],[116,4]]] } },
    { type: 'Feature' as const, properties: { icao: 'VHHK', name: 'Hongkong FIR' },
      geometry: { type: 'Polygon' as const, coordinates: [[[107,10],[116,10],[116,22],[107,22],[107,10]]] } },
  ],
}

export default function MapView() {
  const { state, dispatch } = useApp()
  const mapRef = useRef<MapRef>(null)
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; props: Record<string, unknown> } | null>(null)
  const [mousePos, setMousePos] = useState<[number, number] | null>(null)
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

  // FIR 레이어: react-map-gl Source/Layer 대신 MapLibre API 직접 호출
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return

    // plane icons는 traffic useEffect에서 처리

    if (!map.getSource('fir-direct')) {
      map.addSource('fir-direct', { type: 'geojson', data: FIR_STATIC as any })
      map.addLayer({ id: 'fir-d-fill', type: 'fill', source: 'fir-direct',
        paint: { 'fill-color': '#22D3EE', 'fill-opacity': 0.06 } })
      map.addLayer({ id: 'fir-d-line', type: 'line', source: 'fir-direct',
        paint: { 'line-color': '#22D3EE', 'line-width': 2 } })
      map.addLayer({ id: 'fir-d-label', type: 'symbol', source: 'fir-direct',
        layout: { 'text-field': ['get', 'icao'], 'text-size': 14, 'text-anchor': 'center' },
        paint: { 'text-color': '#22D3EE', 'text-halo-color': '#000', 'text-halo-width': 2 } })
    }
  }, [mapLoaded])

  // FIR 레이어 가시성 토글
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    const vis = state.layers.fir ? 'visible' : 'none'
    ;['fir-d-fill', 'fir-d-line', 'fir-d-label'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis)
    })
  }, [mapLoaded, state.layers.fir])

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
    // Airport click → open METAR panel
    if (f.layer?.id === 'airports-circle') {
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
      dispatch({ type: 'SET_SELECTED_ROUTES', payload: [id] })
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

  const onMouseLeave = useCallback(() => {
    setHoveredId(null)
    setTooltip(null)
    setMousePos(null)
  }, [])

  const airwayData = state.airwayGeoJSON ?? EMPTY_FC


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
    airport:  { ping: 'bg-orange-400', dot: 'bg-orange-500', text: 'text-orange-300' },
    waypoint: { ping: 'bg-cyan-400',   dot: 'bg-cyan-400',   text: 'text-cyan-300'   },
    airway:   { ping: 'bg-purple-400', dot: 'bg-purple-500', text: 'text-purple-300' },
    route:    { ping: 'bg-blue-400',   dot: 'bg-blue-500',   text: 'text-blue-300'   },
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

  // 공간 필터(태풍 등)와 교차하는 항로 id만 표시용으로 표시 — 목록 자체는 건드리지 않음
  // (예전엔 여기서 allRoutes를 교차하는 항로로 통째로 갈아치워서, 영향 없는 항로를
  // 고르면 지도에 아무것도 안 뜨는 버그가 있었음)
  useEffect(() => {
    if (!spatialRoutesData) {
      dispatch({ type: 'SET_AFFECTED_ROUTES', payload: [] })
      return
    }
    const ids = spatialRoutesData.features.map(f => f.properties?.id as number)
    dispatch({ type: 'SET_AFFECTED_ROUTES', payload: ids })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spatialRoutesData])

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
            'routes-line-hit', 'airports-circle', 'airway-line',
            'searched-routes-line', 'selected-route-line',
            ...(state.layers.traffic ? ['traffic-icon'] : []),
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
        {true && (
          <Source id="fir" type="geojson" data={FIR_STATIC}>
            <Layer
              id="fir-fill"
              type="fill"
              layout={{ visibility: state.layers.fir ? 'visible' : 'none' }}
              paint={{ 'fill-color': '#22D3EE', 'fill-opacity': 0.05 }}
            />
            <Layer
              id="fir-line"
              type="line"
              layout={{ visibility: state.layers.fir ? 'visible' : 'none' }}
              paint={{ 'line-color': '#22D3EE', 'line-width': 2, 'line-opacity': 0.9 }}
            />
            <Layer
              id="fir-label"
              type="symbol"
              layout={{
                visibility: state.layers.fir ? 'visible' : 'none',
                'text-field': ['get', 'icao'],
                'text-size': 14,
                'text-anchor': 'center',
              }}
              paint={{ 'text-color': '#22D3EE', 'text-opacity': 0.9, 'text-halo-color': '#000', 'text-halo-width': 2 }}
            />
          </Source>
        )}

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
              'text-size': 10,
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
              'text-halo-width': 1.5,
            }}
          />
        </Source>

        {/* ── Waypoints ─────────────────────────────────────────────── */}
        <Source id="waypoints" type="geojson" data={waypointsData}>
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
              'text-size': 9,
              'text-offset': [0, 1],
              'text-anchor': 'top',
            }}
            paint={{ 'text-color': '#4B5563', 'text-halo-color': '#fff', 'text-halo-width': 1 }}
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

        {/* ── 선택된 항로 강조 (색으로만 구분, 얇게) ───────────────── */}
        <Source id="selected-route" type="geojson" data={selectedRouteHighlightData}>
          <Layer
            id="selected-route-line"
            type="line"
            paint={{
              'line-color': selectedIds.length === 2
                ? ['match', ['get', 'id'], selectedIds[0], '#F97316', selectedIds[1], '#22D3EE', '#F97316']
                : '#F97316',
              'line-width': 2.2,
              'line-opacity': 1,
            }}
          />
        </Source>

        {/* ── Airway 자체 경로 — 흰색 케이싱 + 노란 실선, 최상단 ── */}
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
              'line-color': '#FBBF24',
              'line-width': 4,
              'line-opacity': state.layers.activeAirway ? 1 : 0,
            }}
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
      </Map>

      {/* Tooltip */}
      {tooltip && !inDrawMode && (
        <div
          className="absolute bg-gray-900 border border-gray-700 text-white text-xs rounded-lg shadow-xl p-2.5 pointer-events-none z-10 max-w-xs"
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
          ) : null}
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
                onClick={() => setContextMenu({ ...contextMenu, expanded: null })}
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
                  onClick={() => {
                    dispatch({ type: 'SET_SELECTED_ROUTES', payload: [contextMenu.expanded!.id as number] })
                    setContextMenu(null)
                  }}
                  className="mt-2 w-full text-center bg-blue-700 hover:bg-blue-600 text-white rounded px-2 py-1 transition-colors"
                >
                  이 항로 지도에서 강조
                </button>
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
                    onClick={() => setContextMenu({ ...contextMenu, expanded: p })}
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
