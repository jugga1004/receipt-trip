// =====================================================================
// 영수증 여행기록 — Gemini 중계 서버 (Cloudflare Worker)
// =====================================================================
// 운영자의 Gemini 키를 이 서버에만 두고, 앱(GitHub Pages)은 키 없이 여기로 요청한다.
// 키는 코드에 쓰지 않는다 → Cloudflare 대시보드 Settings → Variables and Secrets에
// 이름 GEMINI_KEY, 종류 Secret으로 넣는다.
//
// 막아 두는 것
//   - 우리 사이트(ALLOWED_ORIGINS)에서 온 브라우저 요청만 받는다. (curl 등은 Origin을 꾸밀 수 있어
//     완벽한 차단은 아니다 → Google Cloud 콘솔에서 하루 요청 상한을 같이 걸어 둘 것)
//   - 모델은 flash 계열만 허용(비싼 pro 모델로 돌리는 것 방지)
//   - 요청 크기 4MB 제한, IP당 분당 15회(같은 서버 인스턴스 안에서의 대략적인 제한)
// 저장하지 않는 것: 요청·응답 내용은 어디에도 기록하지 않고 그대로 넘긴다.

const ALLOWED_ORIGINS = ["https://jugga1004.github.io"];
const MODEL_RE = /^gemini-[0-9.]+-flash(-lite)?(-[a-z0-9-]+)?$/;
const MAX_BYTES = 4 * 1024 * 1024;
const PER_MIN = 15;

const hits = new Map(); // ip → [시각들] (인스턴스 메모리, 재시작되면 비워짐)

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function fail(status, message, origin) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, origin ? cors(origin) : {}),
  });
}

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > PER_MIN;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const ok = ALLOWED_ORIGINS.includes(origin);

    if (request.method === "OPTIONS") {
      return ok ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
    }
    if (!ok) return fail(403, "허용되지 않은 사이트에서 온 요청입니다.");
    if (request.method !== "POST") return fail(405, "POST만 받습니다.", origin);
    if (!env.GEMINI_KEY) return fail(500, "서버에 GEMINI_KEY가 설정되지 않았습니다.", origin);

    // 경로: /models/<모델>:generateContent
    const m = new URL(request.url).pathname.match(/^\/models\/([^/:]+):generateContent$/);
    if (!m || !MODEL_RE.test(m[1])) return fail(400, "지원하지 않는 모델입니다. (flash 계열만 가능)", origin);

    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > MAX_BYTES) return fail(413, "사진이 너무 큽니다.", origin);

    const ip = request.headers.get("CF-Connecting-IP") || "?";
    if (limited(ip)) return fail(429, "요청이 너무 잦습니다. 1분 뒤 다시 시도해 주세요.", origin);

    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BYTES) return fail(413, "사진이 너무 큽니다.", origin);

    const upstream = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + m[1] + ":generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
        body,
      }
    );
    const text = await upstream.text();
    // Cloudflare 무료 요금제는 한국 사용자를 홍콩(HKG) 데이터센터로 보내기도 하는데,
    // Gemini는 홍콩발 요청을 "User location is not supported"(400)로 거절한다(2026-11 실측).
    // 앱이 알아보고 다시 시도하도록 451로 바꿔 돌려준다. 근본 해결은 Worker 배치(Placement)를 미국 등으로 두는 것.
    if (upstream.status === 400 && /location is not supported/i.test(text)) {
      const colo = (request.cf && request.cf.colo) || "?";
      return fail(451, "중계 서버가 Gemini를 쓸 수 없는 지역(" + colo + ")에서 실행됐습니다.", origin);
    }
    return new Response(text, {
      status: upstream.status,
      headers: Object.assign({ "Content-Type": "application/json" }, cors(origin)),
    });
  },
};
