// =====================================================================
// 영수증 여행기록 — Gemini 중계 서버 (Vercel 함수, 미국 동부 iad1에서 실행)
// =====================================================================
// Cloudflare Worker에서 Vercel로 옮긴 이유(2026-11 실측):
//   Cloudflare는 Worker를 미국(remote-OMA)에서 돌려도 Gemini가 "User location is not supported"로
//   계속 거절했다. Cloudflare가 전 세계에서 같이 쓰는 나가는 주소를 Google이 홍콩으로 보는 것으로 추정.
//   Vercel 함수는 AWS 미국 리전 주소로 나가므로 이 문제가 없다.
//
// 키: Vercel 프로젝트 Settings → Environment Variables에 GEMINI_KEY (코드·저장소에 쓰지 않는다)
// 경로: vercel.json이 /models/<모델>:generateContent 를 이 함수로 보낸다(앱 쪽 코드는 그대로).
// 막아 두는 것: 우리 사이트(Origin)만, flash 계열 모델만, 4MB 이하, IP당 분당 15회(대략).
// 저장하지 않는 것: 요청·응답 내용은 기록하지 않고 그대로 넘긴다.

const ALLOWED_ORIGINS = ["https://jugga1004.github.io"];
const MODEL_RE = /^gemini-[0-9.]+-flash(-lite)?(-[a-z0-9-]+)?$/;
const MAX_BYTES = 4 * 1024 * 1024;
const PER_MIN = 15;
const hits = new Map();

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

export function OPTIONS(request) {
  const origin = request.headers.get("origin") || "";
  return ALLOWED_ORIGINS.includes(origin) ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
}

export async function POST(request) {
  const origin = request.headers.get("origin") || "";
  if (!ALLOWED_ORIGINS.includes(origin)) return fail(403, "허용되지 않은 사이트에서 온 요청입니다.");
  const key = process.env.GEMINI_KEY;
  if (!key) return fail(500, "서버에 GEMINI_KEY가 설정되지 않았습니다.", origin);

  // vercel.json rewrite가 ?m=<모델>:generateContent 로 넘겨준다
  const m = (new URL(request.url).searchParams.get("m") || "").match(/^([^/:]+):generateContent$/);
  if (!m || !MODEL_RE.test(m[1])) return fail(400, "지원하지 않는 모델입니다. (flash 계열만 가능)", origin);

  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return fail(413, "사진이 너무 큽니다.", origin);
  const ip = (request.headers.get("x-forwarded-for") || "?").split(",")[0].trim();
  if (limited(ip)) return fail(429, "요청이 너무 잦습니다. 1분 뒤 다시 시도해 주세요.", origin);

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return fail(413, "사진이 너무 큽니다.", origin);

  const upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + m[1] + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body,
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: Object.assign({ "Content-Type": "application/json" }, cors(origin)),
  });
}
