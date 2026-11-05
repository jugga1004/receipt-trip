(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 위치 — 영수증 주소 → 좌표, 사진 GPS, 거리, 날짜별 동선
  // ---------------------------------------------------------------------
  // 지오코딩은 OpenStreetMap Nominatim(무료·키 없음·CORS 허용)을 쓴다.
  // 이용 정책: 초당 1회 이하, 결과 캐시, 대량 일괄 조회 금지 → 요청을 줄 세워 1.1초 간격으로 보내고
  // 같은 검색어는 localStorage에 캐시한다. 개인용 규모를 넘으면 유료 지오코더로 바꿔야 한다.
  //
  // 위치를 찾는 순서(앞에서 찾으면 멈춤):
  //   1. map_query(AI가 만든 짧은 검색어)  2. 주소 원문  3. 상호 + 도시
  //   4. 사진 GPS(EXIF) — 영수증을 숙소에서 찍었으면 틀리므로 주소보다 뒤
  //   5. 도시만(대략)
  // src: query | address | name | photo | city | search | gps | manual

  var GEO = {};
  var ENDPOINT = "https://nominatim.openstreetmap.org/search";
  var CACHE_KEY = "receipt-book.geocache";
  var GAP_MS = 1100;

  GEO.SRC_LABEL = {
    query: "영수증 주소",
    address: "영수증 주소",
    area: "주소 근처",
    name: "가게 이름",
    photo: "사진 GPS",
    city: "도시(대략)",
    search: "검색",
    gps: "현재 위치",
    manual: "직접 지정",
  };
  GEO.isApprox = function (place) {
    return !!place && (place.src === "city" || !!place.approx);
  };
  GEO.has = function (place) {
    return !!place && isFinite(place.lat) && isFinite(place.lng) && place.lat !== null && place.lng !== null;
  };

  // --------------------------------------------------------- 캐시·줄 세우기
  var mem = {};
  function cacheGet(k) {
    if (k in mem) return mem[k];
    try {
      var all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      return all[k];
    } catch (e) {
      return undefined;
    }
  }
  function cacheSet(k, v) {
    mem[k] = v;
    try {
      var all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      all[k] = v;
      var keys = Object.keys(all);
      if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(function (x) { delete all[x]; });
      localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  var chain = Promise.resolve();
  var last = 0;
  function queued(fn) {
    var p = chain.then(function () {
      var wait = Math.max(0, last + GAP_MS - Date.now());
      return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
        last = Date.now();
        return fn();
      });
    });
    chain = p.catch(function () {});
    return p;
  }

  // 검색 → [{lat, lng, label}]. 실패해도 throw하지 않고 빈 배열(네트워크 오류만 throw).
  GEO.search = function (q, opts) {
    opts = opts || {};
    q = String(q || "").trim();
    if (!q) return Promise.resolve([]);
    var limit = opts.limit || 1;
    var cc = (opts.country || "").toLowerCase();
    var key = q + "|" + cc + "|" + limit;
    var hit = cacheGet(key);
    if (hit) return Promise.resolve(hit);
    var url = ENDPOINT + "?format=jsonv2&addressdetails=0&accept-language=ko&limit=" + limit + "&q=" + encodeURIComponent(q) + (cc ? "&countrycodes=" + cc : "");
    return queued(function () {
      return fetch(url, { headers: { Accept: "application/json" } });
    }).then(function (res) {
      if (!res.ok) throw new Error("지도 검색 실패(" + res.status + ")");
      return res.json();
    }).then(function (arr) {
      var out = (arr || []).map(function (r) {
        return { lat: Number(r.lat), lng: Number(r.lon), label: shortLabel(r.display_name) };
      }).filter(function (r) { return isFinite(r.lat) && isFinite(r.lng); });
      cacheSet(key, out);
      return out;
    });
  };

  // "난바, 주오구, 오사카시, 오사카부, 542-0076, 일본" → 앞 3토막
  function shortLabel(s) {
    return String(s || "").split(",").map(function (x) { return x.trim(); }).filter(function (x) { return x && !/^\d[\d-]*$/.test(x); }).slice(0, 3).join(", ");
  }
  GEO.shortLabel = shortLabel;

  // 영수증 정보로 시도할 검색어 목록(중복 제거, 순서 = 우선순위)
  GEO.queries = function (e) {
    var p = e.place || {};
    var list = [];
    var push = function (q, src) {
      q = String(q || "").replace(/\s+/g, " ").trim();
      if (q.length < 2) return;
      if (list.some(function (x) { return x.q === q; })) return;
      list.push({ q: q, src: src });
    };
    push(p.query, "query");
    push(p.address, "address");
    // 주소 끝의 층·호수·건물명을 떼어 낸 버전 (예: "…難波3-1-1 なんばビル5F" → "…難波3-1-1")
    // 건물·층 표시(ビル, 빌딩, 5F, 3층, 2階, #301)가 시작되는 곳에서 자르고 마지막 숫자까지만 남긴다.
    // 숫자 뒤를 무조건 자르면 한국 도로명("…72번길 75")이 "…72"로 망가진다.
    var addr = String(p.address || "");
    var bm = addr.search(/\d+\s*(?:F(?![a-z])|階|층)|ビル|빌딩|Bldg|Building|#\s*\d/i);
    if (bm > 0) push(addr.slice(0, bm).replace(/(\d)\D*$/, "$1"), "address");
    // 끝의 번지를 한 토막씩 떼어 동네 수준으로 (Nominatim은 일본 번지까지는 잘 못 찾는다.
    // 2026-11 실측: "大阪市北区梅田1-1" ✗ → "大阪市北区梅田1" ✓(1丁目))
    var base = (list[list.length - 1] || {}).q || "";
    for (var i = 0; i < 4; i++) {
      var cut = base.replace(/[\s\-－‐ー]*\d+(?:丁目|番地?|号|번지|번길|길)?\s*$/, "");
      if (cut === base || cut.replace(/\s/g, "").length < 4) break;
      push(cut, "area");
      base = cut;
    }
    // 상호 검색은 맨 뒤. 체인점은 다른 지점이 먼저 걸린다
    // (2026-11 실측: "くら寿司 なんば店 大阪市" → 6km 떨어진 니시요도가와 지점).
    var shop = e.merchant || e.merchantKo;
    if (shop && p.city) push(shop + " " + p.city, "name");
    return list;
  };

  // 영수증 1건의 좌표를 찾는다. photoGps: {lat,lng} | null (원본 사진 EXIF)
  // → place 객체(좌표 못 찾으면 lat/lng 없음). 네트워크가 안 되면 있는 정보만 돌려준다.
  GEO.locate = function (e, photoGps) {
    var p = Object.assign({}, e.place || {});
    var qs = GEO.queries(e);
    var cc = p.country;
    var i = 0;
    function next() {
      if (i >= qs.length) return fallback();
      var item = qs[i++];
      return GEO.search(item.q, { country: cc }).then(function (r) {
        if (r.length) return done(r[0], item.src, item.src === "area" && !/[0-9０-９]/.test(item.q));
        return next();
      });
    }
    function fallback() {
      if (photoGps) return Object.assign(p, { lat: photoGps.lat, lng: photoGps.lng, src: "photo", label: "사진 찍은 곳", approx: false });
      if (!p.city) return p;
      return GEO.search(p.city, { country: cc }).then(function (r) {
        return r.length ? done(r[0], "city", true) : p;
      });
    }
    function done(r, src, approx) {
      return Object.assign(p, { lat: r.lat, lng: r.lng, src: src, label: r.label, approx: !!approx });
    }
    return next().catch(function () {
      if (photoGps) return Object.assign(p, { lat: photoGps.lat, lng: photoGps.lng, src: "photo" });
      return p;
    });
  };

  // ------------------------------------------------------------- EXIF GPS
  // 원본 JPEG(압축 전 File)에서 GPS만 읽는다. 압축(canvas)하면 EXIF가 사라지므로 압축 전에 부른다.
  // 앨범에서 고른 사진에만 보통 남아 있다(카메라 바로 촬영·일부 iOS 업로드는 위치가 빠짐).
  GEO.exifGps = function (file) {
    if (!file || !file.slice) return Promise.resolve(null);
    return file.slice(0, 256 * 1024).arrayBuffer().then(GEO.parseExifGps, function () { return null; });
  };

  GEO.parseExifGps = function (buf) {
    try {
      var v = new DataView(buf);
      if (v.getUint16(0) !== 0xffd8) return null;
      var off = 2;
      while (off + 4 < v.byteLength) {
        var marker = v.getUint16(off);
        var size = v.getUint16(off + 2);
        if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return readTiff(v, off + 10);
        if ((marker & 0xff00) !== 0xff00) return null;
        off += 2 + size;
      }
    } catch (e) {}
    return null;
  };

  function readTiff(v, t) {
    var le = v.getUint16(t) === 0x4949;
    var u16 = function (o) { return v.getUint16(o, le); };
    var u32 = function (o) { return v.getUint32(o, le); };
    function ifd(o) {
      var n = u16(o);
      var tags = {};
      for (var i = 0; i < n; i++) {
        var e = o + 2 + i * 12;
        tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
      }
      return tags;
    }
    var ifd0 = ifd(t + u32(t + 4));
    if (!ifd0[0x8825]) return null;
    var g = ifd(t + u32(ifd0[0x8825].at));
    function rats(tag) {
      if (!tag || tag.type !== 5) return null;
      var o = t + u32(tag.at);
      var out = [];
      for (var i = 0; i < tag.count; i++) {
        var d = u32(o + i * 8 + 4);
        out.push(d ? u32(o + i * 8) / d : 0);
      }
      return out;
    }
    function ref(tag) {
      return tag ? String.fromCharCode(v.getUint8(tag.at)) : "";
    }
    var la = rats(g[2]);
    var lo = rats(g[4]);
    if (!la || !lo) return null;
    var lat = GEO.dms(la, ref(g[1]));
    var lng = GEO.dms(lo, ref(g[3]));
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return null;
    return { lat: lat, lng: lng };
  }

  GEO.dms = function (arr, ref) {
    var d = (arr[0] || 0) + (arr[1] || 0) / 60 + (arr[2] || 0) / 3600;
    return ref === "S" || ref === "W" ? -d : d;
  };

  // ------------------------------------------------------------ 거리·동선
  GEO.distanceKm = function (a, b) {
    var R = 6371;
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  GEO.pathKm = function (pts) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) s += GEO.distanceKm(pts[i - 1], pts[i]);
    return s;
  };

  // 시간순 정렬(시각 없는 건은 그날 맨 뒤가 아니라 입력 순서 유지를 위해 createdAt/updatedAt로)
  GEO.chrono = function (entries) {
    return entries.slice().sort(function (a, b) {
      return (a.date || "").localeCompare(b.date || "") || (a.time || "99:99").localeCompare(b.time || "99:99") || (a.updatedAt || "").localeCompare(b.updatedAt || "");
    });
  };

  // 여행 N일차. 출발일이 있으면 출발일 기준, 없으면 기록이 있는 날짜 순서.
  GEO.dayNo = function (date, start, dates) {
    if (!date) return 0;
    if (start) {
      var d = Math.round((new Date(date + "T00:00:00") - new Date(start + "T00:00:00")) / 86400000);
      return d + 1;
    }
    return dates.indexOf(date) + 1;
  };

  // 날짜별 묶음: [{date, no, entries[], located[], km}]
  GEO.days = function (entries, start) {
    var sorted = GEO.chrono(entries);
    var dates = [];
    sorted.forEach(function (e) { if (dates.indexOf(e.date || "") < 0) dates.push(e.date || ""); });
    var known = dates.filter(Boolean);
    return dates.map(function (d) {
      var es = sorted.filter(function (e) { return (e.date || "") === d; });
      var loc = es.filter(function (e) { return GEO.has(e.place); }).map(function (e) { return e.place; });
      return { date: d, no: GEO.dayNo(d, start, known), entries: es, located: loc.length, km: GEO.pathKm(loc) };
    });
  };

  global.Geo = GEO;
})(this);
