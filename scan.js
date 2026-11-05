(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 영수증 인식 — 사진 압축 + Gemini 비전 1회 호출
  // ---------------------------------------------------------------------
  // 생 fetch로 부른다. 공식 SDK는 커스텀 헤더 때문에 브라우저 CORS preflight가 깨진다
  // (heart-translator에서 2026-08 실측). Content-Type만 보내면 file://에서도 통과한다.
  //
  // 무료 티어는 요청 수 제한이라 날짜·상호·항목·번역·카테고리를 **한 번에** 받는다.
  // 결과는 항상 사람이 확인·수정하는 화면을 거친다 — AI가 숫자를 틀릴 수 있으니
  // 여기서 "확정"하지 않는다.

  var SC = {};
  var TIMEOUT_MS = 90000;
  var MAX_SIDE = 1600;

  SC.CATEGORIES = ["숙박", "식비", "카페·간식", "교통", "관광·입장", "쇼핑", "기념품", "기타"];

  // ---------------------------------------------------------- 사진 압축
  // 폰 사진(4~12MB)을 그대로 저장·전송하면 IndexedDB도 무료 한도도 금방 닳는다.
  // 긴 변 1600px JPEG면 영수증 글씨는 충분히 읽힌다. EXIF 회전은 <img>가 알아서 반영한다.
  SC.compress = function (file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        var k = Math.min(1, MAX_SIDE / Math.max(w, h));
        var c = document.createElement("canvas");
        c.width = Math.round(w * k);
        c.height = Math.round(h * k);
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(
          function (blob) {
            if (blob) resolve(blob);
            else reject(new Error("사진을 변환하지 못했습니다."));
          },
          "image/jpeg",
          0.82
        );
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("사진을 열 수 없습니다. JPG·PNG 사진인지 확인해 주세요. (HEIC는 일부 브라우저에서 안 열립니다)"));
      };
      img.src = url;
    });
  };

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        resolve(String(r.result).split(",")[1]);
      };
      r.onerror = function () {
        reject(r.error);
      };
      r.readAsDataURL(blob);
    });
  }
  SC.blobToBase64 = blobToBase64;

  // ------------------------------------------------------------- 에러 안내
  function friendlyError(status, body) {
    var msg = "";
    try {
      var j = JSON.parse(body);
      msg = (j.error && (j.error.message || j.error)) || "";
    } catch (e) {
      msg = String(body || "").slice(0, 160);
    }
    if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) {
      return "API 키가 올바르지 않습니다. 설정에서 키를 다시 확인해 주세요.";
    }
    if (status === 401 || status === 403) return "키가 거부됐습니다(" + status + "). 키가 만료됐거나 권한이 없습니다.";
    if (status === 429) return "무료 사용량을 다 썼습니다. 잠시 뒤 다시 하거나 직접 입력해 주세요. (사진은 그대로 붙어 있습니다)";
    if (status === 404) return "그 모델을 찾을 수 없습니다. 설정에서 모델 이름을 확인해 주세요.";
    if (status >= 500) return "Gemini 서버 쪽 문제입니다(" + status + "). 잠시 뒤 다시 시도해 주세요.";
    return "인식 요청이 실패했습니다(" + status + "). " + msg;
  }

  // ------------------------------------------------------------- 프롬프트
  function buildPrompt(book) {
    var cats = SC.CATEGORIES;
    var curs = book.currencies || [];
    var curHint = curs.length
      ? "이 영수증은 여행 중 받은 것이다. 여행 통화 후보: " + curs.join(", ") + ", KRW."
      : "이 영수증은 한국 국내 여행 중 받은 것일 가능성이 높다(통화 KRW).";
    return [
      "너는 영수증 판독기다. 사진 속 영수증을 읽어 지정된 JSON 스키마로만 답한다.",
      curHint,
      "오늘 날짜는 " + new Date().toISOString().slice(0, 10) + "이다. 연도가 생략됐거나 두 자리면 이를 기준으로 추정한다.",
      "규칙:",
      "- date는 YYYY-MM-DD, time은 HH:MM(24시간). 일본 연호(令和7年 등)는 서기로 바꾼다. 못 읽으면 빈 문자열.",
      "- merchant는 영수증에 적힌 상호 원문 그대로, merchant_ko는 한국어 표기(원문이 한국어면 같게).",
      "- currency는 ISO 4217 코드(KRW, JPY, USD, EUR, THB, VND, TWD 등).",
      "- 금액은 모두 숫자(천 단위 구분기호·통화기호 없이). 소수점 통화는 소수점 유지.",
      "- items는 구매한 품목만. 소계·합계·세금·거스름돈·포인트·결제수단 줄은 넣지 않는다. amount는 그 품목 줄의 최종 금액(수량 반영).",
      "- name은 원문, name_ko는 자연스러운 한국어 번역(음식은 무엇인지 알 수 있게, 예: '唐揚げ' → '가라아게(닭튀김)').",
      "- total은 실제로 지불한 최종 금액(세금 포함, 할인 반영). tax는 별도 표기된 세금 합(내세 포함이면 표기된 세액), 없으면 0. discount는 할인 합의 절댓값, 없으면 0.",
      "- payment: 현금이면 cash, 카드/전자결제면 card, 모르면 unknown.",
      "- category는 다음 중 하나: " + cats.join(", ") + ".",
      "- address: 영수증에 인쇄된 가게 주소 원문 그대로(우편번호 제외). 없으면 빈 문자열.",
      "- map_query: 지도 검색에 넣을 짧은 검색어. 주소가 있으면 층·호수·건물 안내를 뺀 '도시 + 구/동 + 번지' 수준, 주소가 없으면 '상호 원문 + 지점명 + 도시'. 원문 언어로.",
      "- city: 가게가 있는 도시 이름(원문, 예: 大阪市, Bangkok, 제주시). 영수증과 상호로 추정 가능하면 채우고, 모르면 빈 문자열.",
      "- country: 가게가 있는 나라의 ISO 3166-1 alpha-2 코드(JP, KR, TH 등). 통화로 추정해도 된다.",
      "- 카드번호, 승인번호, 전화번호, 회원번호, 사업자번호 같은 개인·식별 정보는 어디에도 적지 않는다(가게 주소는 적어도 된다).",
      "- note: 사진이 흐리거나 잘려서 확신이 없는 부분이 있으면 한국어 한 문장으로. 없으면 빈 문자열.",
      "- 영수증이 아니면 total을 0으로 하고 note에 이유를 적는다.",
    ].join("\n");
  }

  function schema(book) {
    var cats = SC.CATEGORIES;
    return {
      type: "OBJECT",
      properties: {
        date: { type: "STRING" },
        time: { type: "STRING" },
        merchant: { type: "STRING" },
        merchant_ko: { type: "STRING" },
        currency: { type: "STRING" },
        items: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              name: { type: "STRING" },
              name_ko: { type: "STRING" },
              qty: { type: "NUMBER" },
              amount: { type: "NUMBER" },
            },
            required: ["name", "name_ko", "amount"],
          },
        },
        tax: { type: "NUMBER" },
        discount: { type: "NUMBER" },
        total: { type: "NUMBER" },
        payment: { type: "STRING", enum: ["cash", "card", "unknown"] },
        category: { type: "STRING", enum: cats },
        address: { type: "STRING" },
        map_query: { type: "STRING" },
        city: { type: "STRING" },
        country: { type: "STRING" },
        note: { type: "STRING" },
      },
      required: ["date", "merchant", "merchant_ko", "currency", "items", "total", "category"],
    };
  }

  // ----------------------------------------------------------- 결과 정규화
  // 모델이 스키마를 지켜도 "1,200" 같은 문자열 숫자나 엉뚱한 통화가 섞일 수 있다.
  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    var n = parseFloat(String(v || "").replace(/[^\d.\-]/g, ""));
    return isFinite(n) ? n : 0;
  }

  SC.normalize = function (raw, book) {
    raw = raw || {};
    var cats = SC.CATEGORIES;
    var cur = String(raw.currency || "").toUpperCase().trim();
    if (!/^[A-Z]{3}$/.test(cur)) cur = (book.currencies || [])[0] || "KRW";
    var country = String(raw.country || "").toUpperCase().trim();
    var date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date || "") ? raw.date : "";
    var time = /^\d{1,2}:\d{2}/.test(raw.time || "") ? String(raw.time).slice(0, 5).padStart(5, "0") : "";
    var items = (Array.isArray(raw.items) ? raw.items : []).map(function (it) {
      return {
        name: String(it.name || "").trim(),
        nameKo: String(it.name_ko || it.name || "").trim(),
        qty: num(it.qty) || 1,
        amount: num(it.amount),
      };
    });
    return {
      date: date,
      time: time,
      merchant: String(raw.merchant || "").trim(),
      merchantKo: String(raw.merchant_ko || raw.merchant || "").trim(),
      currency: cur,
      items: items,
      tax: num(raw.tax),
      discount: Math.abs(num(raw.discount)),
      total: num(raw.total),
      payMethod: raw.payment === "card" ? "card" : raw.payment === "cash" ? "cash" : "",
      category: cats.indexOf(raw.category) >= 0 ? raw.category : "기타",
      // 좌표는 아직 없다 — app이 Geo.locate로 주소를 좌표로 바꿔 lat/lng를 채운다.
      place: {
        address: String(raw.address || "").trim(),
        query: String(raw.map_query || "").trim(),
        city: String(raw.city || "").trim(),
        country: /^[A-Z]{2}$/.test(country) ? country : "",
      },
      note: String(raw.note || "").trim(),
    };
  };

  // 항목 합과 합계가 맞는지. 세금 별도·할인을 고려해 몇 가지 조합 중 하나라도 맞으면 OK.
  SC.checkSum = function (e) {
    if (!e.items || !e.items.length) return { ok: true, sum: 0 };
    var sum = e.items.reduce(function (a, it) {
      return a + num(it.amount);
    }, 0);
    var tol = Math.max(1, Math.abs(e.total) * 0.005);
    var cands = [sum, sum + num(e.tax), sum - num(e.discount), sum + num(e.tax) - num(e.discount)];
    var ok = cands.some(function (c) {
      return Math.abs(c - num(e.total)) <= tol;
    });
    return { ok: ok, sum: Math.round(sum * 100) / 100 };
  };

  // ------------------------------------------------------------- 공통 호출
  // 사진 1장 + 프롬프트 + 스키마 → 파싱된 JSON. 영수증·환전 캡처가 같이 쓴다.
  function callVision(blob, prompt, respSchema) {
    var s = Store.settings();
    if (!s.geminiKey) return Promise.reject(new Error("설정에서 Gemini API 키를 먼저 넣어 주세요."));
    return blobToBase64(blob).then(function (b64) {
      var url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(s.geminiModel || "gemini-2.5-flash") +
        ":generateContent?key=" +
        encodeURIComponent(s.geminiKey);
      var controller = new AbortController();
      var timer = setTimeout(function () {
        controller.abort();
      }, TIMEOUT_MS);
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ inline_data: { mime_type: blob.type || "image/jpeg", data: b64 } }, { text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: respSchema,
            maxOutputTokens: 8192,
          },
        }),
      }).then(
        function (res) {
          clearTimeout(timer);
          return res.text().then(function (body) {
            if (!res.ok) throw new Error(friendlyError(res.status, body));
            var data = JSON.parse(body);
            var cand = data.candidates && data.candidates[0];
            if (!cand) throw new Error("응답이 비어 있습니다. 다시 시도하거나 직접 입력해 주세요.");
            var text = ((cand.content && cand.content.parts) || [])
              .map(function (p) {
                return p.text || "";
              })
              .join("");
            if (!text) {
              if (cand.finishReason === "MAX_TOKENS") throw new Error("내용이 너무 길어 응답이 잘렸습니다. 직접 입력해 주세요.");
              throw new Error("인식 결과가 비어 있습니다(" + (cand.finishReason || "?") + ").");
            }
            try {
              return JSON.parse(text);
            } catch (e) {
              throw new Error("인식 결과를 해석하지 못했습니다. 다시 시도해 주세요.");
            }
          });
        },
        function (e) {
          clearTimeout(timer);
          if (e.name === "AbortError") throw new Error("응답이 너무 늦습니다(90초). 네트워크를 확인하고 다시 시도해 주세요.");
          throw new Error("Gemini에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.");
        }
      );
    });
  }

  SC.recognize = function (blob, book) {
    return callVision(blob, buildPrompt(book), schema(book)).then(function (raw) {
      var out = SC.normalize(raw, book);
      out.aiRaw = raw;
      return out;
    });
  };

  // ---------------------------------------------------------------------
  // 환전 캡처 인식 — 은행 앱 환전 완료 화면, 트래블카드 충전 내역, 환전 영수증
  // ---------------------------------------------------------------------
  // 한 장에 여러 건(충전 내역 목록)이 있을 수 있어 배열로 받는다.
  // 원화가 화면에 없고 환율만 있으면 외화 × 환율로 채운다. 엔화는 "100엔당"으로
  // 표시되는 일이 많아 모델에게 1단위 환율로 바꿔 달라고 하고, 그래도 크기가 이상하면 여기서 보정한다.
  function exPrompt(book) {
    return [
      "너는 환전 기록 판독기다. 사진은 은행·환전 앱의 환전 완료 화면, 트래블카드(트래블월렛·트래블로그 등) 충전/환전 내역, 또는 환전 영수증이다.",
      "외화를 산(환전·충전한) 거래만 exchanges 배열에 한 건씩 넣는다. 결제·출금·재환전(외화→원화 매도)·수수료 단독 줄은 넣지 않는다.",
      "이 여행의 통화 후보: " + (book.currencies || []).join(", ") + ". 오늘 날짜는 " + new Date().toISOString().slice(0, 10) + ".",
      "규칙:",
      "- currency: 받은 외화의 ISO 4217 코드.",
      "- foreign_amount: 받은 외화 금액(숫자만).",
      "- krw_amount: 그 외화를 사려고 실제로 낸 원화 총액(수수료 포함, 숫자만). 화면에 없으면 0.",
      "- rate: 외화 1단위당 원화 환율. 화면이 '100엔당 905원'처럼 100단위면 9.05로 바꾼다. 없으면 0.",
      "- date: YYYY-MM-DD. 없으면 빈 문자열.",
      "- provider: 은행·서비스 이름(예: 하나은행, 트래블월렛). 모르면 빈 문자열.",
      "- 계좌번호, 카드번호, 이름, 전화번호 같은 개인정보는 어디에도 적지 않는다.",
      "- note: 환전 기록이 아니거나 확신이 없는 부분이 있으면 한국어 한 문장. 없으면 빈 문자열.",
    ].join("\n");
  }

  var EX_SCHEMA = {
    type: "OBJECT",
    properties: {
      exchanges: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            date: { type: "STRING" },
            currency: { type: "STRING" },
            foreign_amount: { type: "NUMBER" },
            krw_amount: { type: "NUMBER" },
            rate: { type: "NUMBER" },
            provider: { type: "STRING" },
          },
          required: ["currency", "foreign_amount", "krw_amount"],
        },
      },
      note: { type: "STRING" },
    },
    required: ["exchanges"],
  };

  // 통화별 대략적인 1단위 원화 환율 범위(정상 판정용, 2026년 기준 여유 있게).
  // 모델이 100엔당 환율을 그대로 주는 실수를 잡는 데 쓴다.
  var RATE_HINT = { JPY: [5, 15], VND: [0.03, 0.09], IDR: [0.05, 0.13] };

  SC.normalizeExchanges = function (raw, book) {
    var list = (raw && Array.isArray(raw.exchanges) ? raw.exchanges : []).map(function (x) {
      var cur = String(x.currency || "").toUpperCase().trim();
      if (!/^[A-Z]{3}$/.test(cur)) cur = (book.currencies || ["USD"])[0];
      var fo = Math.abs(num(x.foreign_amount));
      var kr = Math.abs(num(x.krw_amount));
      var rate = Math.abs(num(x.rate));
      var h = RATE_HINT[cur];
      if (h && rate > h[1] * 50 && rate / 100 <= h[1]) rate = rate / 100; // 100단위 환율이 그대로 온 경우
      if (!kr && fo && rate) kr = Math.round(fo * rate);
      return {
        currency: cur,
        foreignAmount: fo,
        krwAmount: Math.round(kr),
        date: /^\d{4}-\d{2}-\d{2}$/.test(x.date || "") ? x.date : "",
        memo: String(x.provider || "").trim(),
      };
    });
    return {
      rows: list.filter(function (r) {
        return r.foreignAmount > 0;
      }),
      note: String((raw && raw.note) || "").trim(),
    };
  };

  // 이미 등록된 것과 같은 건(통화·외화·원화 일치, 날짜는 둘 다 있을 때만 비교)은 중복으로 본다.
  // 같은 캡처를 두 번 올리는 실수가 흔해서.
  SC.isDuplicateExchange = function (row, existing) {
    return (existing || []).some(function (x) {
      return (
        x.currency === row.currency &&
        Math.abs(x.foreignAmount - row.foreignAmount) < 0.01 &&
        Math.abs(x.krwAmount - row.krwAmount) < 1 &&
        (!x.date || !row.date || x.date === row.date)
      );
    });
  };

  SC.recognizeExchange = function (blob, book) {
    return callVision(blob, exPrompt(book), EX_SCHEMA).then(function (raw) {
      return SC.normalizeExchanges(raw, book);
    });
  };

  global.Scan = SC;
})(this);
