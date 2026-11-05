(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 내보내기 — CSV(엑셀용)와 JSON 백업
  // ---------------------------------------------------------------------
  // 엑셀은 BOM 없는 UTF-8 CSV를 한글 깨진 채로 연다. 그래서 맨 앞에 BOM을 붙인다.
  // 백업은 이 기기에만 데이터가 있다는 약점을 메우는 유일한 수단이라 사진 포함 여부를 고르게 한다.

  var CX = {};
  var BOM = "﻿";

  function cell(v) {
    if (v == null) return "";
    var s = String(v);
    // 엑셀 수식 주입 방지: =, +, -, @ 로 시작하는 문자열은 앞에 '를 붙인다(숫자는 제외)
    if (typeof v === "string" && /^[=+\-@]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  CX.row = function (arr) {
    return arr.map(cell).join(",");
  };

  CX.entriesCsv = function (book, entries, krwFn, rateFn) {
    var trip = book.type === "trip";
    var head = ["날짜", "시각", "상호(원문)", "상호(한국어)", "카테고리", "통화", "금액", "적용환율", "원화", "결제수단"];
    if (trip) head.push("결제자", "분담자");
    head.push("항목", "메모", "주소", "위치", "위도", "경도");
    var lines = [CX.row(head)];
    entries
      .slice()
      .sort(function (a, b) {
        return (a.date + a.time).localeCompare(b.date + b.time);
      })
      .forEach(function (e) {
        var rate = rateFn(e);
        var krw = krwFn(e);
        var row = [
          e.date,
          e.time,
          e.merchant,
          e.merchantKo,
          e.category,
          e.currency,
          e.total,
          rate == null ? "" : Math.round(rate * 10000) / 10000,
          krw == null ? "" : krw,
          e.payMethod === "card" ? "카드" : e.payMethod === "cash" ? "현금" : "",
        ];
        if (trip) row.push(e.payer || "", (e.splitAmong && e.splitAmong.length ? e.splitAmong : book.members || []).join("/"));
        row.push(
          (e.items || [])
            .map(function (it) {
              return (it.nameKo || it.name) + (it.qty > 1 ? "×" + it.qty : "") + " " + it.amount;
            })
            .join("; "),
          e.memo || "",
          (e.place && e.place.address) || "",
          (e.place && e.place.label) || "",
          e.place && e.place.lat != null ? Math.round(e.place.lat * 1e6) / 1e6 : "",
          e.place && e.place.lng != null ? Math.round(e.place.lng * 1e6) / 1e6 : ""
        );
        lines.push(CX.row(row));
      });
    return BOM + lines.join("\r\n");
  };

  CX.download = function (filename, text, type) {
    var blob = text instanceof Blob ? text : new Blob([text], { type: type || "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  };

  CX.safeName = function (s) {
    return String(s || "가계부").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  };

  // ------------------------------------------------------------ JSON 백업
  CX.backup = function (withPhotos) {
    return Promise.all(["books", "entries", "exchanges"].map(Store.all)).then(function (r) {
      var data = { app: "receipt-book", version: 1, exportedAt: new Date().toISOString(), books: r[0], entries: r[1], exchanges: r[2], photos: [] };
      if (!withPhotos) {
        data.entries = data.entries.map(function (e) {
          return Object.assign({}, e, { photoId: null });
        });
        return data;
      }
      return Store.all("photos").then(function (ps) {
        return Promise.all(
          ps.map(function (p) {
            return Scan.blobToBase64(p.blob).then(function (b64) {
              return { id: p.id, type: p.blob.type, data: b64 };
            });
          })
        ).then(function (arr) {
          data.photos = arr;
          return data;
        });
      });
    });
  };

  function b64ToBlob(b64, type) {
    var bin = atob(b64);
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: type || "image/jpeg" });
  }

  // 복원은 덮어쓰기가 아니라 합치기(id가 같으면 갱신). 다른 기기 기록을 합칠 때도 안전하게.
  CX.restore = function (data) {
    if (!data || data.app !== "receipt-book") return Promise.reject(new Error("이 앱의 백업 파일이 아닙니다."));
    var jobs = [];
    (data.books || []).forEach(function (b) { jobs.push(Store.put("books", b)); });
    (data.entries || []).forEach(function (e) { jobs.push(Store.put("entries", e)); });
    (data.exchanges || []).forEach(function (x) { jobs.push(Store.put("exchanges", x)); });
    (data.photos || []).forEach(function (p) { jobs.push(Store.put("photos", { id: p.id, blob: b64ToBlob(p.data, p.type) })); });
    return Promise.all(jobs).then(function () {
      return { books: (data.books || []).length, entries: (data.entries || []).length };
    });
  };

  global.CSVX = CX;
})(this);
