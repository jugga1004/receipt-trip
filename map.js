(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 작은 지도 — OpenStreetMap 타일 + 번호 핀 + 동선 선
  // ---------------------------------------------------------------------
  // Leaflet 같은 외부 라이브러리를 안 쓴다: 빌드 도구가 없고, 미리보기 창(data: 스냅샷)은
  // 외부 script를 못 붙인다. 필요한 건 끌기·확대·핀·선뿐이라 직접 그린다.
  // 타일이 안 오면(오프라인·차단) 회색 바탕 위에 핀과 동선만 그려진다 — 기록은 그대로 보인다.
  //
  // 타일 출처 표기(© OpenStreetMap contributors)는 OSM 이용 조건이라 항상 띄운다.

  var TILE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var SIZE = 256;
  var MIN_Z = 2;
  var MAX_Z = 18;

  function project(lat, lng, z) {
    var w = SIZE * Math.pow(2, z);
    var s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return { x: ((lng + 180) / 360) * w, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * w };
  }
  function unproject(x, y, z) {
    var w = SIZE * Math.pow(2, z);
    var lng = (x / w) * 360 - 180;
    var n = Math.PI - (2 * Math.PI * y) / w;
    var lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat: lat, lng: lng };
  }

  // 점들이 다 들어가는 가장 큰 확대 단계
  function fitZoom(pts, w, h, pad, maxZ) {
    if (!pts.length) return { z: 3, c: { lat: 35, lng: 135 } };
    var lats = pts.map(function (p) { return p.lat; });
    var lngs = pts.map(function (p) { return p.lng; });
    var c = { lat: (Math.min.apply(null, lats) + Math.max.apply(null, lats)) / 2, lng: (Math.min.apply(null, lngs) + Math.max.apply(null, lngs)) / 2 };
    if (pts.length === 1) return { z: Math.min(maxZ, 15), c: c };
    for (var z = maxZ; z > MIN_Z; z--) {
      var a = project(Math.max.apply(null, lats), Math.min.apply(null, lngs), z);
      var b = project(Math.min.apply(null, lats), Math.max.apply(null, lngs), z);
      if (b.x - a.x <= w - pad * 2 && b.y - a.y <= h - pad * 2) {
        var mid = unproject((a.x + b.x) / 2, (a.y + b.y) / 2, z);
        return { z: z, c: mid };
      }
    }
    return { z: MIN_Z, c: c };
  }

  // el: 지도를 그릴 빈 div
  // opts: { points:[{lat,lng,label,id,approx,active}], route:bool, onTap(latlng), onPin(id), maxZoom }
  function create(el, opts) {
    opts = opts || {};
    el.classList.add("tmap");
    el.innerHTML =
      '<div class="tmap__tiles"></div>' +
      '<svg class="tmap__route" aria-hidden="true"></svg>' +
      '<div class="tmap__pins"></div>' +
      '<div class="tmap__zoom"><button type="button" data-z="1" aria-label="확대">+</button><button type="button" data-z="-1" aria-label="축소">−</button></div>' +
      '<a class="tmap__attr" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>';
    var tilesEl = el.querySelector(".tmap__tiles");
    var svg = el.querySelector(".tmap__route");
    var pinsEl = el.querySelector(".tmap__pins");
    var tiles = {};
    var z = 3;
    var center = project(35, 135, z); // 세계 픽셀 좌표
    var points = [];
    var maxZ = opts.maxZoom || 17;

    function size() {
      return { w: el.clientWidth || 300, h: el.clientHeight || 240 };
    }
    function toScreen(p) {
      var s = size();
      var q = project(p.lat, p.lng, z);
      var W = SIZE * Math.pow(2, z);
      var dx = q.x - center.x;
      // 날짜변경선 근처에서 가까운 쪽 사본을 쓴다
      if (dx > W / 2) dx -= W;
      if (dx < -W / 2) dx += W;
      return { x: s.w / 2 + dx, y: s.h / 2 + (q.y - center.y) };
    }

    function render() {
      var s = size();
      var n = Math.pow(2, z);
      var x0 = Math.floor((center.x - s.w / 2) / SIZE);
      var x1 = Math.floor((center.x + s.w / 2) / SIZE);
      var y0 = Math.max(0, Math.floor((center.y - s.h / 2) / SIZE));
      var y1 = Math.min(n - 1, Math.floor((center.y + s.h / 2) / SIZE));
      var seen = {};
      for (var tx = x0; tx <= x1; tx++) {
        for (var ty = y0; ty <= y1; ty++) {
          var wx = ((tx % n) + n) % n;
          var key = z + "/" + tx + "/" + ty;
          seen[key] = true;
          var img = tiles[key];
          if (!img) {
            img = document.createElement("img");
            img.alt = "";
            img.draggable = false;
            img.decoding = "async";
            img.onerror = function () { this.style.visibility = "hidden"; };
            img.src = TILE.replace("{z}", z).replace("{x}", wx).replace("{y}", ty);
            tiles[key] = img;
            tilesEl.appendChild(img);
          }
          img.style.transform = "translate(" + Math.round(tx * SIZE - center.x + s.w / 2) + "px," + Math.round(ty * SIZE - center.y + s.h / 2) + "px)";
        }
      }
      Object.keys(tiles).forEach(function (k) {
        if (!seen[k]) {
          tiles[k].remove();
          delete tiles[k];
        }
      });

      // 동선
      svg.setAttribute("width", s.w);
      svg.setAttribute("height", s.h);
      var line = "";
      if (opts.route && points.length > 1) {
        var d = points.map(function (p, i) {
          var q = toScreen(p);
          return (i ? "L" : "M") + q.x.toFixed(1) + " " + q.y.toFixed(1);
        }).join(" ");
        line = '<path d="' + d + '" class="tmap__line"/>';
      }
      svg.innerHTML = line;

      // 핀
      pinsEl.innerHTML = points.map(function (p, i) {
        var q = toScreen(p);
        if (q.x < -40 || q.y < -40 || q.x > s.w + 40 || q.y > s.h + 40) return "";
        return '<button type="button" class="tmap__pin' + (p.approx ? " is-approx" : "") + (p.active ? " is-active" : "") + '" data-i="' + i + '" style="transform:translate(' + q.x.toFixed(1) + "px," + q.y.toFixed(1) + 'px)" aria-label="' + esc(p.title || p.label || "") + '"><span>' + esc(p.label == null ? i + 1 : p.label) + "</span></button>";
      }).join("");
    }

    function esc(s) {
      return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
    }

    function setZoom(nz, sx, sy) {
      nz = Math.max(MIN_Z, Math.min(MAX_Z, nz));
      if (nz === z) return;
      var s = size();
      if (sx == null) { sx = s.w / 2; sy = s.h / 2; }
      // 화면의 (sx,sy) 지점이 확대 후에도 그 자리에 있게
      var wx = center.x + (sx - s.w / 2);
      var wy = center.y + (sy - s.h / 2);
      var k = Math.pow(2, nz - z);
      center = { x: wx * k - (sx - s.w / 2), y: wy * k - (sy - s.h / 2) };
      z = nz;
      render();
    }

    // ---- 끌기·탭·두 손가락 확대
    var ptrs = {};
    var drag = null;
    var pinch = null;
    el.addEventListener("pointerdown", function (ev) {
      if (ev.target.closest(".tmap__zoom, .tmap__attr")) return;
      ptrs[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      try { el.setPointerCapture(ev.pointerId); } catch (e) {}
      var ids = Object.keys(ptrs);
      if (ids.length === 1) drag = { x: ev.clientX, y: ev.clientY, cx: center.x, cy: center.y, moved: false, target: ev.target };
      if (ids.length === 2) {
        var a = ptrs[ids[0]], b = ptrs[ids[1]];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
        drag = null;
      }
    });
    el.addEventListener("pointermove", function (ev) {
      if (!ptrs[ev.pointerId]) return;
      ptrs[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      if (pinch) {
        var ids = Object.keys(ptrs);
        if (ids.length < 2) return;
        var a = ptrs[ids[0]], b = ptrs[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        var r = el.getBoundingClientRect();
        if (d / pinch.d > 1.6) { setZoom(z + 1, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); pinch.d = d; }
        else if (d / pinch.d < 0.62) { setZoom(z - 1, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); pinch.d = d; }
        return;
      }
      if (!drag) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
      if (!drag.moved) return;
      center = { x: drag.cx - dx, y: drag.cy - dy };
      render();
    });
    function end(ev) {
      if (!ptrs[ev.pointerId]) return;
      delete ptrs[ev.pointerId];
      if (Object.keys(ptrs).length < 2) pinch = null;
      if (drag && !drag.moved && ev.type === "pointerup") {
        var pin = drag.target.closest && drag.target.closest(".tmap__pin");
        if (pin && opts.onPin) opts.onPin(points[Number(pin.getAttribute("data-i"))]);
        else if (opts.onTap) {
          var r = el.getBoundingClientRect();
          var s = size();
          opts.onTap(unproject(center.x + (ev.clientX - r.left - s.w / 2), center.y + (ev.clientY - r.top - s.h / 2), z));
        }
      }
      drag = null;
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var r = el.getBoundingClientRect();
      setZoom(z + (ev.deltaY < 0 ? 1 : -1), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });
    el.addEventListener("dblclick", function (ev) {
      var r = el.getBoundingClientRect();
      setZoom(z + 1, ev.clientX - r.left, ev.clientY - r.top);
    });
    el.querySelector(".tmap__zoom").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-z]");
      if (b) setZoom(z + Number(b.getAttribute("data-z")));
    });
    if (global.ResizeObserver) new ResizeObserver(function () { render(); }).observe(el);

    var api = {
      setPoints: function (pts, fit) {
        points = (pts || []).filter(function (p) { return isFinite(p.lat) && isFinite(p.lng) && p.lat !== null; });
        if (fit !== false) api.fit();
        else render();
      },
      fit: function (pts) {
        var s = size();
        var f = fitZoom(pts || points, s.w, s.h, 36, maxZ);
        z = f.z;
        center = project(f.c.lat, f.c.lng, z);
        render();
      },
      center: function (lat, lng, nz) {
        if (nz) z = Math.max(MIN_Z, Math.min(MAX_Z, nz));
        center = project(lat, lng, z);
        render();
      },
      zoom: function () { return z; },
    };
    api.setPoints(opts.points || []);
    return api;
  }

  global.TinyMap = { create: create, project: project, unproject: unproject, fitZoom: fitZoom };
})(this);
