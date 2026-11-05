(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // 화면 — 해시 라우팅
  //   #/                       여행 목록
  //   #/new                    새 여행
  //   #/book/<id>[/<tab>]      여행 (list | stats | fx | settle | manage)
  //   #/entry/<bookId>/<id|new> 지출 확인·수정
  //   #/settings               설정·백업
  // ---------------------------------------------------------------------

  var CURRENCIES = ["KRW", "JPY", "USD", "EUR", "CNY", "TWD", "HKD", "THB", "VND", "PHP", "SGD", "MYR", "IDR", "GBP", "AUD", "CAD", "CHF", "NZD"];
  var CUR_NAME = {
    KRW: "원", JPY: "엔", USD: "달러", EUR: "유로", CNY: "위안", TWD: "대만달러", HKD: "홍콩달러", THB: "바트", VND: "동",
    PHP: "페소", SGD: "싱가포르달러", MYR: "링깃", IDR: "루피아", GBP: "파운드", AUD: "호주달러", CAD: "캐나다달러", CHF: "프랑", NZD: "뉴질랜드달러",
  };

  var $app = document.getElementById("app");
  var state = {
    book: null,
    entries: [],
    exchanges: [],
    day: "all", // 발자취 탭에서 고른 날짜(YYYY-MM-DD) 또는 "all"
    queue: [], // 아직 처리 안 한 사진 Blob(원본 File)
    draft: null,
    urls: [], // 해제할 objectURL
  };

  // ------------------------------------------------------------ 유틸
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function today() {
    return Stats.ymd(new Date());
  }
  function num(v) {
    var n = parseFloat(String(v == null ? "" : v).replace(/,/g, ""));
    return isFinite(n) ? n : 0;
  }
  function toast(msg, ms) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      t.hidden = true;
    }, ms || 2600);
  }
  function objUrl(blob) {
    var u = URL.createObjectURL(blob);
    state.urls.push(u);
    return u;
  }
  function releaseUrls() {
    state.urls.forEach(function (u) {
      URL.revokeObjectURL(u);
    });
    state.urls = [];
  }
  // 해시를 못 바꾸는 환경(미리보기 창의 data: 스냅샷 등)에서도 화면이 넘어가도록
  // 현재 경로를 따로 들고 있다가 직접 route()를 부른다.
  var curPath = "";
  function go(hash) {
    curPath = hash;
    if (location.hash === hash) return route();
    try {
      location.hash = hash;
    } catch (e) {}
    if (location.hash !== hash) route(); // hashchange가 안 올 환경
  }
  document.addEventListener("click", function (ev) {
    var a = ev.target.closest && ev.target.closest('a[href^="#/"]');
    if (!a || ev.defaultPrevented || ev.metaKey || ev.ctrlKey) return;
    ev.preventDefault();
    go(a.getAttribute("href"));
  });
  function curOptions(list, sel) {
    return list
      .map(function (c) {
        return '<option value="' + c + '"' + (c === sel ? " selected" : "") + ">" + c + " " + (CUR_NAME[c] || "") + "</option>";
      })
      .join("");
  }
  function fmtDateKo(d) {
    if (!d) return "날짜 없음";
    var dt = new Date(d + "T00:00:00");
    return dt.getMonth() + 1 + "월 " + dt.getDate() + "일 (" + "일월화수목금토"[dt.getDay()] + ")";
  }
  function bookCurrencies(book) {
    var l = (book.currencies || []).slice();
    if (l.indexOf("KRW") < 0) l.push("KRW");
    return l;
  }
  function krwFn() {
    return FX.krwFn(state.exchanges);
  }

  // ------------------------------------------------------------ 라우터
  function route() {
    releaseUrls();
    window.scrollTo(0, 0);
    var p = (location.hash || curPath).replace(/^#\/?/, "").split("/");
    if (p[0] === "new") return viewNewBook();
    if (p[0] === "settings") return viewSettings();
    if (p[0] === "book" && p[1]) return loadBook(p[1]).then(function () { viewBook(p[2] || "list"); });
    if (p[0] === "entry" && p[1]) return loadBook(p[1]).then(function () { viewEntry(p[2]); });
    if (p[0] === "edit" && p[1]) return loadBook(p[1]).then(function () { viewNewBook(state.book); });
    return viewHome();
  }

  function loadBook(id) {
    return Promise.all([Store.get("books", id), Store.byBook("entries", id), Store.byBook("exchanges", id)]).then(function (r) {
      if (!r[0]) {
        go("#/");
        throw new Error("없는 여행");
      }
      if (!state.book || state.book.id !== r[0].id) state.day = "all";
      state.book = r[0];
      // 예전 '생활 가계부'로 만든 것도 여행(국내)으로 연다
      if (state.book.type !== "trip") Object.assign(state.book, { type: "trip", currencies: state.book.currencies || [], members: state.book.members || ["나"] });
      state.entries = r[1];
      state.exchanges = r[2];
    });
  }

  // ============================================================ 홈
  function viewHome() {
    Promise.all([Store.all("books"), Store.all("entries"), Store.all("exchanges")]).then(function (r) {
      var books = r[0].sort(function (a, b) {
        return (b.createdAt || "").localeCompare(a.createdAt || "");
      });
      var html = '<section class="hero"><h1>영수증이 여행 일기가 됩니다.</h1><p>여행 중 받은 영수증을 찍어 올리면 날짜·가게·금액을 정리하고, 영수증의 주소로 지도에 핀을 찍어 하루하루 다닌 길을 남깁니다. 해외 영수증은 번역하고, 내가 환전한 환율로 원화를 계산합니다.</p></section>';
      if (!Store.canScan()) {
        html += '<div class="banner">영수증 자동 인식을 쓰려면 <a href="#/settings">설정</a>에서 Gemini API 키를 넣어 주세요. 키 없이도 직접 입력과 지도 핀 찍기는 됩니다.</div>';
      }
      html += '<div class="section-head"><h2>내 여행</h2><a class="btn btn--primary" href="#/new">+ 새 여행</a></div>';
      if (!books.length) {
        html += '<div class="empty"><p>아직 여행 기록이 없습니다.</p><p class="muted">여행을 떠날 때마다 하나씩 만들어 보세요. 국내 여행도 됩니다.</p></div>';
      }
      html += '<div class="cards">';
      books.forEach(function (b) {
        var ents = r[1].filter(function (e) { return e.bookId === b.id; });
        var xs = r[2].filter(function (x) { return x.bookId === b.id; });
        var tt = Stats.total(ents, FX.krwFn(xs));
        var places = ents.filter(function (e) { return Geo.has(e.place); }).length;
        html +=
          '<a class="card card--trip" href="#/book/' + b.id + '">' +
          '<span class="card__tag">' + ((b.currencies || []).length ? "해외" : "국내") + "</span>" +
          '<strong class="card__name">' + esc(b.name) + "</strong>" +
          '<span class="card__meta">' + esc((b.start || "") + (b.end ? " ~ " + b.end : "")) + ((b.currencies || []).length ? " · " + esc(b.currencies.join(", ")) : "") + "</span>" +
          '<span class="card__sum">' + moneyMain(ents, tt.total) + moneyRef(ents, tt.total, " ") + " · 발자취 " + places + "곳" + (tt.missing ? " · 환율 미등록 " + tt.missing + "건" : "") + "</span></a>";
      });
      html += "</div>";
      $app.innerHTML = html;
    });
  }

  // ============================================================ 새 가계부 / 수정
  function viewNewBook(edit) {
    var b = edit || { type: "trip", name: "", dest: "", currencies: [], members: ["나"], start: today(), end: "" };
    var isEdit = !!edit;
    // 쓸 외화는 긴 목록에서 고르지 않는다 — 여행지 글자나 예약 캡처로 자동으로 정하고,
    // 필요하면 태그를 지우거나 하나 더 붙인다. 영수증·환전 기록에 새 통화가 나와도 자동 추가된다.
    var curs = (b.currencies || []).slice();
    var legs = (b.legs || []).slice();
    var touchedCur = isEdit && curs.length > 0; // 직접 만진 외화는 여행지 입력으로 덮어쓰지 않는다
    $app.innerHTML =
      '<a class="back" href="' + (isEdit ? "#/book/" + b.id + "/manage" : "#/") + '">← 돌아가기</a>' +
      "<h1>" + (isEdit ? "여행 정보 수정" : "새 여행") + "</h1>" +
      '<section class="panel"><h2>여행 일정 올리기</h2>' +
      '<p class="hint" style="margin:0 0 10px">항공·기차·버스·배·렌터카·숙소 예약 내역을 올리면 여행지·기간·외화·이름을 채웁니다. 여러 장을 한 번에 올려도 됩니다. 예약 없이 차로 가는 여행은 아래에 직접 입력하세요.</p>' +
      '<button type="button" class="btn btn--primary btn--block" id="legShot">여행 일정 올리기</button>' +
      '<input type="file" id="legFile" accept="image/*" multiple hidden>' +
      '<div id="legBox"></div></section>' +
      '<form id="bookForm" class="form">' +
      '<label class="field"><span>여행 이름</span><input name="name" required maxlength="40" placeholder="예: 11월 오사카 / 제주 2박 3일" value="' + esc(b.name) + '"></label>' +
      '<label class="field"><span>여행지</span><input name="dest" maxlength="60" placeholder="예: 오사카, 방콕, 제주" value="' + esc(b.dest || "") + '"></label>' +
      '<div class="field"><span>쓸 외화 <small class="muted">(여행지에 맞춰 자동)</small></span><div id="curTags" class="curtags"></div></div>' +
      '<div class="row2"><label class="field"><span>출발일</span><input type="date" name="start" value="' + esc(b.start) + '"></label>' +
      '<label class="field"><span>돌아오는 날</span><input type="date" name="end" value="' + esc(b.end) + '"></label></div>' +
      '<label class="field"><span>일행 (쉼표로 구분, 첫 사람이 기본 결제자)</span><input name="members" placeholder="나, 민지, 현우" value="' + esc((b.members || []).join(", ")) + '"></label>' +
      '<p class="hint">혼자 가는 여행이면 "나"만 두세요. 정산 탭이 숨겨집니다.</p>' +
      '<button class="btn btn--primary btn--block" type="submit">' + (isEdit ? "저장" : "만들기") + "</button>" +
      "</form>";

    var form = document.getElementById("bookForm");

    function renderCurs() {
      var box = document.getElementById("curTags");
      var rest = CURRENCIES.filter(function (c) { return c !== "KRW" && curs.indexOf(c) < 0; });
      box.innerHTML =
        (curs.length
          ? curs.map(function (c) {
              return '<span class="curtag">' + c + " " + (CUR_NAME[c] || "") + ' <button type="button" data-rm="' + c + '" aria-label="' + c + ' 빼기">×</button></span>';
            }).join("")
          : '<span class="curtag curtag--none">원화만 (국내 여행)</span>') +
        '<select id="curAdd" aria-label="외화 추가"><option value="">+ 추가</option>' +
        rest.map(function (c) { return '<option value="' + c + '">' + c + " " + (CUR_NAME[c] || "") + "</option>"; }).join("") +
        "</select>";
      box.querySelectorAll("[data-rm]").forEach(function (btn) {
        btn.onclick = function () {
          touchedCur = true;
          curs = curs.filter(function (c) { return c !== btn.getAttribute("data-rm"); });
          renderCurs();
        };
      });
      document.getElementById("curAdd").onchange = function () {
        if (!this.value) return;
        touchedCur = true;
        curs.push(this.value);
        renderCurs();
      };
    }
    renderCurs();

    form.dest.addEventListener("input", function () {
      if (touchedCur) return;
      curs = Scan.currenciesFor(this.value);
      renderCurs();
    });
    form.name.addEventListener("input", function () { delete this.dataset.auto; });

    // ---- 예약 캡처
    var busy = 0;
    var msgs = [];
    function renderLegs() {
      var box = document.getElementById("legBox");
      var html = "";
      if (busy) html += '<div class="banner banner--busy" style="margin-top:12px"><span class="spinner"></span> 예약 정보를 읽고 있습니다… (남은 ' + busy + "장)</div>";
      msgs.forEach(function (m) { html += '<div class="banner banner--warn" style="margin-top:12px">' + esc(m) + "</div>"; });
      if (legs.length) {
        html += '<ul class="legs">' + legs.map(function (f) {
          var when = f.date.slice(5).replace("-", "/") + (f.endDate ? " ~ " + f.endDate.slice(5).replace("-", "/") : "") + (f.time ? " " + f.time : "");
          var where = f.type === "stay" || f.type === "car" ? f.toCity : (f.fromCity || f.from) + " → " + (f.toCity || f.to);
          return '<li><span class="legs__icon">' + (Scan.LEG_ICON[f.type] || "") + "</span><b>" + esc(when) + "</b> " + esc(where) +
            '<small class="muted"> ' + esc([f.name, f.company].filter(Boolean).join(" · ")) + "</small></li>";
        }).join("") + "</ul>" +
          '<p class="hint">아래 칸을 채웠습니다. 날짜가 맞는지 한 번 확인하세요.</p>';
      }
      box.innerHTML = html;
    }
    renderLegs();
    function applyLegs() {
      var trip = Scan.tripFromLegs(legs);
      if (!trip) return;
      if (!form.name.value.trim() || form.name.dataset.auto) {
        form.name.value = trip.name;
        form.name.dataset.auto = "1";
      }
      if (trip.dest) form.dest.value = trip.dest;
      form.start.value = trip.start;
      form.end.value = trip.end;
      if (!touchedCur) {
        curs = trip.currencies.length ? trip.currencies.slice() : Scan.currenciesFor(trip.dest);
        renderCurs();
      }
    }
    document.getElementById("legShot").onclick = function () {
      if (!Store.canScan()) return toast("설정에서 Gemini API 키를 먼저 넣어 주세요.", 4000);
      document.getElementById("legFile").click();
    };
    document.getElementById("legFile").onchange = function (ev) {
      var files = Array.prototype.slice.call(ev.target.files || []);
      ev.target.value = "";
      if (!files.length) return;
      busy = files.length;
      msgs = [];
      renderLegs();
      files.reduce(function (p, f, i) {
        return p.then(function () {
          var tag = files.length > 1 ? i + 1 + "번째 사진: " : "";
          return Scan.compress(f)
            .then(Scan.recognizeLegs)
            .then(function (r) {
              if (!r.legs.length) msgs.push(tag + "예약 정보를 찾지 못했습니다." + (r.note ? " (" + r.note + ")" : ""));
              else if (r.note) msgs.push("AI 메모: " + r.note);
              legs = Scan.mergeLegs(legs, r.legs);
              applyLegs();
            })
            .catch(function (err) { msgs.push(tag + err.message); })
            .then(function () {
              busy--;
              renderLegs();
            });
        });
      }, Promise.resolve());
    };

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var fd = new FormData(form);
      var nb = Object.assign({}, b, {
        type: "trip",
        name: String(fd.get("name") || "").trim(),
        dest: String(fd.get("dest") || "").trim(),
        createdAt: b.createdAt || new Date().toISOString(),
      });
      nb.start = fd.get("start") || "";
      nb.end = fd.get("end") || "";
      // 여행지만 적고 외화를 안 만졌는데 자동 판정도 비었으면 그대로 국내(원화만)
      nb.currencies = curs.slice();
      nb.legs = legs;
      nb.members = String(fd.get("members") || "")
        .split(/[,，]/)
        .map(function (s) { return s.trim(); })
        .filter(Boolean)
        .filter(function (m, i, a) { return a.indexOf(m) === i; });
      if (!nb.members.length) nb.members = ["나"];
      if (nb.end && nb.start && nb.end < nb.start) return toast("돌아오는 날이 출발일보다 앞섭니다.");
      Store.put("books", nb).then(function (saved) {
        go("#/book/" + saved.id);
      });
    });
  }

  // ============================================================ 가계부
  function tabsFor(book) {
    var t = [["list", "발자취"], ["stats", "경비"]];
    if ((book.currencies || []).length || state.exchanges.length) t.push(["fx", "환전"]);
    if ((book.members || []).length > 1) t.push(["settle", "정산"]);
    t.push(["manage", "관리"]);
    return t;
  }

  function viewBook(tab) {
    var b = state.book;
    var tabs = tabsFor(b);
    if (!tabs.some(function (t) { return t[0] === tab; })) tab = "list";
    var html =
      '<a class="back" href="#/">← 여행 목록</a>' +
      '<div class="book-head"><span class="card__tag">' + ((b.currencies || []).length ? "해외" : "국내") + "</span><h1>" + esc(b.name) + "</h1>" +
      (b.start ? '<span class="muted">' + esc(b.start + (b.end ? " ~ " + b.end : "")) + (b.dest ? " · " + esc(b.dest) : "") + "</span>" : "") +
      ((b.legs || []).length
        ? '<ul class="legs legs--head">' + b.legs.map(function (f) {
            var where = f.type === "stay" || f.type === "car" ? f.toCity : (f.fromCity || f.from) + "→" + (f.toCity || f.to);
            return "<li>" + (Scan.LEG_ICON[f.type] || "") + " " + esc(f.date.slice(5).replace("-", "/") + (f.time ? " " + f.time : "") + " " + where) + "</li>";
          }).join("") + "</ul>"
        : "") + "</div>" +
      '<nav class="tabs">' +
      tabs.map(function (t) {
        return '<a class="tab' + (t[0] === tab ? " is-active" : "") + '" href="#/book/' + b.id + "/" + t[0] + '">' + t[1] + "</a>";
      }).join("") +
      "</nav>";

    html += '<div id="tabBody">' + ({ list: tabList, stats: tabStats, fx: tabFx, settle: tabSettle, manage: tabManage }[tab])() + "</div>";

    if (tab === "list") {
      html +=
        '<div class="fab">' +
        '<button type="button" class="btn btn--ghost" id="addManual">직접 입력</button>' +
        '<button type="button" class="btn btn--ghost" id="addAlbum">앨범에서 (여러 장)</button>' +
        '<button type="button" class="btn btn--primary btn--big" id="addCamera">영수증 찍기</button>' +
        "</div>";
    }
    $app.innerHTML = html;
    wireBook(tab);
  }

  function warnRates() {
    var r = FX.rates(state.exchanges);
    var missing = (state.book.currencies || []).filter(function (c) { return !r[c]; });
    var used = {};
    state.entries.forEach(function (e) {
      if (e.currency !== "KRW" && FX.krw(e, r) == null) used[e.currency] = true;
    });
    var miss = Object.keys(used);
    if (!miss.length && !missing.length) return "";
    if (!miss.length) {
      return '<div class="banner">아직 환전 기록이 없는 통화: <b>' + missing.join(", ") + '</b> — <a href="#/book/' + state.book.id + '/fx">환전 탭</a>에서 등록하면 원화로 환산됩니다.</div>';
    }
    return '<div class="banner banner--warn"><b>' + miss.join(", ") + "</b> 환전 기록이 없어 일부 지출이 원화 합계에서 빠졌습니다. " +
      '<a href="#/book/' + state.book.id + '/fx">환전 등록하기</a></div>';
  }

  // ------------------------------------------------------------ 발자취(지도 + 날짜별 일정)
  // 영수증을 시간순으로 놓고, 위치가 있는 건 지도에 번호 핀으로 찍어 선으로 잇는다.
  // "전체"에선 핀 번호 = N일차, 하루를 고르면 핀 번호 = 그날 몇 번째 들른 곳.
  function dayLabel(d) {
    if (!d.date) return "날짜 없음";
    return (d.no > 0 ? d.no + "일차 · " : d.no <= 0 && state.book.start ? "출발 전 · " : "") + fmtDateKo(d.date);
  }
  function placeName(e) {
    return e.merchantKo || e.merchant || (e.place && e.place.label) || "(이름 없음)";
  }
  // 요약 칸의 원화 총액 아래에 붙는 통화별 합계 한 줄
  // 금액 표시: 현지 통화를 크게(메인), 원화 환산은 아래 참고용. 원화만 쓴 곳이면 원화가 메인.
  //   moneyMain → "4,870 JPY + 원화 9,500원" 또는 "53,817원"
  //   moneyRef  → "≈ 53,817원" (현지 통화가 있을 때만)
  function moneyMain(ents, krwTotal) {
    var line = Stats.currencyLine(ents);
    return line ? esc(line) : FX.won(krwTotal);
  }
  function moneyRef(ents, krwTotal, sep) {
    if (!Stats.currencyLine(ents)) return "";
    return (sep || "") + '<small class="money__ref">≈ ' + FX.won(krwTotal) + "</small>";
  }
  function needsLocate(e) {
    var p = e.place || {};
    return !Geo.has(p) && !!(p.query || p.address || p.city);
  }

  function tabList() {
    var b = state.book;
    var f = krwFn();
    var days = Geo.days(state.entries, b.start);
    if (state.day !== "all" && !days.some(function (d) { return d.date === state.day; })) state.day = "all";
    var shown = state.day === "all" ? days : days.filter(function (d) { return d.date === state.day; });
    var ents = [];
    shown.forEach(function (d) { ents = ents.concat(d.entries); });
    var t = Stats.total(ents, f);
    var located = ents.filter(function (e) { return Geo.has(e.place); });
    var km = state.day === "all" ? Geo.pathKm(located.map(function (e) { return e.place; })) : shown[0] ? shown[0].km : 0;

    var html = '<div id="batchBox"></div>' + warnRates();
    var review = state.entries.filter(function (e) { return e.needsReview; }).length;
    if (review && !(state.batch && state.batch.busy && state.batch.bookId === b.id)) {
      html += '<div class="banner">자동으로 정리한 기록 ' + review + "건이 있습니다. <b>확인 필요</b> 표시를 눌러 날짜·금액을 사진과 한 번 비교해 주세요.</div>";
    }
    html += '<div class="summary"><div><small>' + (state.day === "all" ? "총 지출" : "이날 지출") + "</small><strong>" + moneyMain(ents, t.total) + "</strong>" + moneyRef(ents, t.total) + "</div>" +
      "<div><small>발자취</small><strong>" + located.length + "곳</strong></div>" +
      "<div><small>이동(직선)</small><strong>" + (km >= 10 ? Math.round(km) : km.toFixed(1)) + "km</strong></div></div>";

    if (!state.entries.length) {
      return html + '<div class="empty"><p>영수증을 찍어 첫 발자취를 남겨 보세요.</p><p class="muted">영수증에 적힌 가게 주소로 지도에 핀이 찍힙니다. 여러 장은 "앨범에서"로 한 번에 올리세요.</p></div>';
    }

    if (days.length > 1) {
      html += '<div class="daychips" role="tablist">' +
        '<button type="button" class="daychip' + (state.day === "all" ? " is-active" : "") + '" data-day="all">전체</button>' +
        days.map(function (d) {
          return '<button type="button" class="daychip' + (state.day === d.date ? " is-active" : "") + '" data-day="' + esc(d.date) + '">' +
            (d.no > 0 ? d.no + "일차" : d.date ? fmtDateKo(d.date).replace(/ \(.\)$/, "") : "날짜 없음") + "</button>";
        }).join("") + "</div>";
    }

    if (located.length) {
      html += '<div class="mapwrap"><div id="footMap" class="footmap"></div><div id="pinCard" class="pincard" hidden></div></div>';
    } else {
      html += '<div class="mapempty">아직 지도에 찍힌 곳이 없습니다. 영수증에 주소가 있으면 자동으로 찍히고, 기록을 열어 직접 지정할 수도 있습니다.</div>';
    }
    var lost = ents.filter(needsLocate).length;
    if (lost) {
      html += '<div class="banner">주소는 있는데 위치를 못 찾은 기록 ' + lost + '건 <button type="button" class="btn btn--ghost btn--sm" id="relocate">다시 찾기</button></div>';
    }

    html += '<div class="days">';
    shown.forEach(function (d) {
      var dt = Stats.total(d.entries, f);
      html += '<section class="day"><h3><span>' + esc(dayLabel(d)) + "</span><span>" + moneyMain(d.entries, dt.total) + moneyRef(d.entries, dt.total, " ") +
        (d.located > 1 ? ' <small class="muted">· ' + (d.km >= 10 ? Math.round(d.km) : d.km.toFixed(1)) + "km</small>" : "") + "</span></h3><ol class=\"trail\">";
      var seq = 0;
      d.entries.forEach(function (e) {
        var krw = f(e);
        var foreign = e.currency && e.currency !== "KRW";
        var has = Geo.has(e.place);
        if (has) seq++;
        var pinNo = state.day === "all" ? d.no > 0 ? d.no : "·" : seq;
        var where = has ? e.place.label || e.place.address || "" : (e.place && (e.place.address || e.place.city)) || "";
        html +=
          '<li id="ent-' + e.id + '"><a class="entry' + (has ? "" : " is-unplaced") + '" href="#/entry/' + b.id + "/" + e.id + '">' +
          '<span class="trail__dot">' + (has ? esc(pinNo) : "?") + "</span>" +
          '<span class="entry__main"><b>' + esc(placeName(e)) + "</b>" + (e.needsReview ? ' <span class="tag tag--warn">확인 필요</span>' : "") +
          '<small class="entry__items">' + (e.time ? esc(e.time) + " · " : "") + esc(e.category || "기타") + (where ? " · " + esc(where) : "") +
          (has ? (Geo.isApprox(e.place) ? ' <span class="tag">대략</span>' : "") : ' <span class="tag tag--warn">위치 없음</span>') + "</small></span>" +
          '<span class="entry__amt">' +
          (foreign ? "<b>" + FX.fmt(e.total, e.currency) + "</b><small>" + (krw == null ? "환율 미등록" : "≈ " + FX.won(krw)) + "</small>" : "<b>" + FX.won(e.total) + "</b>") +
          ((b.members || []).length > 1 ? '<small class="muted">' + esc(e.payer || b.members[0]) + " 결제</small>" : "") +
          "</span></a></li>";
      });
      html += "</ol></section>";
    });
    return html + "</div>";
  }

  // 지도에 핀 찍기 — tabList()가 그린 뒤 wireBook에서 부른다
  function drawFootMap() {
    var el = document.getElementById("footMap");
    if (!el) return;
    var b = state.book;
    var days = Geo.days(state.entries, b.start);
    var shown = state.day === "all" ? days : days.filter(function (d) { return d.date === state.day; });
    var pts = [];
    shown.forEach(function (d) {
      var seq = 0;
      d.entries.forEach(function (e) {
        if (!Geo.has(e.place)) return;
        seq++;
        pts.push({
          lat: e.place.lat, lng: e.place.lng, id: e.id,
          label: state.day === "all" ? (d.no > 0 ? d.no : "·") : seq,
          title: placeName(e), approx: Geo.isApprox(e.place),
        });
      });
    });
    var card = document.getElementById("pinCard");
    var map = TinyMap.create(el, {
      points: pts,
      route: true,
      onPin: function (p) {
        var e = state.entries.filter(function (x) { return x.id === p.id; })[0];
        if (!e) return;
        pts.forEach(function (q) { q.active = q.id === p.id; });
        map.setPoints(pts, false);
        var f = krwFn();
        var k = f(e);
        card.hidden = false;
        card.innerHTML = '<a href="#/entry/' + b.id + "/" + e.id + '"><b>' + esc(placeName(e)) + "</b>" +
          '<small class="muted">' + esc(fmtDateKo(e.date)) + (e.time ? " " + esc(e.time) : "") + " · " + esc((e.place && e.place.label) || "") + "</small>" +
          "<span>" + (e.currency !== "KRW" ? FX.fmt(e.total, e.currency) + (k != null ? " ≈ " + FX.won(k) : "") : FX.won(e.total)) + " ›</span></a>";
        var li = document.getElementById("ent-" + e.id);
        $app.querySelectorAll(".trail li.is-hit").forEach(function (x) { x.classList.remove("is-hit"); });
        if (li) li.classList.add("is-hit");
      },
    });
  }

  // 주소는 있는데 좌표가 없는 기록을 다시 지오코딩(1.1초 간격)
  function relocateAll() {
    var list = state.entries.filter(needsLocate);
    var btn = document.getElementById("relocate");
    if (btn) btn.disabled = true;
    var found = 0;
    list.reduce(function (p, e, i) {
      return p.then(function () {
        toast("위치 찾는 중… " + (i + 1) + "/" + list.length, 3000);
        return Geo.locate(e, null).then(function (place) {
          if (!Geo.has(place)) return;
          found++;
          e.place = place;
          return Store.put("entries", e);
        });
      });
    }, Promise.resolve()).then(function () {
      toast(found ? found + "곳을 찾았습니다." : "찾지 못했습니다. 기록을 열어 직접 지정해 주세요.", 4000);
      route();
    });
  }

  // ------------------------------------------------------------ 통계
  function tabStats() {
    var b = state.book;
    var f = krwFn();
    var ents = state.entries;
    var t = Stats.total(ents, f);
    var html = warnRates();
    var sm = Stats.summary(b, ents, state.exchanges, f);
    lastSummaryText = Stats.summaryText(b, sm);
    html += '<section class="panel costsum"><h2>여행 경비 정리</h2>' +
      '<div class="costsum__total"><small>총 경비</small><strong>' + (sm.currencyLine ? esc(sm.currencyLine) : FX.won(sm.total)) + "</strong>" +
      (sm.currencyLine ? '<span class="costsum__cur">≈ ' + FX.won(sm.total) + " (원화 환산)</span>" : "") +
      '<span class="muted">' + sm.count + "건" + (sm.days ? " · " + sm.days + "일" : "") + "</span></div>" +
      '<div class="summary costsum__kpi">' +
      (sm.days ? "<div><small>하루 평균</small><strong>" + FX.won(sm.perDay) + "</strong></div>" : "") +
      (sm.members > 1 ? "<div><small>1인당(" + sm.members + "명)</small><strong>" + FX.won(sm.perHead) + "</strong></div>" : "") +
      "<div><small>카드</small><strong>" + FX.won(sm.pay.card) + "</strong></div>" +
      "<div><small>현금" + (sm.pay.unknown ? "·모름" : "") + "</small><strong>" + FX.won(sm.pay.cash + sm.pay.unknown) + "</strong></div>" +
      "</div>";
    if (sm.fx.length) {
      html += '<ul class="kv">' + sm.fx.map(function (x) {
        return "<li><span>" + x.currency + " 환전 " + FX.fmt(x.exchanged, x.currency) + " (" + FX.won(x.krwPaid) + ")</span><b>남은 현금 " + FX.fmt(x.left, x.currency) +
          (x.leftKrw != null ? ' <small class="muted">≈ ' + FX.won(x.leftKrw) + "</small>" : "") + "</b></li>";
      }).join("") + "</ul>";
    }
    if (sm.perPerson) {
      html += '<h3 class="sub">사람별 부담</h3><ul class="kv">' + sm.perPerson.map(function (p) {
        return "<li><span>" + esc(p.name) + ' <small class="muted">낸 돈 ' + FX.won(p.paid) + "</small></span><b>" + FX.won(p.owed) + "</b></li>";
      }).join("") + "</ul>";
    }
    if (sm.biggest) html += '<p class="hint">가장 큰 지출: ' + esc(sm.biggest.name) + " " + FX.won(sm.biggest.krw) + "</p>";
    html += '<button type="button" class="btn btn--primary btn--block" id="copySummary">경비 정리 복사 (메신저에 붙여 넣기)</button></section>';

    var cat = Stats.ranked(ents, function (e) { return e.category; }, f);
    html += '<section class="panel"><h2>카테고리별</h2>' + Stats.rankBars(cat, t.total) + "</section>";
    html += '<section class="panel"><h2>일별 지출</h2>' + Stats.dayBars(Stats.byDay(ents, f, b.start || null, b.end || null)) + "</section>";

    var cities = Stats.ranked(ents.filter(function (e) { return e.place && e.place.city; }), function (e) { return e.place.city; }, f, 5);
    if (cities.length > 1) html += '<section class="panel"><h2>도시별</h2>' + Stats.rankBars(cities, t.total) + "</section>";

    var shops = Stats.ranked(ents, function (e) { return e.merchantKo || e.merchant; }, f, 5);
    html += '<section class="panel"><h2>많이 쓴 곳 TOP 5</h2>' + Stats.rankBars(shops, t.total) + "</section>";

    var bc = Stats.byCurrency(ents);
    if (Object.keys(bc).length > 1 || !bc.KRW) {
      html += '<section class="panel"><h2>통화별 지출(원문)</h2><ul class="kv">' +
        Object.keys(bc).map(function (c) { return "<li><span>" + c + "</span><b>" + FX.fmt(bc[c], c) + "</b></li>"; }).join("") +
        "</ul></section>";
    }
    if (t.missing) html += '<p class="hint">환율 미등록 ' + t.missing + "건은 위 합계·차트에서 빠져 있습니다.</p>";
    return html;
  }

  // ------------------------------------------------------------ 환전
  function tabFx() {
    var b = state.book;
    var rates = FX.rates(state.exchanges);
    var left = FX.cashLeft(state.exchanges, state.entries);
    var html = '<section class="panel"><h2>적용 환율 <small class="muted">(환전 기록 가중평균)</small></h2><ul class="kv">';
    (b.currencies || []).forEach(function (c) {
      var r = rates[c];
      html += "<li><span>" + c + " " + CUR_NAME[c] + "</span><b>" + FX.fmtRate(r ? r.rate : null, c) + "</b></li>";
    });
    html += "</ul>";
    var lk = Object.keys(left);
    if (lk.length) {
      html += '<h3 class="sub">남은 현금 추정</h3><ul class="kv">' +
        lk.map(function (c) {
          var l = left[c];
          return "<li><span>" + c + " · 환전 " + FX.fmt(l.exchanged, c) + " − 현금지출 " + FX.fmt(l.spent, c) + "</span><b" + (l.left < 0 ? ' class="neg"' : "") + ">" + FX.fmt(l.left, c) + "</b></li>";
        }).join("") +
        '</ul><p class="hint">카드 결제는 빼고, 결제수단을 모르는 건은 현금으로 계산합니다. 음수면 현금 지출 중 일부가 실제론 카드였거나 환전 기록이 빠진 것입니다.</p>';
    }
    html += "</section>";

    html +=
      '<section class="panel"><h2>환전 내역 올리기</h2>' +
      '<p class="hint" style="margin:0 0 10px">은행 앱 환전 완료 화면, 트래블카드 충전 내역, 환전 영수증을 올리면 자동으로 채웁니다. 한 장에 여러 건이 있어도 됩니다.</p>' +
      '<button type="button" class="btn btn--primary btn--block" id="fxShot">환전 내역 올리기</button>' +
      '<div id="fxReview"></div></section>';

    html +=
      '<section class="panel"><h2>직접 추가</h2><form id="fxForm" class="form">' +
      '<div class="row2"><label class="field"><span>통화</span><select name="currency">' + curOptions(b.currencies || [], (b.currencies || [])[0]) + "</select></label>" +
      '<label class="field"><span>날짜</span><input type="date" name="date" value="' + today() + '"></label></div>' +
      '<div class="row2"><label class="field"><span>받은 외화</span><input name="foreign" inputmode="decimal" placeholder="30000" required></label>' +
      '<label class="field"><span>낸 원화</span><input name="krw" inputmode="numeric" placeholder="273000" required></label></div>' +
      '<p class="hint" id="fxPreview">수수료·우대율이 반영된 실제 금액을 넣으세요. 트래블카드 충전도 여기에 넣으면 됩니다.</p>' +
      '<label class="field"><span>메모</span><input name="memo" placeholder="예: 공항 환전소, 트래블월렛 충전"></label>' +
      '<button class="btn btn--primary btn--block">추가</button></form></section>';

    var xs = state.exchanges.slice().sort(function (a, c) { return (c.date || "").localeCompare(a.date || ""); });
    if (xs.length) {
      html += '<section class="panel"><h2>환전 내역</h2><ul class="xlist">' +
        xs.map(function (x) {
          return '<li><span><b>' + FX.fmt(x.foreignAmount, x.currency) + "</b> ← " + FX.won(x.krwAmount) +
            '<small class="muted">' + esc(x.date || "") + " · " + FX.fmtRate(x.krwAmount / x.foreignAmount, x.currency) + (x.memo ? " · " + esc(x.memo) : "") + "</small></span>" +
            '<button type="button" class="btn btn--ghost btn--sm" data-delx="' + x.id + '">삭제</button></li>';
        }).join("") +
        "</ul></section>";
    }
    return html;
  }

  // ------------------------------------------------------------ 정산
  var lastSettleText = "";
  var lastSummaryText = "";
  function tabSettle() {
    var b = state.book;
    var res = Settle.compute(state.entries, b.members, krwFn());
    lastSettleText = Settle.toText(b.name, res);
    var html = warnRates();
    html += '<section class="panel"><h2>사람별</h2><table class="tbl"><thead><tr><th>이름</th><th>낸 돈</th><th>부담</th><th>차액</th></tr></thead><tbody>' +
      res.people.map(function (p) {
        return "<tr><td>" + esc(p.name) + "</td><td>" + FX.won(p.paid) + "</td><td>" + FX.won(p.owed) + '</td><td class="' + (p.net < 0 ? "neg" : p.net > 0 ? "pos" : "") + '">' + (p.net > 0 ? "+" : "") + FX.won(p.net) + "</td></tr>";
      }).join("") +
      "</tbody></table></section>";
    html += '<section class="panel"><h2>이렇게 보내면 끝</h2>';
    if (!res.transfers.length) html += '<p class="muted">보낼 돈이 없습니다.</p>';
    else {
      html += '<ul class="transfers">' +
        res.transfers.map(function (t) {
          return "<li><b>" + esc(t.from) + "</b> → <b>" + esc(t.to) + "</b><span>" + FX.won(t.amount) + "</span></li>";
        }).join("") + "</ul>";
    }
    html += '<button type="button" class="btn btn--ghost btn--block" id="copySettle">정산 내용 복사</button>';
    html += '<p class="hint">각 지출의 결제자·분담자는 지출 수정 화면에서 바꿀 수 있습니다. 분담자를 안 고르면 일행 전원이 똑같이 나눕니다.' +
      (res.skipped ? " 환율 미등록 " + res.skipped + "건은 빠졌습니다." : "") + "</p></section>";
    return html;
  }

  // ------------------------------------------------------------ 관리
  function tabManage() {
    var b = state.book;
    return '<section class="panel"><h2>내보내기</h2>' +
      '<button type="button" class="btn btn--ghost btn--block" id="csvAll">CSV(엑셀) 내보내기 — 전체 ' + state.entries.length + "건</button>" +
      '<p class="hint">주소·위도·경도도 함께 들어갑니다. 사진까지 포함한 전체 백업은 <a href="#/settings">설정</a>에서 할 수 있습니다.</p></section>' +
      '<section class="panel"><h2>여행 설정</h2>' +
      '<a class="btn btn--ghost btn--block" href="#/edit/' + b.id + '">이름·기간·통화·일행 수정</a>' +
      '<button type="button" class="btn btn--danger btn--block" id="delBook">이 여행 삭제</button></section>';
  }

  function wireBook(tab) {
    var b = state.book;
    if (tab === "list") {
      $app.querySelectorAll("[data-day]").forEach(function (btn) {
        btn.onclick = function () {
          state.day = btn.getAttribute("data-day");
          viewBook("list");
        };
      });
      drawFootMap();
      renderBatch();
      var rl = document.getElementById("relocate");
      if (rl) rl.onclick = relocateAll;
    }
    if (tab === "list") {
      document.getElementById("addCamera").onclick = function () { document.getElementById("fileCamera").click(); };
      document.getElementById("addAlbum").onclick = function () { document.getElementById("fileAlbum").click(); };
      document.getElementById("addManual").onclick = function () {
        state.queue = [];
        state.draft = null;
        go("#/entry/" + b.id + "/new");
      };
    }
    if (tab === "stats") {
      Stats.wireTips($app);
      document.getElementById("copySummary").onclick = function () { copyText(lastSummaryText); };
    }
    if (tab === "fx") {
      var form = document.getElementById("fxForm");
      var prev = document.getElementById("fxPreview");
      form.addEventListener("input", function () {
        var fo = num(form.foreign.value);
        var kr = num(form.krw.value);
        if (fo > 0 && kr > 0) prev.textContent = "이번 환전 환율: " + FX.fmtRate(kr / fo, form.currency.value);
      });
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var x = { bookId: b.id, currency: form.currency.value, date: form.date.value, foreignAmount: num(form.foreign.value), krwAmount: num(form.krw.value), memo: form.memo.value.trim() };
        if (!(x.foreignAmount > 0) || !(x.krwAmount > 0)) return toast("외화와 원화 금액을 모두 넣어 주세요.");
        Store.put("exchanges", x).then(function () {
          toast("환전 기록을 추가했습니다.");
          route();
        });
      });
      document.getElementById("fxShot").onclick = function () {
        if (!Store.canScan()) return toast("설정에서 Gemini API 키를 먼저 넣어 주세요.", 4000);
        document.getElementById("fileFx").click();
      };
      renderFxReview();
      $app.querySelectorAll("[data-delx]").forEach(function (btn) {
        btn.onclick = function () {
          if (!confirm("이 환전 기록을 지울까요? 원화 환산이 다시 계산됩니다.")) return;
          Store.del("exchanges", btn.getAttribute("data-delx")).then(route);
        };
      });
    }
    if (tab === "settle") {
      document.getElementById("copySettle").onclick = function () {
        copyText(lastSettleText);
      };
    }
    if (tab === "manage") {
      var exp = function (ents, suffix) {
        var r = FX.rates(state.exchanges);
        var csv = CSVX.entriesCsv(b, ents, function (e) { return FX.krw(e, r); }, function (e) { return FX.rateOf(e, r); });
        CSVX.download(CSVX.safeName(b.name) + suffix + ".csv", csv);
      };
      document.getElementById("csvAll").onclick = function () { exp(state.entries, ""); };
      document.getElementById("delBook").onclick = function () {
        if (!confirm("'" + b.name + "' 여행과 기록 " + state.entries.length + "건, 사진을 모두 지웁니다. 되돌릴 수 없습니다. 계속할까요?")) return;
        Store.deleteBook(b.id).then(function () {
          toast("삭제했습니다.");
          go("#/");
        });
      };
    }
  }

  // ============================================================ 환전 캡처
  // state.fxShot = { bookId, busy, msgs[], rows[{currency, foreignAmount, krwAmount, date, memo, dup, on}] }
  document.getElementById("fileFx").addEventListener("change", function (ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    ev.target.value = "";
    if (!files.length || !state.book) return;
    var b = state.book;
    var shot = state.fxShot && state.fxShot.bookId === b.id ? state.fxShot : { bookId: b.id, rows: [], msgs: [] };
    shot.busy = files.length;
    shot.msgs = [];
    state.fxShot = shot;
    renderFxReview();
    files.reduce(function (p, f, i) {
      return p.then(function () {
        return Scan.compress(f)
          .then(function (blob) {
            return Scan.recognizeExchange(blob, b);
          })
          .then(function (r) {
            if (!r.rows.length) shot.msgs.push((files.length > 1 ? i + 1 + "번째 사진: " : "") + "환전 기록을 찾지 못했습니다." + (r.note ? " (" + r.note + ")" : ""));
            else if (r.note) shot.msgs.push("AI 메모: " + r.note);
            r.rows.forEach(function (row) {
              row.dup = Scan.isDuplicateExchange(row, state.exchanges.concat(shot.rows));
              row.on = !row.dup && row.krwAmount > 0;
              if (!row.date) row.date = today();
              shot.rows.push(row);
            });
          })
          .catch(function (err) {
            shot.msgs.push((files.length > 1 ? i + 1 + "번째 사진: " : "") + err.message);
          })
          .then(function () {
            shot.busy--;
            renderFxReview();
          });
      });
    }, Promise.resolve());
  });

  function renderFxReview() {
    var box = document.getElementById("fxReview");
    var shot = state.fxShot;
    if (!box || !shot || shot.bookId !== state.book.id) return;
    var b = state.book;
    var curs = (b.currencies || []).slice();
    shot.rows.forEach(function (r) { if (curs.indexOf(r.currency) < 0) curs.push(r.currency); });
    var html = "";
    if (shot.busy) html += '<div class="banner banner--busy" style="margin-top:12px"><span class="spinner"></span> 캡처를 읽고 있습니다… (남은 ' + shot.busy + "장)</div>";
    shot.msgs.forEach(function (m) { html += '<div class="banner banner--warn" style="margin-top:12px">' + esc(m) + "</div>"; });
    if (shot.rows.length) {
      html += '<p class="hint">숫자를 캡처와 한 번 비교하고, 등록할 건만 체크하세요. 원화가 0인 건은 낸 원화를 채워야 등록됩니다.</p><div class="fxrows">';
      shot.rows.forEach(function (r, i) {
        var rate = r.foreignAmount > 0 && r.krwAmount > 0 ? FX.fmtRate(r.krwAmount / r.foreignAmount, r.currency) : "원화를 넣어 주세요";
        var extra = b.currencies.indexOf(r.currency) < 0 ? '<span class="tag tag--warn">이 여행 통화 아님</span>' : "";
        html +=
          '<div class="fxrow' + (r.on ? "" : " is-off") + '" data-i="' + i + '">' +
          '<label class="fxrow__check"><input type="checkbox" data-f="on"' + (r.on ? " checked" : "") + "> 등록" +
          (r.dup ? ' <span class="tag tag--warn">이미 있는 기록 같음</span>' : "") + extra + "</label>" +
          '<div class="row3">' +
          '<label class="field"><span>통화</span><select data-f="currency">' + curOptions(curs, r.currency) + "</select></label>" +
          '<label class="field"><span>받은 외화</span><input data-f="foreignAmount" inputmode="decimal" value="' + (r.foreignAmount || "") + '"></label>' +
          '<label class="field"><span>낸 원화</span><input data-f="krwAmount" inputmode="numeric" value="' + (r.krwAmount || "") + '"></label>' +
          "</div>" +
          '<div class="row2"><label class="field"><span>날짜</span><input type="date" data-f="date" value="' + esc(r.date) + '"></label>' +
          '<label class="field"><span>메모</span><input data-f="memo" value="' + esc(r.memo) + '"></label></div>' +
          '<p class="hint fxrow__rate">' + rate + "</p></div>";
      });
      var n = shot.rows.filter(function (r) { return r.on; }).length;
      html += "</div>" +
        '<div class="actions"><button type="button" class="btn btn--ghost" id="fxCancel">취소</button>' +
        '<button type="button" class="btn btn--primary" id="fxSave"' + (n && !shot.busy ? "" : " disabled") + ">선택한 " + n + "건 등록</button></div>";
    }
    box.innerHTML = html;

    box.querySelectorAll(".fxrow").forEach(function (el) {
      var r = shot.rows[Number(el.getAttribute("data-i"))];
      el.addEventListener("input", function (ev) { readRow(ev, r, false); });
      el.addEventListener("change", function (ev) { readRow(ev, r, true); });
    });
    function readRow(ev, r, rerender) {
      var f = ev.target.getAttribute("data-f");
      if (!f) return;
      if (f === "on") r.on = ev.target.checked;
      else if (f === "foreignAmount" || f === "krwAmount") r[f] = num(ev.target.value);
      else r[f] = ev.target.value.trim();
      if (f !== "on" && r.foreignAmount > 0 && r.krwAmount > 0 && !r.dup) r.on = true;
      if (rerender) renderFxReview();
    }
    var cancel = document.getElementById("fxCancel");
    if (cancel) cancel.onclick = function () { state.fxShot = null; renderFxReview(); box.innerHTML = ""; };
    var save = document.getElementById("fxSave");
    if (save) {
      save.onclick = function () {
        var pick = shot.rows.filter(function (r) { return r.on; });
        var bad = pick.filter(function (r) { return !(r.foreignAmount > 0) || !(r.krwAmount > 0); });
        if (bad.length) return toast("외화와 원화 금액이 모두 있어야 등록됩니다.", 4000);
        var addCur = [];
        Promise.all(pick.map(function (r) {
          if (b.currencies.indexOf(r.currency) < 0 && addCur.indexOf(r.currency) < 0) addCur.push(r.currency);
          return Store.put("exchanges", { bookId: b.id, currency: r.currency, foreignAmount: r.foreignAmount, krwAmount: r.krwAmount, date: r.date, memo: r.memo });
        }))
          .then(function () {
            // 등록한 환전 통화가 여행 통화 목록에 없으면 추가한다(환율 표·영수증 통화 선택에 바로 보이게).
            if (!addCur.length) return;
            b.currencies = b.currencies.concat(addCur);
            return Store.put("books", b);
          })
          .then(function () {
            state.fxShot = null;
            toast("환전 기록 " + pick.length + "건을 등록했습니다.");
            route();
          });
      };
    }
  }

  function copyText(text) {
    var done = function () { toast("복사했습니다. 메신저에 붙여 넣으세요."); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast("복사하지 못했습니다."); }
      ta.remove();
    }
  }

  // ============================================================ 사진 받기
  function onFiles(files) {
    files = Array.prototype.slice.call(files || []).filter(function (f) { return /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name); });
    if (!files.length || !state.book) return;
    // 여러 장이면 한 장씩 확인 화면을 띄우지 않고 뒤에서 차례로 인식해 바로 저장한다("확인 필요" 표시).
    if (files.length > 1) return startBatch(state.book, files);
    state.queue = files;
    state.draft = null;
    go("#/entry/" + state.book.id + "/new");
  }

  // ============================================================ 여러 장 자동 정리
  // state.batch = { bookId, total, done, failed, busy }
  // 사진마다: 압축 + 사진 GPS → Gemini 인식 → 기록·사진 저장(needsReview) → 주소로 위치 찾기(뒤에서).
  // 한꺼번에 보내면 Gemini가 붐빔(503)으로 막으므로 한 장씩, 사이에 1.5초 쉰다.
  var BATCH_GAP_MS = 1500;
  function startBatch(book, files) {
    if (state.batch && state.batch.busy) {
      state.batch.total += files.length;
      state.batch.files = state.batch.files.concat(files);
      renderBatch();
      return;
    }
    state.batch = { bookId: book.id, total: files.length, done: 0, failed: 0, busy: true, files: files.slice() };
    toast("영수증 " + files.length + "장을 차례로 정리합니다. 다른 화면을 봐도 계속 진행돼요.", 4000);
    if ((location.hash || curPath).indexOf("#/book/" + book.id) !== 0) go("#/book/" + book.id);
    else renderBatch();
    runBatch(book);
  }

  function runBatch(book) {
    var bt = state.batch;
    var f = bt.files.shift();
    if (!f) {
      bt.busy = false;
      toast("영수증 " + bt.total + "장 정리 끝" + (bt.failed ? " · 인식 못 한 " + bt.failed + "장은 직접 입력해 주세요" : "") + ". '확인 필요' 표시를 눌러 숫자를 확인하세요.", 6000);
      refreshIfOnBook(book.id);
      return;
    }
    var e = draftFor(book);
    Promise.all([Scan.compress(f), Geo.exifGps(f)])
      .then(function (res) {
        e._blob = res[0];
        e._gps = res[1];
        if (!Store.canScan()) throw new Error("자동 인식을 쓰려면 설정에서 키가 필요합니다.");
        return Scan.recognize(e._blob, book).then(function (r) {
          Object.assign(e, r, { payer: e.payer, splitAmong: e.splitAmong });
          if (!e.date) e.date = draftFor(book).date;
          e.memo = r.note ? "AI 메모: " + r.note : "";
        });
      })
      .catch(function (err) {
        bt.failed++;
        e.memo = "자동 인식 실패: " + err.message;
      })
      .then(function () {
        e.needsReview = true;
        if (!e.category) e.category = "기타";
        if (e._gps && !Geo.has(e.place)) e.place = Object.assign({}, e.place, { lat: e._gps.lat, lng: e._gps.lng, src: "photo", label: "사진 찍은 곳" });
        return saveEntryFor(book, e);
      })
      .then(function () {
        bt.done++;
        refreshIfOnBook(book.id);
        // 위치 찾기는 기다리지 않는다(지도 검색은 따로 1.1초 간격 줄 세우기)
        var p = e.place || {};
        if (!Geo.has(p) && (p.query || p.address || p.city)) {
          Geo.locate(e, null).then(function (place) {
            if (!Geo.has(place)) return;
            return Store.get("entries", e.id).then(function (rec) {
              if (rec && !Geo.has(rec.place)) {
                rec.place = place;
                return Store.put("entries", rec).then(function () { refreshIfOnBook(book.id); });
              }
            });
          });
        }
      }, function (err) {
        bt.done++;
        bt.failed++;
        toast("저장하지 못한 사진이 있습니다: " + err.message, 4000);
      })
      .then(function () {
        setTimeout(function () { runBatch(book); }, BATCH_GAP_MS);
      });
  }

  // 지금 그 여행의 발자취 탭을 보고 있으면 새로 그린다(스크롤 위치 유지)
  function refreshIfOnBook(bookId) {
    if (!state.book || state.book.id !== bookId) return;
    var p = (location.hash || curPath).replace(/^#\/?/, "").split("/");
    if (p[0] !== "book" || p[1] !== bookId || (p[2] && p[2] !== "list")) return renderBatch();
    var y = window.scrollY;
    Promise.all([Store.byBook("entries", bookId), Store.get("books", bookId)]).then(function (r) {
      state.entries = r[0];
      if (r[1]) state.book = r[1];
      releaseUrls();
      viewBook("list");
      window.scrollTo(0, y);
    });
  }

  function renderBatch() {
    var box = document.getElementById("batchBox");
    var bt = state.batch;
    if (!box) return;
    if (!bt || !state.book || bt.bookId !== state.book.id || !bt.busy) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = '<div class="banner banner--busy"><span class="spinner"></span> 영수증 ' + bt.total + "장 중 " + bt.done + "장 정리됨" +
      (bt.failed ? " (인식 못 함 " + bt.failed + ")" : "") + " — 남은 사진은 자동으로 이어집니다.</div>";
  }

  function draftFor(book) {
    return {
      bookId: book.id,
      date: book.start && (today() < book.start || (book.end && today() > book.end)) ? book.start : today(),
      time: "", merchant: "", merchantKo: "",
      currency: (book.currencies || [])[0] || "KRW",
      items: [], tax: 0, discount: 0, total: 0, category: "", payMethod: "",
      payer: (book.members || ["나"])[0], splitAmong: [], memo: "",
    };
  }
  document.getElementById("fileCamera").addEventListener("change", function (e) { onFiles(e.target.files); e.target.value = ""; });
  document.getElementById("fileAlbum").addEventListener("change", function (e) { onFiles(e.target.files); e.target.value = ""; });

  function newDraft() {
    var b = state.book;
    var d = {
      bookId: b.id,
      date: b.start && (today() < b.start || (b.end && today() > b.end)) ? b.start : today(),
      time: "",
      merchant: "",
      merchantKo: "",
      currency: (b.currencies || [])[0] || "KRW",
      items: [],
      tax: 0,
      discount: 0,
      total: 0,
      category: "",
      payMethod: "",
      payer: (b.members || ["나"])[0],
      splitAmong: [],
      memo: "",
    };
    var f = state.queue.shift();
    if (f) {
      d._file = f;
      d._needScan = true;
    }
    return d;
  }

  // ============================================================ 지출 확인·수정
  function viewEntry(id) {
    if (id === "new") {
      if (!state.draft) state.draft = newDraft();
      renderEntry(state.draft, true);
      return;
    }
    Store.get("entries", id).then(function (e) {
      if (!e) return go("#/book/" + state.book.id);
      state.draft = e;
      renderEntry(e, false);
    });
  }

  function renderEntry(e, isNew) {
    var b = state.book;
    var trip = (b.currencies || []).length > 0; // 해외 여행: 원문·번역 칸과 원화 환산 칸을 보인다
    var cats = Scan.CATEGORIES;
    var curs = bookCurrencies(b);
    if (curs.indexOf(e.currency) < 0) curs = curs.concat([e.currency]);
    var remain = state.queue.length;

    var html =
      '<a class="back" href="#/book/' + b.id + '">← ' + esc(b.name) + "</a>" +
      "<h1>" + (isNew ? "영수증 확인" : "지출 수정") + (remain ? ' <small class="muted">(뒤에 ' + remain + "장 더)</small>" : "") + "</h1>" +
      '<div id="scanBox"></div>' +
      '<div class="entry-layout">' +
      '<div class="photo-col" id="photoCol"></div>' +
      '<form id="entryForm" class="form">' +
      '<div class="row2"><label class="field"><span>날짜</span><input type="date" name="date" value="' + esc(e.date) + '" required></label>' +
      '<label class="field"><span>시각</span><input type="time" name="time" value="' + esc(e.time) + '"></label></div>' +
      '<label class="field"><span>가게 이름' + (trip ? " (한국어)" : "") + '</span><input name="merchantKo" value="' + esc(e.merchantKo) + '" placeholder="예: 스타벅스 강남점"></label>' +
      (trip ? '<label class="field"><span>가게 이름 (원문)</span><input name="merchant" value="' + esc(e.merchant) + '"></label>' : "") +
      '<div id="placeBox"></div>' +
      '<div class="row2"><label class="field"><span>카테고리</span><select name="category"><option value="">선택</option>' +
      cats.map(function (c) { return '<option' + (c === e.category ? " selected" : "") + ">" + c + "</option>"; }).join("") +
      "</select></label>" +
      '<label class="field"><span>결제수단</span><select name="payMethod"><option value="">모름</option><option value="card"' + (e.payMethod === "card" ? " selected" : "") + '>카드</option><option value="cash"' + (e.payMethod === "cash" ? " selected" : "") + ">현금</option></select></label></div>" +

      '<fieldset class="items"><legend>항목</legend><div id="itemRows"></div>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="addItem">+ 항목 추가</button></fieldset>' +

      '<div class="row3"><label class="field"><span>세금</span><input name="tax" inputmode="decimal" value="' + (e.tax || "") + '" placeholder="0"></label>' +
      '<label class="field"><span>할인</span><input name="discount" inputmode="decimal" value="' + (e.discount || "") + '" placeholder="0"></label>' +
      '<label class="field"><span>통화</span><select name="currency">' + curOptions(curs, e.currency) + "</select></label></div>" +
      '<label class="field field--total"><span>결제 합계</span><input name="total" inputmode="decimal" value="' + (e.total || "") + '" required placeholder="0"></label>' +
      '<p id="sumCheck" class="sumcheck"></p>' +

      (trip
        ? '<div id="krwBox" class="krwbox"></div>' +
          '<details class="override"' + (e.krwOverride || e.rateOverride ? " open" : "") + '><summary>카드 청구액으로 원화 덮어쓰기</summary>' +
          '<div class="row2"><label class="field"><span>실제 청구 원화</span><input name="krwOverride" inputmode="numeric" value="' + (e.krwOverride || "") + '" placeholder="카드 명세서 금액"></label>' +
          '<label class="field"><span>또는 적용 환율(1단위당 원)</span><input name="rateOverride" inputmode="decimal" value="' + (e.rateOverride || "") + '"></label></div>' +
          '<p class="hint">둘 다 비우면 환전 기록 가중평균 환율을 씁니다. 청구 원화가 있으면 그게 우선입니다.</p></details>'
        : "") +

      ((b.members || []).length > 1
        ? '<fieldset class="field"><legend>누가 냈나요</legend><div class="chips">' +
          b.members.map(function (m) {
            return '<label class="chip"><input type="radio" name="payer" value="' + esc(m) + '"' + ((e.payer || b.members[0]) === m ? " checked" : "") + "><span>" + esc(m) + "</span></label>";
          }).join("") +
          '</div></fieldset><fieldset class="field"><legend>누구 몫인가요 <small class="muted">(안 고르면 전원)</small></legend><div class="chips">' +
          b.members.map(function (m) {
            return '<label class="chip"><input type="checkbox" name="split" value="' + esc(m) + '"' + ((e.splitAmong || []).indexOf(m) >= 0 ? " checked" : "") + "><span>" + esc(m) + "</span></label>";
          }).join("") +
          "</div></fieldset>"
        : "") +

      '<label class="field"><span>메모</span><input name="memo" value="' + esc(e.memo) + '"></label>' +
      '<div class="actions">' +
      (isNew && remain ? '<button type="button" class="btn btn--ghost" id="skipBtn">이 사진 건너뛰기</button>' : "") +
      (!isNew ? '<button type="button" class="btn btn--danger" id="delBtn">삭제</button>' : "") +
      '<button class="btn btn--primary" type="submit">' + (isNew && remain ? "저장하고 다음" : "저장") + "</button></div>" +
      "</form></div>";
    $app.innerHTML = html;

    var form = document.getElementById("entryForm");
    renderPhoto(e);
    renderItems(e);
    renderPlace(e);
    refreshCalc();

    form.addEventListener("input", function (ev) {
      readForm(form, e);
      if (ev.target.closest("#itemRows") || /^(total|tax|discount|currency|krwOverride|rateOverride)$/.test(ev.target.name)) refreshCalc();
    });
    form.addEventListener("change", function () {
      readForm(form, e);
      refreshCalc();
    });
    document.getElementById("addItem").onclick = function () {
      e.items.push({ name: "", nameKo: "", qty: 1, amount: 0 });
      renderItems(e);
      var rows = document.querySelectorAll("#itemRows .item");
      var last = rows[rows.length - 1];
      if (last) last.querySelector("input").focus();
    };
    var skip = document.getElementById("skipBtn");
    if (skip) skip.onclick = nextOrBack;
    var del = document.getElementById("delBtn");
    if (del) {
      del.onclick = function () {
        if (!confirm("이 지출을 지울까요?")) return;
        Promise.all([Store.del("entries", e.id), e.photoId ? Store.del("photos", e.photoId) : null]).then(function () {
          toast("삭제했습니다.");
          go("#/book/" + b.id);
        });
      };
    }
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      readForm(form, e);
      if (!e.date) return toast("날짜를 넣어 주세요.");
      if (!(e.total > 0)) return toast("결제 합계를 넣어 주세요.");
      if (!e.category) e.category = "기타";
      saveEntry(e).then(function () {
        toast("저장했습니다.");
        nextOrBack();
      });
    });

    if (e.needsReview && !isNew) setScanBox("여러 장을 한꺼번에 올려 <b>자동으로 정리한 기록</b>입니다. 날짜·금액을 사진과 비교하고 저장하면 확인 완료로 바뀝니다." + (e.memo && /^자동 인식 실패/.test(e.memo) ? "<br><small>" + esc(e.memo) + "</small>" : ""));
    if (e._needScan) startScan(e);
  }

  function nextOrBack() {
    if (state.queue.length) {
      state.draft = newDraft();
      releaseUrls();
      window.scrollTo(0, 0);
      renderEntry(state.draft, true);
    } else {
      state.draft = null;
      go("#/book/" + state.book.id);
    }
  }

  // 확인 화면에서 저장 = 사람이 확인했다는 뜻 → "확인 필요" 표시를 지운다
  function saveEntry(e) {
    e.needsReview = false;
    return saveEntryFor(state.book, e);
  }

  function saveEntryFor(book, e) {
    var rec = {};
    Object.keys(e).forEach(function (k) {
      if (k.charAt(0) !== "_") rec[k] = e[k];
    });
    rec.bookId = book.id;
    rec.items = (e.items || []).filter(function (it) { return it.name || it.nameKo || it.amount; });
    rec.updatedAt = new Date().toISOString();
    var photo = e._blob ? Store.put("photos", { id: rec.photoId || Store.uid(), blob: e._blob }) : Promise.resolve(null);
    return photo.then(function (p) {
      if (p) rec.photoId = e.photoId = p.id;
      return Store.put("entries", rec).then(function (saved) {
        e.id = saved.id; // 위치 찾기가 저장 뒤에 끝나도 이 기록에 반영되게
        // 여행 통화에 없던 외화 영수증이면 여행 통화에 자동으로 넣는다(환율 표·환전 탭에 바로 보이게)
        return Store.get("books", book.id).then(function (bk) {
          if (bk && rec.currency && rec.currency !== "KRW" && (bk.currencies || []).indexOf(rec.currency) < 0) {
            bk.currencies = (bk.currencies || []).concat([rec.currency]);
            if (state.book && state.book.id === bk.id) state.book.currencies = bk.currencies;
            return Store.put("books", bk).then(function () { return saved; });
          }
          return saved;
        });
      });
    });
  }

  function readForm(form, e) {
    var fd = new FormData(form);
    ["date", "time", "merchantKo", "category", "payMethod", "currency", "memo"].forEach(function (k) {
      if (fd.has(k)) e[k] = String(fd.get(k) || "").trim();
    });
    if (fd.has("merchant")) e.merchant = String(fd.get("merchant") || "").trim();
    else e.merchant = e.merchant || e.merchantKo;
    e.total = num(fd.get("total"));
    e.tax = num(fd.get("tax"));
    e.discount = Math.abs(num(fd.get("discount")));
    if (fd.has("krwOverride")) {
      e.krwOverride = num(fd.get("krwOverride")) || null;
      e.rateOverride = num(fd.get("rateOverride")) || null;
    }
    if (form.querySelector("input[name=payer]")) {
      e.payer = fd.get("payer") || state.book.members[0];
      e.splitAmong = fd.getAll("split");
      // 전원을 다 고른 것과 아무도 안 고른 것은 같은 뜻. 나중에 일행이 늘어도 "전원"이 따라가게 비워 둔다.
      if (e.splitAmong.length === state.book.members.length) e.splitAmong = [];
    }
    var rows = form.querySelectorAll("#itemRows .item");
    e.items = Array.prototype.map.call(rows, function (r) {
      return {
        name: r.querySelector("[data-k=name]") ? r.querySelector("[data-k=name]").value.trim() : "",
        nameKo: r.querySelector("[data-k=nameKo]").value.trim(),
        qty: num(r.querySelector("[data-k=qty]").value) || 1,
        amount: num(r.querySelector("[data-k=amount]").value),
      };
    });
    if (!rows.length) e.items = [];
    // 국내 영수증은 원문=한국어라 원문칸을 따로 안 보여준다
    if (!(state.book.currencies || []).length) e.items.forEach(function (it) { it.name = it.name || it.nameKo; });
  }

  function renderItems(e) {
    var trip = (state.book.currencies || []).length > 0;
    var box = document.getElementById("itemRows");
    if (!e.items.length) {
      box.innerHTML = '<p class="hint">항목은 없어도 저장됩니다. 합계만 맞으면 됩니다.</p>';
      return;
    }
    box.innerHTML = e.items
      .map(function (it, i) {
        return (
          '<div class="item">' +
          '<div class="item__names"><input data-k="nameKo" value="' + esc(it.nameKo) + '" placeholder="' + (trip ? "한국어 이름" : "항목") + '">' +
          (trip ? '<input data-k="name" class="item__orig" value="' + esc(it.name) + '" placeholder="원문">' : "") +
          "</div>" +
          '<input data-k="qty" class="item__qty" inputmode="numeric" value="' + (it.qty || 1) + '" aria-label="수량">' +
          '<input data-k="amount" class="item__amt" inputmode="decimal" value="' + (it.amount || "") + '" placeholder="금액" aria-label="금액">' +
          '<button type="button" class="item__del" data-del="' + i + '" aria-label="항목 삭제">×</button>' +
          "</div>"
        );
      })
      .join("");
    box.querySelectorAll("[data-del]").forEach(function (btn) {
      btn.onclick = function () {
        readForm(document.getElementById("entryForm"), e);
        e.items.splice(Number(btn.getAttribute("data-del")), 1);
        renderItems(e);
        refreshCalc();
      };
    });
  }

  function refreshCalc() {
    var e = state.draft;
    if (!e) return;
    var sc = document.getElementById("sumCheck");
    if (sc) {
      var chk = Scan.checkSum(e);
      if (!e.items.length || !e.total) {
        sc.textContent = "";
        sc.className = "sumcheck";
      } else if (chk.ok) {
        sc.textContent = "✓ 항목 합계와 결제 합계가 맞습니다.";
        sc.className = "sumcheck is-ok";
      } else {
        sc.textContent = "⚠ 항목 합(" + FX.fmt(chk.sum, e.currency) + ")이 결제 합계와 다릅니다. 사진과 비교해 주세요.";
        sc.className = "sumcheck is-warn";
      }
    }
    var kb = document.getElementById("krwBox");
    if (kb) {
      var r = FX.rates(state.exchanges);
      if (e.currency === "KRW") kb.innerHTML = "";
      else {
        var k = FX.krw(e, r);
        var rate = FX.rateOf(e, r);
        kb.innerHTML = k == null
          ? '<span class="neg">' + e.currency + ' 환전 기록이 없어 원화로 못 바꿉니다.</span> <a href="#/book/' + state.book.id + '/fx">환전 등록</a>'
          : "원화 ≈ <b>" + FX.won(k) + "</b> <small class=\"muted\">(" + FX.fmtRate(rate, e.currency) + (e.krwOverride ? ", 청구액 기준" : e.rateOverride ? ", 직접 입력" : ", 환전 평균") + ")</small>";
      }
    }
  }

  // ------------------------------------------------------------ 위치
  // e.place = { address, query, city, country, lat, lng, src, label }
  // 좌표 찾기는 비동기라 폼 전체를 다시 그리지 않고 #placeBox만 갈아 끼운다(입력 중인 값 보존).
  var placeMap = null;
  function renderPlace(e) {
    var box = document.getElementById("placeBox");
    if (!box) return;
    var p = e.place || {};
    var has = Geo.has(p);
    var status = e._locating
      ? '<span class="spinner"></span> 영수증 주소로 위치를 찾는 중…'
      : has
        ? "📍 " + esc(p.label || p.address || "지정된 위치") + ' <span class="tag' + (Geo.isApprox(p) ? " tag--warn" : "") + '">' + esc(Geo.SRC_LABEL[p.src] || "") + "</span>"
        : '<span class="muted">아직 위치가 없습니다. 주소로 찾거나 지도를 눌러 찍어 주세요.</span>';
    box.innerHTML =
      '<fieldset class="field placebox"><legend>위치 <small class="muted">(발자취 지도에 찍힘)</small></legend>' +
      '<p class="place__status">' + status + "</p>" +
      '<div id="placeMap" class="placemap"></div>' +
      '<p class="hint">지도를 누르면 그 자리로 핀을 옮깁니다. 확대는 +/− 또는 두 손가락.</p>' +
      '<label class="field"><span>영수증 주소</span><input id="placeAddr" value="' + esc(p.address || "") + '" placeholder="영수증에 적힌 주소"></label>' +
      '<div class="place__search"><input id="placeQ" placeholder="장소 이름이나 주소로 검색 (예: 도톤보리 이치란)" enterkeyhint="search">' +
      '<button type="button" class="btn btn--ghost btn--sm" id="placeGo">검색</button></div>' +
      '<ul id="placeResults" class="place__results"></ul>' +
      '<div class="place__btns">' +
      '<button type="button" class="btn btn--ghost btn--sm" id="placeByAddr">주소로 다시 찾기</button>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="placeHere">지금 내 위치</button>' +
      (has ? '<button type="button" class="btn btn--ghost btn--sm" id="placeClear">위치 지우기</button>' : "") +
      "</div></fieldset>";

    // 지도: 핀이 없으면 같은 여행의 마지막 위치 근처(또는 세계 지도)에서 시작
    var el = document.getElementById("placeMap");
    placeMap = TinyMap.create(el, {
      points: has ? [{ lat: p.lat, lng: p.lng, label: "", approx: Geo.isApprox(p) }] : [],
      onTap: function (ll) {
        setPlace(e, { lat: ll.lat, lng: ll.lng, src: "manual", label: "지도에서 지정", approx: false });
      },
    });
    if (has && Geo.isApprox(p)) placeMap.center(p.lat, p.lng, 12);
    if (!has) {
      var near = Geo.chrono(state.entries).filter(function (x) { return Geo.has(x.place) && x.id !== e.id; }).pop();
      if (near) placeMap.center(near.place.lat, near.place.lng, 13);
    }

    document.getElementById("placeAddr").oninput = function () {
      e.place = Object.assign({}, e.place, { address: this.value.trim() });
      if (!this.value.trim()) e.place.query = "";
    };
    var q = document.getElementById("placeQ");
    var doSearch = function () {
      var v = q.value.trim();
      if (!v) return;
      var list = document.getElementById("placeResults");
      list.innerHTML = '<li class="muted"><span class="spinner"></span> 찾는 중…</li>';
      Geo.search(v, { limit: 5 }).then(function (r) {
        if (!r.length) {
          list.innerHTML = '<li class="muted">찾지 못했습니다. 다른 이름이나 도시를 붙여 보세요.</li>';
          return;
        }
        list.innerHTML = r.map(function (x, i) {
          return '<li><button type="button" data-r="' + i + '">' + esc(x.label) + "</button></li>";
        }).join("");
        list.querySelectorAll("[data-r]").forEach(function (btn) {
          btn.onclick = function () {
            var x = r[Number(btn.getAttribute("data-r"))];
            setPlace(e, { lat: x.lat, lng: x.lng, src: "search", label: x.label, approx: false });
          };
        });
      }, function () {
        list.innerHTML = '<li class="muted">지도 검색에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.</li>';
      });
    };
    document.getElementById("placeGo").onclick = doSearch;
    q.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault(); // 폼 저장으로 넘어가지 않게
        doSearch();
      }
    });
    document.getElementById("placeByAddr").onclick = function () {
      var pl = e.place || {};
      if (!pl.address && !pl.query && !pl.city && !e.merchant) return toast("주소나 가게 이름을 먼저 넣어 주세요.");
      // 손으로 고친 주소가 우선이 되도록 AI 검색어는 비운다
      if (pl.address) e.place = Object.assign({}, pl, { query: "" });
      e.place = Object.assign({}, e.place, { lat: null, lng: null, src: "", label: "" });
      autoLocate(e, true);
    };
    document.getElementById("placeHere").onclick = function () {
      if (!navigator.geolocation) return toast("이 브라우저는 위치를 알려 주지 않습니다.");
      toast("현재 위치를 확인하는 중…");
      navigator.geolocation.getCurrentPosition(function (pos) {
        setPlace(e, { lat: pos.coords.latitude, lng: pos.coords.longitude, src: "gps", label: "기록할 때 있던 곳", approx: false });
      }, function () {
        toast("위치를 가져오지 못했습니다. 브라우저 위치 권한을 확인해 주세요.", 4000);
      }, { enableHighAccuracy: true, timeout: 15000 });
    };
    var clr = document.getElementById("placeClear");
    if (clr) clr.onclick = function () {
      e.place = Object.assign({}, e.place, { lat: null, lng: null, src: "", label: "" });
      renderPlace(e);
    };
  }

  function setPlace(e, patch) {
    e.place = Object.assign({}, e.place, patch);
    if (state.draft === e) renderPlace(e);
  }

  // 영수증 정보(+사진 GPS)로 좌표 찾기. 저장 뒤에 끝나면 저장된 기록에 반영한다.
  function autoLocate(e, loud) {
    e._locating = true;
    if (state.draft === e) renderPlace(e);
    return Geo.locate(e, e._gps || null).then(function (place) {
      e._locating = false;
      // 그사이 사용자가 직접 찍었으면 덮어쓰지 않는다
      if (Geo.has(e.place) && /^(manual|search|gps)$/.test(e.place.src)) return;
      e.place = place;
      if (state.draft === e) renderPlace(e);
      if (loud && !Geo.has(place)) toast("위치를 찾지 못했습니다. 검색하거나 지도를 눌러 주세요.", 4000);
      if (e.id && state.draft !== e) {
        return Store.get("entries", e.id).then(function (rec) {
          if (rec && !Geo.has(rec.place)) {
            rec.place = place;
            return Store.put("entries", rec);
          }
        });
      }
    });
  }

  // ------------------------------------------------------------ 사진
  function renderPhoto(e) {
    var col = document.getElementById("photoCol");
    var show = function (blob) {
      var u = objUrl(blob);
      col.innerHTML = '<button type="button" class="photo" aria-label="사진 크게 보기"><img src="' + u + '" alt="영수증 사진"></button>' +
        (Store.canScan() && state.draft === e ? '<button type="button" class="btn btn--ghost btn--sm btn--block" id="rescan">다시 인식</button>' : "");
      col.querySelector(".photo").onclick = function () { openViewer(u); };
      var rs = document.getElementById("rescan");
      if (rs) rs.onclick = function () { startScan(e); };
    };
    if (e._blob) return show(e._blob);
    if (e._file) {
      col.innerHTML = '<div class="photo photo--loading">사진 준비 중…</div>';
      return;
    }
    if (e.photoId) {
      Store.get("photos", e.photoId).then(function (p) {
        if (p && p.blob) {
          e._blob = p.blob;
          show(p.blob);
        }
      });
      return;
    }
    col.innerHTML = '<label class="photo photo--empty"><span>사진 첨부</span><input type="file" accept="image/*" hidden id="attachPhoto"></label>';
    document.getElementById("attachPhoto").onchange = function (ev) {
      var f = ev.target.files[0];
      if (!f) return;
      Geo.exifGps(f).then(function (g) {
        if (g && !Geo.has(e.place)) setPlace(e, { lat: g.lat, lng: g.lng, src: "photo", label: "사진 찍은 곳" });
      });
      Scan.compress(f).then(function (blob) {
        e._blob = blob;
        show(blob);
      }, function (err) { toast(err.message, 5000); });
    };
  }

  function openViewer(url) {
    var v = document.getElementById("viewer");
    document.getElementById("viewerImg").src = url;
    v.hidden = false;
  }
  document.getElementById("viewerClose").onclick = function () { document.getElementById("viewer").hidden = true; };
  document.getElementById("viewer").addEventListener("click", function (ev) {
    if (ev.target.id === "viewer") ev.currentTarget.hidden = true;
  });

  // ------------------------------------------------------------ 인식
  function setScanBox(html, cls) {
    var box = document.getElementById("scanBox");
    if (box) {
      box.innerHTML = html ? '<div class="banner ' + (cls || "") + '">' + html + "</div>" : "";
    }
  }

  function startScan(e) {
    e._needScan = false;
    var b = state.book;
    // 압축하면 EXIF가 사라지므로 원본에서 GPS를 먼저 읽어 둔다(앨범 사진에만 있는 경우가 많다)
    var prep = e._blob
      ? Promise.resolve([e._blob, e._gps || null])
      : Promise.all([Scan.compress(e._file), Geo.exifGps(e._file)]);
    prep
      .then(function (res) {
        var blob = res[0];
        e._blob = blob;
        e._gps = res[1];
        delete e._file;
        if (state.draft !== e) return;
        renderPhoto(e);
        if (!Store.canScan()) {
          if (e._gps && !Geo.has(e.place)) setPlace(e, { lat: e._gps.lat, lng: e._gps.lng, src: "photo", label: "사진 찍은 곳" });
          setScanBox('자동 인식을 쓰려면 <a href="#/settings">설정</a>에서 Gemini API 키를 넣어 주세요. 지금은 직접 입력해 주세요.' +
            (e._gps ? " 위치는 사진 GPS로 찍었습니다." : ""));
          return;
        }
        setScanBox('<span class="spinner"></span> 영수증을 읽고 있습니다… (보통 5~15초)', "banner--busy");
        document.getElementById("entryForm").classList.add("is-busy");
        return Scan.recognize(blob, b).then(function (r) {
          if (state.draft !== e) return; // 그사이 다른 화면으로 갔다
          var keep = { id: e.id, photoId: e.photoId, payer: e.payer, splitAmong: e.splitAmong, memo: e.memo, krwOverride: e.krwOverride, rateOverride: e.rateOverride };
          // 사용자가 직접 찍은 위치는 다시 인식해도 유지
          var userPlace = Geo.has(e.place) && /^(manual|search|gps)$/.test(e.place.src);
          if (userPlace) keep.place = e.place;
          Object.assign(e, r, keep);
          if (!e.date) e.date = today();
          // 여행 통화 목록에 없는 통화가 나오면 알려 준다(목록에 자동 추가하진 않음)
          var msg = "인식 완료. <b>숫자와 날짜를 사진과 한 번 비교</b>한 뒤 저장하세요.";
          if (bookCurrencies(b).indexOf(e.currency) < 0) msg += " 영수증 통화(" + e.currency + ")는 저장하면 이 여행의 외화에 자동으로 추가됩니다.";
          if (r.note) msg += '<br><small>AI 메모: ' + esc(r.note) + "</small>";
          renderEntry(e, !e.id);
          setScanBox(msg, "banner--ok");
          if (!userPlace) autoLocate(e, false);
        });
      })
      .catch(function (err) {
        if (state.draft !== e) return;
        var f = document.getElementById("entryForm");
        if (f) f.classList.remove("is-busy");
        if (e._gps && !Geo.has(e.place)) setPlace(e, { lat: e._gps.lat, lng: e._gps.lng, src: "photo", label: "사진 찍은 곳" });
        setScanBox(esc(err.message) + ' <button type="button" class="btn btn--ghost btn--sm" id="retryScan">다시 시도</button>', "banner--warn");
        var rt = document.getElementById("retryScan");
        if (rt) rt.onclick = function () { startScan(e); };
      });
  }

  // ============================================================ 설정
  function viewSettings() {
    var s = Store.settings();
    var proxy = !!Store.proxyUrl();
    var keyForm =
      '<form id="keyForm" class="form">' +
      '<label class="field"><span>Gemini API 키' + (proxy ? " (선택)" : "") + '</span><input name="key" type="password" autocomplete="off" value="' + esc(s.geminiKey) + '" placeholder="AIza…"></label>' +
      '<label class="field"><span>모델</span><input name="model" value="' + esc(s.geminiModel) + '"></label>' +
      '<button class="btn btn--primary btn--block">저장</button></form>' +
      '<p class="hint">키는 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>에서 무료로 만들 수 있습니다. 키는 이 기기에만 저장됩니다.</p>';
    $app.innerHTML =
      '<a class="back" href="#/">← 돌아가기</a><h1>설정</h1>' +
      '<section class="panel"><h2>영수증 자동 인식 (Google Gemini)</h2>' +
      (proxy
        ? '<p class="banner banner--ok" style="margin:0 0 10px">키 없이 바로 쓸 수 있습니다. 공용 인식 서버로 처리합니다.</p>' +
          '<details' + (s.geminiKey ? " open" : "") + '><summary>내 Gemini 키로 쓰기 (선택)</summary>' +
          '<p class="hint">공용 서버가 붐빌 때 내 키를 넣으면 그 키로 직접 인식합니다. 비우면 다시 공용 서버를 씁니다.</p>' + keyForm + "</details>"
        : keyForm) +
      '<div class="notice"><b>개인정보 안내</b><ul>' +
      (proxy
        ? "<li>자동 인식을 하면 영수증 사진이 <b>운영자의 중계 서버(Cloudflare)를 거쳐</b> Google Gemini로 전송됩니다. 중계 서버는 내용을 저장하지 않고 그대로 넘깁니다.</li>"
        : "<li>자동 인식을 하면 영수증 사진이 Google Gemini로 전송됩니다.</li>") +
      "<li>그 외 기록·사진은 이 기기 밖으로 나가지 않습니다.</li>" +
      "<li>무료 키로 보낸 내용은 Google이 서비스 개선(학습)에 쓸 수 있습니다. 민감한 영수증은 직접 입력을 권장합니다.</li>" +
      "<li>카드번호·승인번호·전화번호는 추출하지 않도록 요청하지만, 사진 자체에는 남아 있습니다.</li>" +
      "<li>위치를 찾을 때 영수증의 <b>가게 주소·상호</b>(사진은 아님)가 OpenStreetMap 검색(Nominatim)으로 전송됩니다. 지도 그림도 OpenStreetMap에서 받아옵니다.</li>" +
      "<li>\"지금 내 위치\" 버튼을 누를 때만 기기 위치를 묻습니다.</li>" +
      "<li>이 앱은 AI(Claude)의 도움을 받아 만들었습니다.</li>" +
      "</ul></div></section>" +
      '<section class="panel"><h2>백업 · 복원</h2>' +
      '<p class="hint">기록은 이 브라우저에만 있습니다. 브라우저 데이터를 지우거나 폰을 바꾸면 사라지니 가끔 백업해 두세요.</p>' +
      '<button type="button" class="btn btn--ghost btn--block" id="bkLite">백업 파일 받기 (사진 제외, 가벼움)</button>' +
      '<button type="button" class="btn btn--ghost btn--block" id="bkFull">백업 파일 받기 (사진 포함)</button>' +
      '<button type="button" class="btn btn--ghost btn--block" id="bkRestore">백업 파일로 복원 (기존 기록과 합치기)</button>' +
      '<p class="hint" id="storageInfo"></p></section>';

    document.getElementById("keyForm").addEventListener("submit", function (ev) {
      ev.preventDefault();
      Store.saveSettings({ geminiKey: this.key.value.trim(), geminiModel: this.model.value.trim() || Scan.DEFAULT_MODEL });
      toast("저장했습니다.");
    });
    var bk = function (withPhotos) {
      CSVX.backup(withPhotos).then(function (data) {
        CSVX.download("영수증여행기록_백업_" + today() + (withPhotos ? "_사진포함" : "") + ".json", JSON.stringify(data), "application/json");
      });
    };
    document.getElementById("bkLite").onclick = function () { bk(false); };
    document.getElementById("bkFull").onclick = function () { bk(true); };
    document.getElementById("bkRestore").onclick = function () { document.getElementById("fileRestore").click(); };
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        var el = document.getElementById("storageInfo");
        if (el && est.usage != null) el.textContent = "현재 사용 중: 약 " + (est.usage / 1048576).toFixed(1) + "MB";
      }).catch(function () {});
    }
  }

  document.getElementById("fileRestore").addEventListener("change", function (ev) {
    var f = ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    f.text()
      .then(function (t) { return CSVX.restore(JSON.parse(t)); })
      .then(function (r) {
        toast("복원했습니다: 여행 " + r.books + "개, 기록 " + r.entries + "건");
        go("#/");
      })
      .catch(function (err) { toast("복원 실패: " + err.message, 5000); });
  });

  // ============================================================ 시작
  window.addEventListener("hashchange", route);
  // 인식 서버가 붐벼 다시 시도할 때 화면 아래에 알린다(영수증·환전·여행 일정 공통)
  Scan.onBusy = function (n, total, ms) {
    toast("Gemini가 붐벼서 " + Math.round(ms / 1000) + "초 뒤 다시 시도합니다 (" + n + "/" + total + ")", ms);
  };

  Store.init().then(function () {
    if (Store.isMemory()) document.getElementById("memWarn").hidden = false;
    // 저장 공간을 브라우저가 임의로 비우지 않게 요청(허용 여부는 브라우저 판단)
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    route();
  });

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
