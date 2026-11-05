(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 집계 + 차트
  // ---------------------------------------------------------------------
  // 카테고리는 최대 9개라 색으로 구분하면 색맹 안전 팔레트(8색)를 넘는다.
  // 그래서 도넛 대신 "이름 + 막대 + 금액" 순위 막대로 그린다 — 정체성은 글자가,
  // 크기는 막대 길이가 맡는다. 색은 한 가지(파랑)만 쓴다.
  // 일별 지출은 세로 막대 + 마우스/터치 툴팁.

  var SS = {};

  function sumBy(entries, keyFn, krwFn) {
    var m = {};
    var missing = 0;
    entries.forEach(function (e) {
      var v = krwFn(e);
      if (v == null) {
        missing++;
        return;
      }
      var k = keyFn(e) || "기타";
      m[k] = (m[k] || 0) + v;
    });
    return { map: m, missing: missing };
  }

  SS.total = function (entries, krwFn) {
    var t = 0;
    var missing = 0;
    entries.forEach(function (e) {
      var v = krwFn(e);
      if (v == null) missing++;
      else t += v;
    });
    return { total: t, missing: missing };
  };

  SS.ranked = function (entries, keyFn, krwFn, limit) {
    var r = sumBy(entries, keyFn, krwFn).map;
    var arr = Object.keys(r).map(function (k) {
      return { key: k, value: r[k] };
    });
    arr.sort(function (a, b) {
      return b.value - a.value;
    });
    return limit ? arr.slice(0, limit) : arr;
  };

  SS.byDay = function (entries, krwFn, from, to) {
    var m = sumBy(
      entries,
      function (e) {
        return e.date;
      },
      krwFn
    ).map;
    var days = [];
    if (!from || !to) {
      var keys = Object.keys(m).filter(Boolean).sort();
      from = keys[0];
      to = keys[keys.length - 1];
    }
    if (!from) return days;
    var d = new Date(from + "T00:00:00");
    var end = new Date(to + "T00:00:00");
    var guard = 0;
    while (d <= end && guard++ < 400) {
      var k = ymd(d);
      days.push({ key: k, value: m[k] || 0 });
      d.setDate(d.getDate() + 1);
    }
    return days;
  };

  // 통화별 원문 합계(여행용)
  SS.byCurrency = function (entries) {
    var m = {};
    entries.forEach(function (e) {
      var c = e.currency || "KRW";
      m[c] = (m[c] || 0) + (e.total || 0);
    });
    return m;
  };

  // 실제로 쓴 통화별 합계를 한 줄로: "16,270 JPY + 원화 5,000원". 원화만 썼으면 빈 문자열
  // (원화 총액 옆에 붙여 "엔으로 얼마 썼는지"를 같이 보이게 한다)
  SS.currencyLine = function (entries) {
    var m = SS.byCurrency(entries || []);
    var foreign = Object.keys(m).filter(function (c) { return c !== "KRW" && m[c]; });
    if (!foreign.length) return "";
    var parts = foreign.map(function (c) { return FX.fmt(m[c], c); });
    if (m.KRW) parts.push("원화 " + FX.won(m.KRW));
    return parts.join(" + ");
  };

  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  SS.ymd = ymd;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ------------------------------------------------------- 순위 막대(HTML)
  SS.rankBars = function (rows, total) {
    if (!rows.length) return '<p class="muted">아직 기록이 없습니다.</p>';
    var max = rows[0].value || 1;
    return (
      '<ul class="rank">' +
      rows
        .map(function (r) {
          var pct = total ? Math.round((r.value / total) * 100) : 0;
          return (
            '<li class="rank__row">' +
            '<span class="rank__label">' + esc(r.key) + "</span>" +
            '<span class="rank__track"><span class="rank__bar" style="width:' + Math.max(2, (r.value / max) * 100) + '%"></span></span>' +
            '<span class="rank__value">' + FX.won(r.value) + ' <small>' + pct + "%</small></span>" +
            "</li>"
          );
        })
        .join("") +
      "</ul>"
    );
  };

  // ----------------------------------------------------- 일별 막대(SVG)
  SS.dayBars = function (days) {
    if (!days.length) return '<p class="muted">아직 기록이 없습니다.</p>';
    var W = 640;
    var H = 180;
    var padL = 4;
    var padB = 22;
    var padT = 10;
    var n = days.length;
    var slot = (W - padL * 2) / n;
    var bw = Math.max(2, Math.min(28, slot - 2)); // 막대 사이 2px 간격
    var max = Math.max.apply(
      null,
      days.map(function (d) {
        return d.value;
      })
    ) || 1;
    var labelEvery = Math.ceil(n / 10);
    var parts = [];
    parts.push('<line class="chart__base" x1="0" x2="' + W + '" y1="' + (H - padB) + '" y2="' + (H - padB) + '"/>');
    days.forEach(function (d, i) {
      var x = padL + i * slot + (slot - bw) / 2;
      var h = d.value ? Math.max(2, ((H - padB - padT) * d.value) / max) : 0;
      var y = H - padB - h;
      var r = Math.min(4, bw / 2, h);
      if (h) {
        // 위쪽만 둥근 막대: 기준선에 붙은 쪽은 각지게
        parts.push(
          '<path class="chart__bar" d="M' + x + "," + (H - padB) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y +
            "H" + (x + bw - r) + "Q" + (x + bw) + "," + y + " " + (x + bw) + "," + (y + r) + "V" + (H - padB) + 'Z"/>'
        );
      }
      // 히트 영역은 칸 전체 높이 — 작은 막대도 짚기 쉽게
      parts.push(
        '<rect class="chart__hit" x="' + (padL + i * slot) + '" y="0" width="' + slot + '" height="' + (H - padB) +
          '" data-tip="' + esc(d.key.slice(5).replace("-", "/") + " · " + FX.won(d.value)) + '"/>'
      );
      if (i % labelEvery === 0) {
        parts.push(
          '<text class="chart__tick" x="' + (padL + i * slot + slot / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' +
            Number(d.key.slice(8)) + "</text>"
        );
      }
    });
    return (
      '<div class="chart"><svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="일별 지출">' +
      parts.join("") +
      '</svg><div class="chart__tip" hidden></div></div>'
    );
  };

  // 차트 툴팁 연결 (렌더 후 1회)
  SS.wireTips = function (root) {
    root.querySelectorAll(".chart").forEach(function (box) {
      var tip = box.querySelector(".chart__tip");
      function show(ev) {
        var t = ev.target.closest(".chart__hit");
        if (!t) return;
        tip.textContent = t.getAttribute("data-tip");
        tip.hidden = false;
        var br = box.getBoundingClientRect();
        var tr = t.getBoundingClientRect();
        var left = tr.left - br.left + tr.width / 2;
        tip.style.left = Math.max(40, Math.min(br.width - 40, left)) + "px";
        box.querySelectorAll(".chart__hit.is-on").forEach(function (h) {
          h.classList.remove("is-on");
        });
        t.classList.add("is-on");
      }
      box.addEventListener("pointermove", show);
      box.addEventListener("pointerdown", show);
      box.addEventListener("pointerleave", function () {
        tip.hidden = true;
      });
    });
  };

  // ---------------------------------------------------------------------
  // 여행 경비 정리 — 경비 탭 맨 위 요약 + 메신저에 붙여 넣을 글
  // ---------------------------------------------------------------------
  // krwFn(e): 원화 환산(환율 미등록이면 null). 일행 1인당은 정산(Settle)의 "부담액" 기준이라
  // 분담자를 고른 건까지 반영된다.
  SS.summary = function (book, entries, exchanges, krwFn) {
    entries = entries || [];
    exchanges = exchanges || [];
    var t = SS.total(entries, krwFn);
    var dates = {};
    entries.forEach(function (e) { if (e.date) dates[e.date] = 1; });
    var days = Object.keys(dates).length;
    if (book.start && book.end && book.end >= book.start) {
      days = Math.round((new Date(book.end + "T00:00:00") - new Date(book.start + "T00:00:00")) / 86400000) + 1;
    }
    var cats = SS.ranked(entries, function (e) { return e.category; }, krwFn).map(function (c) {
      return { key: c.key, value: Math.round(c.value), pct: t.total ? Math.round((c.value / t.total) * 100) : 0 };
    });
    var pay = { card: 0, cash: 0, unknown: 0 };
    var cur = {};
    var biggest = null;
    entries.forEach(function (e) {
      var k = krwFn(e);
      var c = e.currency || "KRW";
      cur[c] = cur[c] || { foreign: 0, krw: 0, missing: 0 };
      cur[c].foreign += e.total || 0;
      if (k == null) { cur[c].missing++; return; }
      cur[c].krw += k;
      pay[e.payMethod === "card" ? "card" : e.payMethod === "cash" ? "cash" : "unknown"] += k;
      if (!biggest || k > biggest.krw) biggest = { name: e.merchantKo || e.merchant || "(이름 없음)", krw: Math.round(k), date: e.date };
    });
    Object.keys(cur).forEach(function (c) {
      cur[c].krw = Math.round(cur[c].krw);
      cur[c].foreign = Math.round(cur[c].foreign * 100) / 100;
    });
    Object.keys(pay).forEach(function (k) { pay[k] = Math.round(pay[k]); });

    // 환전: 낸 원화 합 + 남은 현금(외화)과 그 원화 가치(가중평균 환율)
    var rates = FX.rates(exchanges);
    var left = FX.cashLeft(exchanges, entries);
    var fx = Object.keys(left).map(function (c) {
      var paid = exchanges.filter(function (x) { return x.currency === c; }).reduce(function (a, x) { return a + (x.krwAmount || 0); }, 0);
      var r = rates[c] ? rates[c].rate : null;
      return { currency: c, exchanged: left[c].exchanged, krwPaid: paid, left: left[c].left, leftKrw: r != null ? Math.round(left[c].left * r) : null };
    });

    var members = (book.members || []).filter(Boolean);
    var perPerson = null;
    if (members.length > 1 && global.Settle) {
      perPerson = Settle.compute(entries, members, krwFn).people.map(function (p) { return { name: p.name, owed: p.owed, paid: p.paid }; });
    }
    return {
      total: Math.round(t.total),
      missing: t.missing,
      count: entries.length,
      currencyLine: SS.currencyLine(entries),
      days: days,
      perDay: days ? Math.round(t.total / days) : 0,
      members: members.length || 1,
      perHead: Math.round(t.total / (members.length || 1)),
      perPerson: perPerson,
      categories: cats,
      pay: pay,
      currencies: cur,
      fx: fx,
      biggest: biggest,
    };
  };

  SS.summaryText = function (book, s) {
    var L = [];
    L.push("[" + book.name + "] 여행 경비 정리");
    if (book.start) L.push(book.start + (book.end ? " ~ " + book.end : "") + (s.days ? " (" + s.days + "일)" : ""));
    L.push("");
    L.push("총 경비 " + FX.won(s.total) + " · " + s.count + "건");
    if (s.currencyLine) L.push("(" + s.currencyLine + ")");
    if (s.days) L.push("하루 평균 " + FX.won(s.perDay));
    if (s.members > 1) L.push(s.members + "명 · 1인당 " + FX.won(s.perHead));
    if (s.categories.length) {
      L.push("");
      L.push("항목별");
      s.categories.forEach(function (c) { L.push("· " + c.key + " " + FX.won(c.value) + " (" + c.pct + "%)"); });
    }
    var payParts = [];
    if (s.pay.card) payParts.push("카드 " + FX.won(s.pay.card));
    if (s.pay.cash) payParts.push("현금 " + FX.won(s.pay.cash));
    if (s.pay.unknown) payParts.push("모름 " + FX.won(s.pay.unknown));
    if (payParts.length) L.push("", "결제 " + payParts.join(" / "));
    var foreign = Object.keys(s.currencies).filter(function (c) { return c !== "KRW"; });
    if (foreign.length) {
      L.push("");
      L.push("통화별");
      Object.keys(s.currencies).forEach(function (c) {
        var v = s.currencies[c];
        L.push("· " + (c === "KRW" ? FX.won(v.foreign) : FX.fmt(v.foreign, c) + " ≈ " + FX.won(v.krw)));
      });
    }
    s.fx.forEach(function (f) {
      L.push("환전 " + FX.fmt(f.exchanged, f.currency) + " (" + FX.won(f.krwPaid) + ") · 남은 현금 약 " + FX.fmt(f.left, f.currency) + (f.leftKrw != null ? " ≈ " + FX.won(f.leftKrw) : ""));
    });
    if (s.perPerson) {
      L.push("");
      L.push("사람별 부담");
      s.perPerson.forEach(function (p) { L.push("· " + p.name + " " + FX.won(p.owed) + " (낸 돈 " + FX.won(p.paid) + ")"); });
    }
    if (s.biggest) L.push("", "가장 큰 지출: " + s.biggest.name + " " + FX.won(s.biggest.krw));
    if (s.missing) L.push("", "※ 환율 미등록 " + s.missing + "건은 합계에서 빠짐");
    return L.join("\n");
  };

  global.Stats = SS;
})(this);
