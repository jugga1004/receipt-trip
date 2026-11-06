(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 원화 환산 — 시장 환율이 아니라 "내가 실제로 바꾼 값"이 기준이다.
  // ---------------------------------------------------------------------
  // 환전을 여러 번 했으면 통화별 가중평균: Σ 원화 / Σ 외화.
  // 신용카드 결제는 나중에 청구된 원화를 알면 그 값을 건별로 덮어쓴다(krwOverride),
  // 환율만 알면 rateOverride.
  // 환율을 모르는 통화는 0으로 치지 않고 null을 돌려준다 — 합계에서 빠졌다는 걸
  // 화면이 알려줄 수 있게. 0으로 섞으면 총액이 조용히 틀린다.

  var FX = {};

  FX.rates = function (exchanges) {
    var acc = {};
    (exchanges || []).forEach(function (x) {
      var c = x.currency;
      // 인출(트래블카드→현금)은 새로 산 외화가 아니라 지갑 이동이라 환율 계산에서 뺀다
      if (!c || x.kind === "withdraw" || !(x.foreignAmount > 0) || !(x.krwAmount > 0)) return;
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

  // ---------------------------------------------------------- 결제수단·잔액
  // 요즘 여행 환전은 대부분 트래블카드(트래블월렛·트래블로그 등) 충전이라, "카드 = 환전한 외화에서 빠져나가는
  // 체크카드"로 본다. 원화로 따로 청구되는 신용카드만 환전 잔액에서 빼지 않는다.
  //   travel: 트래블카드(충전한 외화에서 차감)  cash: 현금  credit: 신용카드(원화 청구)  "": 모름
  // 예전 기록의 "card"는 트래블카드로 읽는다(사용자 확인, 2026-11-06).
  FX.PAY = { travel: "트래블카드", cash: "현금", credit: "신용카드" };
  FX.payKind = function (m) {
    if (m === "card") return "travel";
    return FX.PAY[m] ? m : "";
  };
  // 환전 기록이 어디로 갔나: travel(트래블카드 충전) | cash(현금 환전). 예전 기록(값 없음)은 트래블카드.
  FX.WALLET = { travel: "트래블카드", cash: "현금" };
  // kind: "withdraw" = 트래블카드에서 현금 인출(트래블카드 −, 현금 +). 원화를 새로 낸 게 아님
  FX.isWithdraw = function (x) {
    return !!x && x.kind === "withdraw";
  };
  FX.walletOf = function (x) {
    return x && x.to === "cash" ? "cash" : "travel";
  };

  // 통화별 지갑 잔액(외화 기준): { JPY: { travel:{in,out,left}, cash:{in,out,left}, credit, unknown } }
  // 결제수단을 모르는 지출은 그 통화에 트래블카드 충전이 있으면 트래블카드, 없으면 현금에서 뺀다.
  FX.wallets = function (exchanges, entries) {
    var out = {};
    var cell = function (c) {
      out[c] = out[c] || { travel: { in: 0, out: 0 }, cash: { in: 0, out: 0 }, credit: 0, unknown: 0 };
      return out[c];
    };
    (exchanges || []).forEach(function (x) {
      if (!x.currency) return;
      var c = cell(x.currency);
      if (FX.isWithdraw(x)) {
        c.travel.out += x.foreignAmount || 0;
        c.cash.in += x.foreignAmount || 0;
        c.withdrawn = (c.withdrawn || 0) + (x.foreignAmount || 0);
        return;
      }
      c[FX.walletOf(x)].in += x.foreignAmount || 0;
    });
    (entries || []).forEach(function (e) {
      if (!e.currency || e.currency === "KRW" || !out[e.currency]) return;
      var o = out[e.currency];
      var k = FX.payKind(e.payMethod);
      var amt = e.total || 0;
      if (k === "credit") return void (o.credit += amt);
      if (!k) {
        o.unknown += amt;
        k = o.travel.in > 0 ? "travel" : "cash";
      }
      o[k].out += amt;
    });
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    Object.keys(out).forEach(function (c) {
      ["travel", "cash"].forEach(function (w) {
        out[c][w].left = r2(out[c][w].in - out[c][w].out);
      });
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
