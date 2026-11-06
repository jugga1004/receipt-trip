// =====================================================================
// 영수증 여행기록 — 기기 간 동기화 (Vercel 함수 + Vercel Blob 저장소, 서울 icn1, Private)
// =====================================================================
// 로그인 대신 "구분키"(예: RT-7K2F-9QXA-M3PD)로 사용자를 나눈다. 구분키는 저장하지 않고
// SHA-256 지문으로만 폴더를 만든다: u/<지문>/
//   data.json       기록 묶음(여행·영수증·환전·지움 표시). 덮어쓴다
//   p/<사진id>.jpg  영수증 사진(한 번 올리면 바뀌지 않음)
//
// 무료 한도 아끼기(Hobby: Advanced 월 2,000회 / Simple 월 10,000회, 2026-11 대시보드 기준):
//   put·list = Advanced, head·읽기 = Simple. 그래서 list는 쓰지 않고 고정 경로를 head로 찾는다.
//   → 받기(pull) = Simple 2회, 올리기(push) = Advanced 1회, 사진 1장 올리기 = Advanced 1회.
//
// 보안: 구분키가 곧 비밀번호다. 저장소는 Private(토큰 없이는 주소를 알아도 못 읽음), 폴더는 지문(추측 불가).
// 앱은 이 함수로만 읽고 쓴다.
// 필요한 설정: Blob 저장소를 만들 때 "read-write token env var" 체크 → BLOB_READ_WRITE_TOKEN.
//
// 요청: POST /sync?a=pull | push | photo-put&id= | photo-get&id=   (헤더 X-Sync-Key: 구분키)

import { put, head } from "@vercel/blob";

const ALLOWED_ORIGINS = ["https://jugga1004.github.io"];
const KEY_RE = /^RT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const ID_RE = /^[a-z0-9]{6,32}$/;
const MAX_DATA = 4 * 1024 * 1024;
const MAX_PHOTO = 4 * 1024 * 1024;
const PER_MIN = 60;
const hits = new Map();

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Sync-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
function json(status, obj, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, origin ? cors(origin) : {}),
  });
}
function limited(ip) {
  const now = Date.now();
  const l = (hits.get(ip) || []).filter((t) => now - t < 60000);
  l.push(now);
  hits.set(ip, l);
  if (hits.size > 5000) hits.clear();
  return l.length > PER_MIN;
}
// Private 저장소라 파일 주소만으로는 못 읽는다 — 토큰을 붙여 읽는다
function readBlob(url) {
  return fetch(url, { headers: { Authorization: "Bearer " + process.env.BLOB_READ_WRITE_TOKEN } });
}
async function folderOf(key) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("receipt-trip:" + key));
  return "u/" + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("") + "/";
}

export function OPTIONS(request) {
  const origin = request.headers.get("origin") || "";
  return ALLOWED_ORIGINS.includes(origin) ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
}

export async function POST(request) {
  const origin = request.headers.get("origin") || "";
  if (!ALLOWED_ORIGINS.includes(origin)) return json(403, { error: "허용되지 않은 사이트입니다." });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return json(500, { error: "서버에 저장 공간(Blob)이 연결되지 않았습니다." }, origin);
  const key = String(request.headers.get("x-sync-key") || "").toUpperCase();
  if (!KEY_RE.test(key)) return json(400, { error: "구분키 형식이 올바르지 않습니다." }, origin);
  const ip = (request.headers.get("x-forwarded-for") || "?").split(",")[0].trim();
  if (limited(ip)) return json(429, { error: "요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요." }, origin);

  const url = new URL(request.url);
  const a = url.searchParams.get("a");
  const dir = await folderOf(key);

  // head: 없으면 null(던지지 않게). 덮어쓴 파일의 옛 내용이 캐시로 오지 않게 주소에 시각을 붙여 읽는다
  async function find(path) {
    try {
      return await head(path);
    } catch (e) {
      if (/not.?found|does not exist/i.test(String((e && e.message) || e)) || (e && e.name === "BlobNotFoundError")) return null;
      throw e;
    }
  }
  const fresh = (b) => b.url + (b.url.includes("?") ? "&" : "?") + "v=" + new Date(b.uploadedAt).getTime();

  try {
    if (a === "pull") {
      const b = await find(dir + "data.json");
      if (!b) return json(200, { data: null }, origin);
      const r = await readBlob(fresh(b));
      if (!r.ok) return json(502, { error: "저장된 기록을 읽지 못했습니다(" + r.status + ")." }, origin);
      return json(200, { data: await r.json() }, origin);
    }

    if (a === "push") {
      const body = await request.text();
      if (body.length > MAX_DATA) return json(413, { error: "기록이 너무 큽니다." }, origin);
      JSON.parse(body); // 형식 확인
      await put(dir + "data.json", body, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60 });
      return json(200, { ok: true }, origin);
    }

    if (a === "photo-put" || a === "photo-get") {
      const id = url.searchParams.get("id") || "";
      if (!ID_RE.test(id)) return json(400, { error: "사진 번호가 올바르지 않습니다." }, origin);
      const path = dir + "p/" + id + ".jpg";
      if (a === "photo-put") {
        const buf = await request.arrayBuffer();
        if (buf.byteLength > MAX_PHOTO) return json(413, { error: "사진이 너무 큽니다." }, origin);
        await put(path, buf, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "image/jpeg" });
        return json(200, { ok: true }, origin);
      }
      const b = await find(path);
      if (!b) return json(404, { error: "사진이 없습니다." }, origin);
      const r = await readBlob(b.url);
      if (!r.ok) return json(502, { error: "사진을 읽지 못했습니다(" + r.status + ")." }, origin);
      return new Response(await r.arrayBuffer(), {
        status: 200,
        headers: Object.assign({ "Content-Type": "image/jpeg", "Cache-Control": "no-store" }, cors(origin)),
      });
    }
    return json(400, { error: "알 수 없는 요청입니다." }, origin);
  } catch (e) {
    return json(500, { error: "저장 공간 오류: " + String((e && e.message) || e).slice(0, 120) }, origin);
  }
}
