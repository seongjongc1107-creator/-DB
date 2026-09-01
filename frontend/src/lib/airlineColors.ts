// 콜사인 앞 3글자(ICAO 항공사 코드) → 그 항공사 CI에 가까운 색.
// FOIS 실제 항로 오버레이를 항공사별로 한눈에 구분하기 위한 용도라 100% 정확한
// 브랜드 팬톤 값일 필요는 없음 — 인지 가능한 정도로만 맞추면 충분.
const AIRLINE_COLORS: Record<string, string> = {
  // 한국
  KAL: '#0B3B7F', // 대한항공 네이비
  AAR: '#B01C2E', // 아시아나항공 레드
  JJA: '#F58220', // 제주항공 오렌지
  JNA: '#0B2A5B', // 진에어 네이비
  TWB: '#EB1C2D', // 티웨이항공 레드
  ABL: '#00A0DE', // 에어부산 스카이블루
  ESR: '#FDB827', // 이스타항공 옐로우
  ASV: '#5B2D90', // 에어서울 퍼플
  AIH: '#E4032E', // 에어인천(화물) 레드
  // 일본
  JAL: '#C8102E', // 일본항공 레드
  ANA: '#13448F', // 전일본공수 블루
  APJ: '#EC008C', // 피치항공 핑크
  TGW: '#F58426', // 타이거에어 대만... (실제론 싱가포르계, 근사)
  // 중화권
  CCA: '#E30012', // 중국국제항공 레드
  CSN: '#0054A6', // 중국남방항공 블루
  CES: '#004EA2', // 중국동방항공 블루
  CPA: '#006564', // 캐세이퍼시픽 제이드그린
  CAL: '#008080', // 중화항공 틸
  EVA: '#00603C', // 에바항공 그린
  CQH: '#F5A800', // 춘추항공 옐로우
  HDA: '#E2231A', // 홍콩항공 레드
  // 동남아
  SIA: '#F5A200', // 싱가포르항공 골드
  MAS: '#005AA9', // 말레이시아항공 블루
  CEB: '#F58220', // 세부퍼시픽 오렌지
  VJC: '#E4032E', // 비엣젯 레드
  TTW: '#00529B', // 타이항공 계열 블루(근사)
  AXM: '#FF0000', // 에어아시아 레드
  PAL: '#00338D', // 필리핀항공 블루
  // 중동/기타 장거리
  UAE: '#C8102E', // 에미레이트 레드
  QTR: '#5C0632', // 카타르항공 버건디
  ETH: '#FFCC00', // 에티오피아항공 옐로우
  // 미주/유럽
  UAL: '#005DAA', // 유나이티드 블루
  DAL: '#C01933', // 델타 레드
  AAL: '#0078D2', // 아메리칸 블루
  DLH: '#05164D', // 루프트한자 네이비
  AFR: '#002157', // 에어프랑스 네이비
  KLM: '#00A1DE', // KLM 스카이블루
  BAW: '#075AAA', // 영국항공 블루
  QFA: '#E4032E', // 콴타스 레드
  // 화물
  GTI: '#4B4B4B', // Atlas Air 그레이
  FDX: '#4D148C', // FedEx 퍼플
  UPS: '#351C15', // UPS 브라운
  CSS: '#00529B', // 근사치
}

// 목록에 없는 항공사는 콜사인 해시로 팔레트에서 결정론적으로 골라서, 매번 같은
// 항공사는 항상 같은 색이 되게 함(그래프 카테고리 색과 동일한 접근)
const FALLBACK_PALETTE = [
  '#22D3EE', '#A3E635', '#F472B6', '#FBBF24', '#818CF8',
  '#34D399', '#FB923C', '#60A5FA', '#E879F9', '#4ADE80',
]

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

// CI 색 그대로 쓰면 대한항공/진에어/루프트한자/에어프랑스/UPS처럼 어두운
// 네이비·브라운 계열이 이 앱의 어두운 배경 위에서 거의 안 보임. 색상(hue)은
// 유지한 채 명도만 다크 배경에서 읽히는 수준으로 올려서 반환함.
function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  const d = max - min
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    switch (max) {
      case r: h = ((g - b) / d) % 6; break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4
    }
    h *= 60
    if (h < 0) h += 360
  }
  return [h, s * 100, l * 100]
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let [r, g, b] = [0, 0, 0]
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

const MIN_LIGHTNESS = 55 // 이 밑으로는 다크 테마 배경 위에서 텍스트가 잘 안 읽힘

function ensureReadable(hex: string): string {
  const [h, s, l] = hexToHsl(hex)
  return l >= MIN_LIGHTNESS ? hex : hslToHex(h, s, MIN_LIGHTNESS)
}

export function airlineColor(callsign: string): string {
  const code = callsign.slice(0, 3).toUpperCase()
  const base = AIRLINE_COLORS[code] ?? FALLBACK_PALETTE[hashCode(code) % FALLBACK_PALETTE.length]
  return ensureReadable(base)
}
