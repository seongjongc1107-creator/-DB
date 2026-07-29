// 항로를 최대 10개까지 선택했을 때, 순서대로 배정되는 구분색.
// 사이드바 목록 배지 / 지도 하이라이트 / 비교 패널이 전부 이 배열을 공유해서
// 같은 항로는 어디서 봐도 항상 같은 색으로 보이게 함.
export const SELECT_COLORS = [
  '#EF4444', // red
  '#F97316', // orange
  '#22C55E', // green
  '#A855F7', // purple
  '#EC4899', // pink
  '#14B8A6', // teal
  '#78350F', // brown
  '#F59E0B', // amber
  '#F43F5E', // rose
  '#E5E7EB', // white/silver
] as const
