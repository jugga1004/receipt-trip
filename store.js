(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 저장소 — 이 기기의 IndexedDB. 구분키를 만들면 sync.js가 서버(Vercel)와 맞춘다.
  // ---------------------------------------------------------------------
  // 영수증 사진(Blob)까지 들고 있어야 해서 localStorage(5MB, 문자열만)로는 안 된다.
  //
  // IndexedDB를 못 여는 환경(미리보기 창의 data: 스냅샷, 일부 사생활 보호 모드)에서는
  // 메모리 저장소로 떨어진다. 앱은 그대로 돌고, 상단에 "새로고침하면 사라진다"는 경고만 뜬다.
  // 조용히 실패해서 사용자가 입력한 걸 날리는 것보다 낫다.

  var DB_NAME = "receipt-book";
  var DB_VER = 1;
  var STORES = ["books", "entries", "exchanges", "photos"];
  var SETTINGS_KEY = "receipt-book.settings";

  var db = null;
  var mem = null; // 폴백: { storeName: Map }
  var memSettings = null;

  var S = {};

  S.uid = function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  S.isMemory = function () {
    return !!mem;
  };

  function useMemory() {
    mem = {};
    STORES.forEach(function (n) {
      mem[n] = new Map();
    });
  }

  S.init = function () {
    return new Promise(function (resolve) {
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VER);
      } catch (e) {
        useMemory();
        return resolve();
      }
      req.onupgradeneeded = function () {
        var d = req.result;
        STORES.forEach(function (n) {
          if (d.objectStoreNames.contains(n)) return;
          var os = d.createObjectStore(n, { keyPath: "id" });
          if (n === "entries" || n === "exchanges") os.createIndex("bookId", "bookId");
        });
      };
      req.onsuccess = function () {
        db = req.result;
        resolve();
      };
      req.onerror = req.onblocked = function () {
        useMemory();
        resolve();
      };
    });
  };

  function tx(store, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(store, mode);
      var os = t.objectStore(store);
      var out = fn(os);
      t.oncomplete = function () {
        resolve(out && "result" in out ? out.result : undefined);
      };
      t.onerror = t.onabort = function () {
        reject(t.error || new Error("저장소 오류"));
      };
    });
  }

  function clone(v) {
    // 메모리 모드에서도 IndexedDB처럼 "저장 = 복사" 의미를 지킨다.
    // Blob은 structuredClone이 그대로 통과시킨다.
    return v == null ? v : structuredClone(v);
  }

  S.get = function (store, id) {
    if (mem) return Promise.resolve(clone(mem[store].get(id)));
    return tx(store, "readonly", function (os) {
      return os.get(id);
    });
  };

  S.all = function (store) {
    if (mem) return Promise.resolve(Array.from(mem[store].values()).map(clone));
    return tx(store, "readonly", function (os) {
      return os.getAll();
    });
  };

  S.byBook = function (store, bookId) {
    if (mem) {
      return Promise.resolve(
        Array.from(mem[store].values())
          .filter(function (r) {
            return r.bookId === bookId;
          })
          .map(clone)
      );
    }
    return tx(store, "readonly", function (os) {
      return os.index("bookId").getAll(bookId);
    });
  };

  // 동기화용: 저장할 때마다 수정 시각(updatedAt)을 찍고, 지우면 "지움 표시"(tombstone)를 남긴다.
  // 두 기기에서 따로 고쳐도 기록마다 더 최근 것으로 합칠 수 있게. 동기화가 내려받아 넣을 때는
  // opts.sync = true 로 불러 시각을 덮어쓰지 않고, 변경 알림(onChange)도 보내지 않는다.
  var TOMB_KEY = "receipt-book.tomb";
  S.onChange = null;
  function changed() {
    if (S.onChange) try { S.onChange(); } catch (e) {}
  }
  S.tombs = function () {
    try { return JSON.parse(localStorage.getItem(TOMB_KEY) || "{}"); } catch (e) { return S._memTomb || {}; }
  };
  S.saveTombs = function (t) {
    try { localStorage.setItem(TOMB_KEY, JSON.stringify(t)); } catch (e) { S._memTomb = t; }
  };
  function addTomb(store, id) {
    var t = S.tombs();
    t[store] = t[store] || {};
    t[store][id] = new Date().toISOString();
    S.saveTombs(t);
  }

  S.put = function (store, obj, opts) {
    opts = opts || {};
    if (!obj.id) obj.id = S.uid();
    if (!opts.sync && store !== "photos") obj.updatedAt = new Date().toISOString();
    var done = function () {
      if (!opts.sync) changed();
      return obj;
    };
    if (mem) {
      mem[store].set(obj.id, clone(obj));
      return Promise.resolve(done());
    }
    return tx(store, "readwrite", function (os) {
      os.put(obj);
    }).then(done);
  };

  S.del = function (store, id, opts) {
    opts = opts || {};
    if (!opts.sync && store !== "photos") addTomb(store, id);
    var done = function () {
      if (!opts.sync) changed();
    };
    if (mem) {
      mem[store].delete(id);
      return Promise.resolve(done());
    }
    return tx(store, "readwrite", function (os) {
      os.delete(id);
    }).then(done);
  };

  // 가계부를 지우면 딸린 지출·환전·사진도 같이 지운다. 고아 사진이 용량을 먹지 않게.
  S.deleteBook = function (bookId) {
    return Promise.all([S.byBook("entries", bookId), S.byBook("exchanges", bookId)]).then(function (r) {
      var jobs = [];
      r[0].forEach(function (e) {
        if (e.photoId) jobs.push(S.del("photos", e.photoId));
        jobs.push(S.del("entries", e.id));
      });
      r[1].forEach(function (x) {
        jobs.push(S.del("exchanges", x.id));
      });
      jobs.push(S.del("books", bookId));
      return Promise.all(jobs);
    });
  };

  // ------------------------------------------------------------ 설정(키)
  // API 키는 작은 문자열이라 localStorage. 접근 자체가 막힌 환경이면 메모리.

  var DEFAULTS = { geminiKey: "", geminiModel: "gemini-3.5-flash-lite" };

  S.settings = function () {
    var raw = null;
    try {
      raw = localStorage.getItem(SETTINGS_KEY);
    } catch (e) {
      raw = memSettings;
    }
    var s = {};
    try {
      s = raw ? JSON.parse(raw) : {};
    } catch (e) {
      s = {};
    }
    return Object.assign({}, DEFAULTS, s);
  };

  S.saveSettings = function (patch) {
    var next = JSON.stringify(Object.assign(S.settings(), patch));
    try {
      localStorage.setItem(SETTINGS_KEY, next);
    } catch (e) {
      memSettings = next;
    }
  };

  S.hasKey = function () {
    return !!S.settings().geminiKey;
  };
  // 운영자 중계 서버 주소(config.js). 끝의 / 는 뗀다.
  S.proxyUrl = function () {
    var c = global.APP_CONFIG || {};
    return String(c.proxyUrl || "").replace(/\/+$/, "");
  };
  // 자동 인식을 쓸 수 있나: 내 키가 있거나, 운영자 중계 서버가 설정돼 있거나
  S.canScan = function () {
    return S.hasKey() || !!S.proxyUrl();
  };

  global.Store = S;
})(this);
