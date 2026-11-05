// 배포 설정 — 비밀값을 넣는 곳이 아니다(공개 저장소에 그대로 올라간다).
// proxyUrl: Vercel에 올린 중계 서버 주소(api/gemini.js). 비워 두면 사용자가 각자 키를 넣어야 인식된다.
//   (Cloudflare Worker는 Gemini가 "지원 안 하는 지역"으로 거절해서 2026-11 Vercel로 옮김)
var APP_CONFIG = {
  proxyUrl: "https://receipt-trip-jugga1004s-projects.vercel.app",
};
