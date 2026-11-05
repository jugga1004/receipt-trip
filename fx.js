(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 원화 환산 — 시장 환율이 아니라 "내가 실제로 바꾼 값"이 기준이다.
  // ---------------------------------------------------------------------
  // 환전을 여러 번 했으면 통화별 가중평균: Σ 원화 / Σ 외화.
  // 카드 결제는 나중에 청구된 원화를 알면 그 값을 건별로 덮어쓴다(krwOverride),
  // 환율만 알면 rateOverride.
  // 환율을 모르는 통화는 0으로 치지 않고 null을 돌려준다 — 합계에서 빠졌다는 걸
  // 화면이 알려줄 수 있게. 0으로 섞으면 총액이 조용히 틀린다.

  var FX = {};

  FX.rates = function (exchanges) {
    var acc = {};
    (exchanges || []).forEach(function (x) {
      var c = x.currency;
      if (!c || !(x.foreignAmount > 0) || !(x.krwAmount > 0)) return;
      acc[c] = acc[c] || { foreign: 0, krw: 0, count: 0 };
      acc[c].foreign += x.foreignAmount;
      acc[c].krw += x.krwAmount;
      acc[c].count += 1;
    });
    Object.keys(acc).forEach(function (c) {
      acc[c].rate = acc[c].krw / acc[c].foreign;
    });
    return acc;
  };

  // 이 건에 적용된 1단위당 원화 환율. 알 수 없으면 null.
  FX.rateOf = function (entry, rates) {
    if (!entry.currency || entry.currency === "KRW") return 1;
    if (entry.krwOverride > 0 && entry.total) return entry.krwOverride / entry.total;
    if (entry.rateOverride > 0) return entry.rateOverride;
    var r = rates && rates[entry.currency];
    return r ? r.rate : null;
  };

  FX.krw = function (entry, rates) {
    if (!entry.currency || entry.currency === "KRW") return entry.total || 0;
    if (entry.krwOverride > 0) return entry.krwOverride;
    var rate = FX.rateOf(entry, rates);
    return rate == null ? null : Math.round((entry.total || 0) * rate);
  };

  // 해당 가계부에서 쓰는 krw 함수(정산·통계에 넘긴다)
  FX.krwFn = function (exchanges) {
    var r = FX.rates(exchanges);
    return function (e) {
      return FX.krw(e, r);
    };
  };

  // 현금 잔액 추정: 통화별 환전액 − 현금 지출(외화 기준).
  // 카드 결제는 환전한 돈을 쓰지 않으므로 빼지 않는다. 결제수단 미상은 현금으로 본다
  // (여행지 소액 영수증은 대부분 현금이라서). 화면에 이 가정을 같이 적는다.
  FX.cashLeft = function (exchanges, entries) {
    var out = {};
    (exchanges || []).forEach(function (x) {
      out[x.currency] = out[x.currency] || { exchanged: 0, spent: 0 };
      out[x.currency].exchanged += x.foreignAmount || 0;
    });
    (entries || []).forEach(function (e) {
      if (!out[e.currency] || e.payMethod === "card") return;
      out[e.currency].spent += e.total || 0;
    });
    Object.keys(out).forEach(function (c) {
      out[c].left = Math.round((out[c].exchanged - out[c].spent) * 100) / 100;
    });
    return out;
  };

  // ---------------------------------------------------------------- 표시
  var DECIMALS = { KRW: 0, JPY: 0, VND: 0, IDR: 0, TWD: 0, HUF: 0, CLP: 0, ISK: 0 };

  var PER100 = { JPY: 1, VND: 1, IDR: 1 };

  FX.decimals = function (cur) {
    return cur in DECIMALS ? DECIMALS[cur] : 2;
  };

  FX.fmt = function (n, cur) {
    if (n == null || isNaN(n)) return "—";
    var d = FX.decimals(cur);
    var s = Number(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
    return cur === "KRW" || !cur ? s + "원" : s + " " + cur;
  };

  FX.won = function (n) {
    return FX.fmt(n, "KRW");
  };

  FX.fmtRate = function (rate, cur) {
    if (rate == null) return "환율 미등록";
    // 엔·동·루피아는 은행 고시처럼 100단위로 보여야 감이 온다("100엔 = 910원").
    if (PER100[cur] || rate < 1) return "100 " + cur + " = " + (rate * 100).toLocaleString("ko-KR", { maximumFractionDigits: 2 }) + "원";
    return "1 " + cur + " = " + rate.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) + "원";
  };

  global.FX = FX;
})(this);
