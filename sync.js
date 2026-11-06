(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 기기 간 동기화 — 구분키(RT-XXXX-XXXX-XXXX)로 서버(Vercel api/sync.js)와 맞춘다
  // ---------------------------------------------------------------------
  // 로그인 없이, 처음 기기에서 구분키를 만들고 다른 기기에 같은 키를 넣으면 같은 기록을 본다.
  // 합치는 규칙(merge): 기록(여행·영수증·환전)마다 updatedAt이 더 최근인 쪽이 이긴다.
  // 지운 기록은 "지움 표시"(시각)를 남겨, 지운 시각이 기록 수정 시각보다 나중이면 지운다.
  // 사진은 한 번 올리면 바뀌지 않으므로 없는 쪽만 올리고/내려받는다.
  // 구분키 = 비밀번호. 이 기기 localStorage에만 둔다.

  var SY = {};
  var KEY_STORE = "receipt-book.syncKey";
  var LAST_STORE = "receipt-book.syncAt";
  var STORES = ["books", "entries", "exchanges"];
  var ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 0·O·1·I 뺌

  SY.KEY_RE = /^RT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

  // localStorage가 막힌 환경(사생활 보호 모드·미리보기 창)에선 메모리에 둔다 — 새로고침하면 사라짐
  var memLs = {};
  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
      return null;
    } catch (e) {
      if (v === undefined) return k in memLs ? memLs[k] : null;
      if (v === null) delete memLs[k];
      else memLs[k] = v;
      return null;
    }
  }

  SY.newKey = function () {
    var b = new Uint8Array(12);
    crypto.getRandomValues(b);
    var s = Array.prototype.map.call(b, function (x) { return ALPHA[x % ALPHA.length]; }).join("");
    return "RT-" + s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12);
  };
  // 사람이 친 키 정리.
  //  - 자동 키(RT-…): 소문자·하이픈 없이 쳐도 RT-XXXX-XXXX-XXXX로 맞춘다
  //  - 직접 정한 키: 공백을 빼고 영문은 대문자로(휴대폰에서 대소문자 헷갈려도 같은 키)
  // 조건에 안 맞으면 ""(이유는 SY.keyProblem으로)
  SY.cleanKey = function (s) {
    var raw = String(s || "").trim();
    var t = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (/^RT[-\s]?[A-Z0-9]{4}[-\s]?[A-Z0-9]{4}[-\s]?[A-Z0-9]{4}$/i.test(raw) && t.length === 14) {
      var k = "RT-" + t.slice(2, 6) + "-" + t.slice(6, 10) + "-" + t.slice(10, 14);
      if (SY.KEY_RE.test(k)) return k;
    }
    var c = raw.replace(/\s+/g, "").toUpperCase();
    return SY.keyProblem(c) ? "" : c;
  };
  // 직접 정한 키가 왜 안 되는지(괜찮으면 "")
  SY.keyProblem = function (c) {
    if (SY.KEY_RE.test(c)) return "";
    if (c.length < 10) return "10자 이상으로 정해 주세요.";
    if (c.length > 40) return "40자 이하로 정해 주세요.";
    if (/[^A-Z0-9가-힣._-]/.test(c)) return "글자·숫자와 - _ . 만 쓸 수 있습니다.";
    if (!/[A-Z가-힣]/.test(c) || !/[0-9]/.test(c)) return "글자와 숫자를 섞어 주세요.";
    if (new Set(c).size < 4) return "너무 단순합니다. 다른 글자를 더 섞어 주세요.";
    if (/0123456789|1234567890|ABCDEFGH|QWERTY|PASSWORD/.test(c)) return "남이 쉽게 맞힐 수 있는 키입니다. 다른 키로 정해 주세요.";
    return "";
  };
  SY.key = function () { return ls(KEY_STORE) || ""; };
  SY.setKey = function (k) { ls(KEY_STORE, k || null); if (!k) ls(LAST_STORE, null); };
  SY.lastAt = function () { return ls(LAST_STORE) || ""; };
  SY.enabled = function () { return !!SY.key() && !!base(); };

  function base() {
    var c = global.APP_CONFIG || {};
    return String(c.syncUrl || "").replace(/\/+$/, "");
  }

  // ------------------------------------------------------------ 합치기(순수 함수)
  // a, b: { books:[], entries:[], exchanges:[], tomb:{store:{id:시각}} }
  SY.merge = function (a, b) {
    a = a || {};
    b = b || {};
    var out = { tomb: {} };
    STORES.forEach(function (s) {
      var ta = (a.tomb && a.tomb[s]) || {};
      var tb = (b.tomb && b.tomb[s]) || {};
      var tomb = Object.assign({}, ta);
      Object.keys(tb).forEach(function (id) { if (!tomb[id] || tb[id] > tomb[id]) tomb[id] = tb[id]; });
      var byId = {};
      (a[s] || []).concat(b[s] || []).forEach(function (r) {
        if (!r || !r.id) return;
        var cur = byId[r.id];
        if (!cur || String(r.updatedAt || "") > String(cur.updatedAt || "")) byId[r.id] = r;
      });
      out[s] = Object.keys(byId).map(function (id) { return byId[id]; }).filter(function (r) {
        return !(tomb[r.id] && tomb[r.id] >= String(r.updatedAt || ""));
      });
      // 지움 표시는 90일 지나면 버린다(무한히 쌓이지 않게)
      var cut = new Date(Date.now() - 90 * 86400000).toISOString();
      Object.keys(tomb).forEach(function (id) { if (tomb[id] < cut) delete tomb[id]; });
      out.tomb[s] = tomb;
    });
    return out;
  };

  // ------------------------------------------------------------ 서버 호출
  function call(a, body, extra, type) {
    var url = base() + "/sync?a=" + a + (extra || "");
    return fetch(url, {
      method: "POST",
      // 한글 키는 헤더에 그대로 못 실으므로 인코딩(서버가 decodeURIComponent)
      headers: { "Content-Type": type || "application/json", "X-Sync-Key": encodeURIComponent(SY.key()) },
      body: body,
    }).then(function (r) {
      if (a === "photo-get") {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error("사진 받기 실패(" + r.status + ")");
        return r.blob();
      }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "동기화 실패(" + r.status + ")");
        return j;
      });
    }, function () {
      throw new Error("동기화 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.");
    });
  }

  // 그 키로 서버에 기록이 이미 있나(직접 정한 키가 남과 겹치는지 확인용) → true/false
  SY.peek = function (k) {
    return fetch(base() + "/sync?a=pull", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Key": encodeURIComponent(k) },
      body: "{}",
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "확인 실패(" + r.status + ")");
        return !!j.data;
      });
    }, function () {
      throw new Error("동기화 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.");
    });
  };

  function localSnapshot() {
    return Promise.all(STORES.map(function (s) { return Store.all(s); })).then(function (r) {
      var o = { tomb: Store.tombs() };
      STORES.forEach(function (s, i) { o[s] = r[i]; });
      return o;
    });
  }

  function sameRec(x, y) {
    return x && y && String(x.updatedAt || "") === String(y.updatedAt || "");
  }

  // 한 번 맞추기 → { pulled: 내려받아 바뀐 수, pushed: 올렸는지, photosUp, photosDown }
  var running = null;
  var again = false;
  SY.run = function () {
    if (!SY.enabled()) return Promise.resolve(null);
    if (running) { again = true; return running; }
    running = doRun().then(function (r) {
      running = null;
      ls(LAST_STORE, new Date().toISOString());
      if (SY.onDone) SY.onDone(r, null);
      if (again) { again = false; setTimeout(SY.run, 500); }
      return r;
    }, function (err) {
      running = null;
      if (SY.onDone) SY.onDone(null, err);
      throw err;
    });
    return running;
  };

  function doRun() {
    var res = { pulled: 0, pushed: false, photosUp: 0, photosDown: 0 };
    return Promise.all([call("pull", "{}"), localSnapshot()]).then(function (r) {
      var remote = (r[0] && r[0].data) || { books: [], entries: [], exchanges: [], tomb: {}, photos: [] };
      var local = r[1];
      var merged = SY.merge(local, remote);
      var jobs = [];
      // 1) 이 기기에 반영: 새로 생기거나 더 최근인 기록은 넣고, 지워진 기록은 지운다
      STORES.forEach(function (s) {
        var lmap = {};
        local[s].forEach(function (x) { lmap[x.id] = x; });
        var mids = {};
        merged[s].forEach(function (x) {
          mids[x.id] = 1;
          if (!sameRec(lmap[x.id], x)) { res.pulled++; jobs.push(Store.put(s, x, { sync: true })); }
        });
        local[s].forEach(function (x) {
          if (!mids[x.id]) { res.pulled++; jobs.push(Store.del(s, x.id, { sync: true })); }
        });
      });
      Store.saveTombs(merged.tomb);
      return Promise.all(jobs).then(function () {
        // 2) 사진: 필요한 사진 중 서버에 없는 건 올리고, 이 기기에 없는 건 내려받는다
        var need = {};
        merged.entries.forEach(function (e) { if (e.photoId) need[e.photoId] = 1; });
        var remotePhotos = {};
        (remote.photos || []).forEach(function (id) { remotePhotos[id] = 1; });
        var ids = Object.keys(need);
        return ids.reduce(function (p, id) {
          return p.then(function () {
            return Store.get("photos", id).then(function (ph) {
              if (ph && ph.blob && !remotePhotos[id]) {
                return call("photo-put", ph.blob, "&id=" + id, "image/jpeg").then(function () { remotePhotos[id] = 1; res.photosUp++; });
              }
              if (!ph && remotePhotos[id]) {
                return call("photo-get", null, "&id=" + id).then(function (blob) {
                  if (blob) { res.photosDown++; return Store.put("photos", { id: id, blob: blob }, { sync: true }); }
                });
              }
            });
          });
        }, Promise.resolve()).then(function () {
          // 3) 서버에 올리기: 합친 결과가 서버 것과 다를 때만
          var photos = Object.keys(remotePhotos).filter(function (id) { return need[id]; });
          var changedRemote = STORES.some(function (s) {
            var rmap = {};
            (remote[s] || []).forEach(function (x) { rmap[x.id] = x; });
            return merged[s].length !== (remote[s] || []).length || merged[s].some(function (x) { return !sameRec(rmap[x.id], x); });
          }) || photos.length !== (remote.photos || []).length || JSON.stringify(merged.tomb) !== JSON.stringify(remote.tomb || {});
          if (!changedRemote) return res;
          var payload = { v: 1, savedAt: new Date().toISOString(), books: merged.books, entries: merged.entries, exchanges: merged.exchanges, tomb: merged.tomb, photos: photos };
          return call("push", JSON.stringify(payload)).then(function () { res.pushed = true; return res; });
        });
      });
    });
  }

  // 저장할 때마다 바로 보내지 않고 4초 모아서 한 번에(여러 장 자동 정리 때 요청 폭주 방지)
  var timer = null;
  SY.schedule = function () {
    if (!SY.enabled()) return;
    clearTimeout(timer);
    timer = setTimeout(function () { SY.run().catch(function () {}); }, 4000);
  };

  global.Sync = SY;
})(this);
