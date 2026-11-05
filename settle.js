(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 일행 정산(N빵) — 원화 기준
  // ---------------------------------------------------------------------
  // 각 지출: 결제자(payer)가 냈고, 분담자(splitAmong, 비어 있으면 일행 전원)가 똑같이 나눠 진다.
  // 사람별 차액 = 낸 돈 − 부담할 돈. 양수면 받을 사람, 음수면 보낼 사람.
  // 송금 목록은 가장 많이 받을 사람 ↔ 가장 많이 보낼 사람을 차례로 맞추는 탐욕 매칭.
  // 사람 n명이면 송금은 최대 n−1건이라 일행 여행 규모에선 충분히 짧다.
  // 원화 환산이 안 되는 건(환율 미등록)은 빼고, 몇 건 빠졌는지 돌려준다.

  var ST = {};

  ST.compute = function (entries, members, krwFn) {
    members = (members || []).filter(Boolean);
    var paid = {};
    var owed = {};
    members.forEach(function (m) {
      paid[m] = 0;
      owed[m] = 0;
    });
    var skipped = 0;

    (entries || []).forEach(function (e) {
      var amt = krwFn(e);
      if (amt == null) {
        skipped++;
        return;
      }
      var payer = e.payer && e.payer in paid ? e.payer : members[0];
      var among = (e.splitAmong && e.splitAmong.length ? e.splitAmong : members).filter(function (m) {
        return m in owed;
      });
      if (!payer || !among.length) return;
      paid[payer] += amt;
      var share = amt / among.length;
      among.forEach(function (m) {
        owed[m] += share;
      });
    });

    var people = members.map(function (m) {
      return { name: m, paid: Math.round(paid[m]), owed: Math.round(owed[m]), net: Math.round(paid[m] - owed[m]) };
    });

    // 반올림으로 생긴 1~2원 차이 때문에 "0원 송금"이 생기지 않게 1원 미만은 버린다.
    var cred = people.filter(function (p) { return p.net > 0; }).map(function (p) { return { name: p.name, v: p.net }; });
    var debt = people.filter(function (p) { return p.net < 0; }).map(function (p) { return { name: p.name, v: -p.net }; });
    cred.sort(function (a, b) { return b.v - a.v; });
    debt.sort(function (a, b) { return b.v - a.v; });

    var transfers = [];
    var i = 0;
    var j = 0;
    while (i < debt.length && j < cred.length) {
      var x = Math.min(debt[i].v, cred[j].v);
      if (x >= 1) transfers.push({ from: debt[i].name, to: cred[j].name, amount: Math.round(x) });
      debt[i].v -= x;
      cred[j].v -= x;
      if (debt[i].v < 1) i++;
      if (cred[j].v < 1) j++;
    }

    return { people: people, transfers: transfers, skipped: skipped };
  };

  ST.toText = function (bookName, result) {
    var lines = ["[" + bookName + "] 정산"];
    result.people.forEach(function (p) {
      lines.push("· " + p.name + ": 낸 돈 " + FX.won(p.paid) + " / 부담 " + FX.won(p.owed));
    });
    lines.push("");
    if (!result.transfers.length) lines.push("보낼 돈이 없습니다.");
    result.transfers.forEach(function (t) {
      lines.push(t.from + " → " + t.to + "  " + FX.won(t.amount));
    });
    if (result.skipped) lines.push("", "※ 환율 미등록 " + result.skipped + "건은 제외됨");
    return lines.join("\n");
  };

  global.Settle = ST;
})(this);
