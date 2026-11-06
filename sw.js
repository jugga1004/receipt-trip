// 앱 셸(정적 파일)만 오프라인 캐싱한다. LLM API 요청은 캐싱하지 않고 그대로 흘려보낸다 —
// 영수증 사진과 인식 결과가 캐시에 남는 건 이 앱의 프라이버시 원칙에 어긋난다.
// (heart-translator/sw.js에서 가져온 구조. 아래 설명은 그쪽에서 겪은 일이다.)
//
// **네트워크 우선(network-first), 캐시는 오프라인 대비용.**
//
// 처음엔 캐시 우선으로 짰다가 실제로 물렸다: 배포를 새로 해도 한 번 방문한 브라우저는
// 계속 옛 화면을 봤다. 캐시 우선 + 고정 CACHE_NAME 조합이면 "배포할 때마다 이름을
// 손으로 올린다"에 의존하게 되는데, 그건 잊는 순간 사용자가 영영 옛 버전에 갇힌다.
// 실제로 한 번 잊었고, 그게 이 주석이 생긴 이유다.
//
// 그래서 온라인이면 항상 네트워크를 먼저 보고, 실패할 때만 캐시로 떨어진다.
// 앱이 수백 KB라 네트워크 우선의 비용이 작고, 오프라인 동작은 그대로 남는다.
// 이제 CACHE_NAME은 저장소를 비울 때만 올리면 된다.
//
// 참고: 서비스워커는 https 또는 localhost에서만 등록된다. index.html을 file://로 열면
// 등록이 안 되지만, app.js가 그 경우를 건너뛰도록 처리해두어서 앱 자체는 정상 동작한다.
var CACHE_NAME = "receipt-book-v4";
var APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./config.js",
  "./store.js",
  "./sync.js",
  "./fx.js",
  "./geo.js",
  "./map.js",
  "./scan.js",
  "./settle.js",
  "./stats.js",
  "./csv.js",
  "./app.js",
  "./manifest.json",
  "./icon.svg",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(APP_SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key !== CACHE_NAME;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);

  // 다른 오리진(Gemini, OSM 지도 타일·검색)은 캐시에 손대지 않고 그대로 통과.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    // cache: "no-cache" — 네트워크 우선이어도 브라우저 HTTP 캐시(GitHub Pages는 10분)를 그대로 쓰면
    // 배포 직후 옛 파일을 받는다(2026-11 실측: index.html은 새것, store.js는 옛것이 섞여 오류).
    // no-cache는 서버에 바뀌었는지만 물어 바뀐 게 없으면 304로 가볍게 끝난다.
    fetch(event.request, { cache: "no-cache" })
      .then(function (response) {
        // 성공한 응답만 캐시에 넣는다. 404나 오류 페이지를 캐시하면
        // 오프라인일 때 그 오류가 되살아난다.
        if (response && response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(function () {
        // 여기까지 오면 네트워크가 없다는 뜻이다. 그때만 캐시를 쓴다.
        return caches.match(event.request).then(function (cached) {
          if (cached) return cached;
          // 캐시에도 없는 경로면 앱 껍데기라도 돌려준다(새로고침 시 흰 화면 방지).
          if (event.request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        });
      })
  );
});
