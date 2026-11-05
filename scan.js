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
  var RETRY_503 = 1; // 모델마다 1번 더(3초 뒤), 그래도 붐비면 다음 모델
  // 모델: 2026-11 실측 — 2.5-flash는 "새 사용자에겐 제공 안 함"(404),
  // 3.8-flash는 503(붐빔)이 잦고 3.5-flash는 바로 응답 → 3.5를 먼저, 붐비면 3.8로 넘어간다.
  SC.MODELS = ["gemini-3.5-flash", "gemini-3.8-flash"];
  SC.DEFAULT_MODEL = SC.MODELS[0];

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
  function friendlyError(status, body, viaProxy) {
    var msg = "";
    try {
      var j = JSON.parse(body);
      msg = (j.error && (j.error.message || j.error)) || "";
    } catch (e) {
      msg = String(body || "").slice(0, 160);
    }
    if (viaProxy) {
      // 공용 인식 서버(운영자 키) 경유 — 사용자가 고칠 수 없는 문제는 직접 입력을 안내한다
      if (status === 429) return "지금 인식 요청이 몰려 잠시 쉬어야 합니다. 1분쯤 뒤 다시 하거나 직접 입력해 주세요. (사진은 그대로 붙어 있습니다)";
      if (status === 413) return "사진이 너무 큽니다. 다른 사진으로 시도해 주세요.";
      if (status === 451) return "인식 서버가 지금 Gemini를 쓸 수 없는 지역으로 연결됐습니다. 잠시 뒤 다시 하거나 직접 입력해 주세요. (사진은 그대로 붙어 있습니다)";
      if (status === 400 && /모델/.test(msg)) return msg;
      if (status === 400 && /API key|API_KEY/i.test(msg)) return "공용 인식 서버 설정에 문제가 있습니다. 운영자에게 알려 주세요. 지금은 직접 입력해 주세요.";
      if (status === 401 || status === 403) return "공용 인식 서버가 요청을 거부했습니다(" + status + "). 운영자에게 알려 주세요.";
      if (status === 503) return "Gemini가 지금 붐벼서 응답하지 못했습니다. 몇 분 뒤 다시 하거나 직접 입력해 주세요. (사진은 그대로 붙어 있습니다)";
      if (status >= 500) return "인식 서버 쪽 문제입니다(" + status + "). 잠시 뒤 다시 시도해 주세요.";
      return "인식 요청이 실패했습니다(" + status + "). " + msg;
    }
    if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) {
      return "API 키가 올바르지 않습니다. 설정에서 키를 다시 확인해 주세요.";
    }
    if (status === 401 || status === 403) return "키가 거부됐습니다(" + status + "). 키가 만료됐거나 권한이 없습니다.";
    if (status === 429) return "무료 사용량을 다 썼습니다. 잠시 뒤 다시 하거나 직접 입력해 주세요. (사진은 그대로 붙어 있습니다)";
    if (status === 404) return "그 모델을 찾을 수 없습니다. 설정에서 모델 이름을 확인해 주세요.";
    if (status === 503) return "Gemini가 지금 붐벼서 응답하지 못했습니다. 몇 분 뒤 다시 하거나 직접 입력해 주세요. (사진은 그대로 붙어 있습니다)";
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
  // 내 키가 있으면 Gemini로 직접, 없으면 운영자 중계 서버(config.js의 proxyUrl, proxy/worker.js)로.
  // 중계 서버는 flash 계열 모델만 받는다.
  function callVision(blob, prompt, respSchema) {
    var s = Store.settings();
    var proxy = Store.proxyUrl();
    if (!s.geminiKey && !proxy) return Promise.reject(new Error("설정에서 Gemini API 키를 먼저 넣어 주세요."));
    var viaProxy = !s.geminiKey;
    return blobToBase64(blob).then(function (b64) {
      // 시도할 모델 순서: (내 키면 설정의 모델 →) 기본 모델 → 예비 모델. 붐비면(503) 다음 모델로 넘어간다.
      var models = [];
      (viaProxy ? [] : [s.geminiModel]).concat(SC.MODELS).forEach(function (m) {
        if (m && models.indexOf(m) < 0) models.push(m);
      });
      var urlFor = function (m) {
        m = encodeURIComponent(m);
        return viaProxy
          ? proxy + "/models/" + m + ":generateContent"
          : "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent?key=" + encodeURIComponent(s.geminiKey);
      };
      var payload = JSON.stringify({
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
      });
      // 503(모델이 붐빔)·451(중계 서버가 Gemini 불가 지역에서 실행됨)은 잠깐 뒤 풀리는 일이 많아
      // 3초·6초 뒤 두 번까지 다시 보낸다.
      // (2026-11 실측: gemini-3.8-flash가 연달아 503 "high demand")
      function attempt(n, mi) {
        var controller = new AbortController();
        var timer = setTimeout(function () {
          controller.abort();
        }, TIMEOUT_MS);
        return fetch(urlFor(models[mi]), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: payload,
        }).then(
          function (res) {
            clearTimeout(timer);
            var busy = res.status === 503 || res.status === 451;
            if (busy && mi + 1 < models.length) return attempt(0, mi + 1); // 이 모델은 포기하고 예비 모델로
            if (busy && n < RETRY_503) {
              return new Promise(function (r) { setTimeout(r, 3000 * (n + 1)); }).then(function () {
                return attempt(n + 1, mi);
              });
            }
            return res.text().then(function (body) {
              if (!res.ok) throw new Error(friendlyError(res.status, body, viaProxy));
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
            throw new Error(viaProxy ? "인식 서버에 연결하지 못했습니다. 인터넷 연결을 확인하거나 잠시 뒤 다시 시도해 주세요." : "Gemini에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.");
          }
        );
      }
      return attempt(0, 0);
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

  // ---------------------------------------------------------------------
  // 예약 캡처 → 새 여행 자동 채우기
  // ---------------------------------------------------------------------
  // 항공 예약, 기차(KTX·SRT·신칸센), 고속버스, 배, 렌터카, 숙소 예약 화면이나 확인 메일을 읽어
  // 일정 조각(legs)을 뽑는다. 여러 장을 합쳐 여행지·기간을 판단한다.
  // 승객 이름·예약번호·좌석·연락처는 받지 않는다.
  function legsPrompt() {
    return [
      "너는 여행 예약 판독기다. 사진은 항공 예약, 기차(KTX·SRT·신칸센 등), 고속·시외버스, 배(페리), 렌터카, 숙소(호텔·에어비앤비) 예약 화면이나 확인 메일이다.",
      "예약된 일정 조각마다 legs 배열에 한 건씩 넣는다. 왕복이면 가는 편·오는 편을 따로 넣는다. 오늘 날짜는 " + new Date().toISOString().slice(0, 10) + "이다.",
      "규칙:",
      "- type: flight(항공), train(기차), bus(버스), ship(배), car(렌터카), stay(숙소) 중 하나.",
      "- date: 출발(숙소는 체크인, 렌터카는 대여) 현지 날짜 YYYY-MM-DD. 연도가 없으면 오늘 이후 가장 가까운 날로 추정.",
      "- end_date: 숙소는 체크아웃, 렌터카는 반납 날짜. 그 외에는 빈 문자열.",
      "- time: 출발(체크인·대여) 현지 시각 HH:MM(24시간). 없으면 빈 문자열.",
      "- from_city_ko: 출발 도시의 한국어 이름(예: 인천, 서울, 오사카). 숙소·렌터카는 빈 문자열.",
      "- to_city_ko: 도착 도시의 한국어 이름. 숙소·렌터카는 그 장소가 있는 도시.",
      "- from_code, to_code: 항공이면 IATA 공항 코드(ICN, KIX 등), 아니면 빈 문자열.",
      "- to_country: to_city_ko가 있는 나라의 ISO 3166-1 alpha-2 코드(KR, JP, TH 등).",
      "- name: 편명·열차명·숙소 이름 등(예: KE723, KTX 101, 힐튼 오사카). company: 항공사·철도·회사 이름.",
      "- 승객·투숙객 이름, 예약번호, 좌석번호, 항공권 번호, 연락처, 결제 카드 정보는 어디에도 적지 않는다.",
      "- note: 예약 정보가 아니거나 확신이 없는 부분이 있으면 한국어 한 문장. 없으면 빈 문자열.",
    ].join("\n");
  }

  var LEG_TYPES = ["flight", "train", "bus", "ship", "car", "stay"];
  var LEGS_SCHEMA = {
    type: "OBJECT",
    properties: {
      legs: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            type: { type: "STRING", enum: LEG_TYPES },
            date: { type: "STRING" },
            end_date: { type: "STRING" },
            time: { type: "STRING" },
            from_city_ko: { type: "STRING" },
            to_city_ko: { type: "STRING" },
            from_code: { type: "STRING" },
            to_code: { type: "STRING" },
            to_country: { type: "STRING" },
            name: { type: "STRING" },
            company: { type: "STRING" },
          },
          required: ["type", "date", "to_city_ko"],
        },
      },
      note: { type: "STRING" },
    },
    required: ["legs"],
  };
  SC.LEG_ICON = { flight: "✈", train: "🚄", bus: "🚌", ship: "⛴", car: "🚗", stay: "🏨" };

  // 나라 → 여행 통화. 한국은 외화 없음(국내 여행).
  var EURO = "AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK".split(" ");
  var COUNTRY_CUR = {
    JP: "JPY", US: "USD", GU: "USD", MP: "USD", CN: "CNY", TW: "TWD", HK: "HKD", MO: "HKD", TH: "THB", VN: "VND", PH: "PHP",
    SG: "SGD", MY: "MYR", ID: "IDR", GB: "GBP", AU: "AUD", CA: "CAD", CH: "CHF", NZ: "NZD",
  };
  SC.currencyOf = function (country) {
    country = String(country || "").toUpperCase();
    if (country === "KR" || !country) return "";
    if (EURO.indexOf(country) >= 0) return "EUR";
    return COUNTRY_CUR[country] || "";
  };

  // 인식 결과 → 정리된 일정 조각 [{type,date,endDate,time,fromCity,toCity,from,to,toCountry,name,company}]
  SC.normalizeLegs = function (raw) {
    var ymd = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s : ""; };
    var list = (raw && Array.isArray(raw.legs) ? raw.legs : []).map(function (f) {
      return {
        type: LEG_TYPES.indexOf(f.type) >= 0 ? f.type : "flight",
        date: ymd(f.date),
        endDate: ymd(f.end_date),
        time: /^\d{1,2}:\d{2}/.test(f.time || "") ? String(f.time).slice(0, 5).padStart(5, "0") : "",
        fromCity: String(f.from_city_ko || "").trim(),
        toCity: String(f.to_city_ko || "").trim(),
        from: String(f.from_code || "").toUpperCase().trim(),
        to: String(f.to_code || "").toUpperCase().trim(),
        toCountry: String(f.to_country || "").toUpperCase().trim(),
        name: String(f.name || "").trim(),
        company: String(f.company || "").trim(),
      };
    }).filter(function (f) { return f.date && (f.toCity || f.to); });
    return { legs: list, note: String((raw && raw.note) || "").trim() };
  };

  // 같은 조각(종류+날짜+이름, 이름 없으면 종류+날짜+도착지)이 여러 장에 겹쳐 나오면 하나로
  SC.mergeLegs = function (a, b) {
    var out = (a || []).slice();
    (b || []).forEach(function (f) {
      var dup = out.some(function (g) {
        if (g.type !== f.type || g.date !== f.date) return false;
        return f.name && g.name ? g.name === f.name : g.toCity === f.toCity && g.fromCity === f.fromCity;
      });
      if (!dup) out.push(f);
    });
    // 시각이 없으면 숙소는 체크인(15:00), 나머지는 정오로 보고 정렬 — 같은 날 "숙소"가 "가는 비행기"보다 앞서지 않게
    var key = function (f) { return f.date + (f.time || (f.type === "stay" ? "15:00" : "12:00")); };
    return out.sort(function (x, y) { return key(x).localeCompare(key(y)); });
  };

  // 일정 조각 →{start, end, home, dest, places[], currencies[], name}
  // 기간: 가장 이른 날 ~ 가장 늦은 날(숙소 체크아웃·렌터카 반납 포함).
  // 출발지(집) = 첫 이동 조각의 출발 도시. 여행지 = 집이 아닌 도착 도시들(나온 순서).
  SC.tripFromLegs = function (legs) {
    if (!legs || !legs.length) return null;
    var moves = legs.filter(function (f) { return f.type !== "stay" && f.type !== "car"; });
    var firstMove = moves[0];
    var home = firstMove ? firstMove.fromCity || firstMove.from : "";
    var homeCode = firstMove ? firstMove.from : "";
    var isHome = function (f) { return (home && f.toCity === home) || (homeCode && f.to === homeCode); };
    var places = [];
    var curs = [];
    legs.forEach(function (f) {
      if (isHome(f)) return;
      var c = f.toCity || f.to;
      if (c && places.indexOf(c) < 0) places.push(c);
      var cur = SC.currencyOf(f.toCountry);
      if (cur && curs.indexOf(cur) < 0) curs.push(cur);
    });
    var dates = [];
    legs.forEach(function (f) { dates.push(f.date); if (f.endDate) dates.push(f.endDate); });
    dates.sort();
    var start = dates[0];
    var end = dates[dates.length - 1];
    var month = Number(start.slice(5, 7));
    var nights = Math.round((new Date(end + "T00:00:00") - new Date(start + "T00:00:00")) / 86400000);
    var label = places.slice(0, 2).join("·") || (legs[0].toCity || legs[0].to);
    return {
      start: start,
      end: end,
      home: home,
      dest: places.join(", "),
      places: places,
      currencies: curs,
      name: month + "월 " + label + (nights >= 1 && nights <= 14 ? " " + nights + "박 " + (nights + 1) + "일" : ""),
    };
  };

  // 여행지 글자(나라·도시 한국어 이름) → 나라 코드 목록. "도쿄·방콕"처럼 여러 곳이면 여러 개.
  // 한두 글자짜리 흔한 말과 겹치는 이름(나라·빈·니스)은 넣지 않는다 — "테니스"가 프랑스가 되지 않게.
  var PLACE_COUNTRY = [
    ["KR", "한국 국내 제주 서귀포 부산 강릉 속초 서울 경주 여수 전주 통영 거제 남해 포항 대구 광주 인천 춘천 양양 울릉 안동"],
    ["JP", "일본 도쿄 동경 오사카 교토 고베 후쿠오카 삿포로 홋카이도 오키나와 나고야 가고시마 요코하마 히로시마 구마모토 벳푸 유후인 오이타 다카마쓰 마쓰야마 시즈오카 센다이 하코다테 오타루 나가사키 미야자키 니가타 가나자와 하카타"],
    ["US", "미국 뉴욕 엘에이 로스앤젤레스 샌프란시스코 하와이 호놀룰루 라스베이거스 시애틀 시카고 보스턴 워싱턴 마이애미 올랜도 샌디에이고"],
    ["GU", "괌"], ["MP", "사이판"],
    ["CN", "중국 베이징 북경 상하이 상해 칭다오 청도 장자제 장가계 시안 광저우 선전 하얼빈 다롄 대련 청두"],
    ["TW", "대만 타이베이 타이페이 가오슝 타이중 타이난 화롄"],
    ["HK", "홍콩"], ["MO", "마카오"],
    ["TH", "태국 방콕 치앙마이 푸켓 파타야 끄라비 코사무이"],
    ["VN", "베트남 다낭 하노이 호치민 나트랑 냐짱 푸꾸옥 달랏 호이안 하롱"],
    ["PH", "필리핀 세부 마닐라 보라카이 보홀 클락"],
    ["SG", "싱가포르"],
    ["MY", "말레이시아 쿠알라룸푸르 코타키나발루 페낭 랑카위"],
    ["ID", "인도네시아 발리 자카르타 롬복"],
    ["GB", "영국 런던 에든버러 맨체스터"],
    ["AU", "호주 시드니 멜버른 브리즈번 골드코스트 케언즈 퍼스"],
    ["CA", "캐나다 밴쿠버 토론토 몬트리올 캘거리 퀘벡"],
    ["CH", "스위스 취리히 인터라켄 제네바 루체른 체르마트"],
    ["NZ", "뉴질랜드 오클랜드 퀸스타운 크라이스트처치"],
    ["FR", "프랑스 파리 리옹 마르세유"], ["DE", "독일 베를린 뮌헨 프랑크푸르트 함부르크"],
    ["IT", "이탈리아 로마 밀라노 베네치아 베니스 피렌체 나폴리"], ["ES", "스페인 바르셀로나 마드리드 세비야 그라나다"],
    ["PT", "포르투갈 리스본 포르투"], ["NL", "네덜란드 암스테르담"], ["AT", "오스트리아 비엔나 잘츠부르크"],
    ["GR", "그리스 아테네 산토리니"], ["BE", "벨기에 브뤼셀"], ["FI", "핀란드 헬싱키"], ["HR", "크로아티아 두브로브니크 자그레브"],
  ];
  SC.countriesOf = function (text) {
    var t = String(text || "");
    var out = [];
    PLACE_COUNTRY.forEach(function (row) {
      var hit = row[1].split(" ").some(function (w) { return w && t.indexOf(w) >= 0; });
      if (hit && out.indexOf(row[0]) < 0) out.push(row[0]);
    });
    return out;
  };
  // 여행지 글자 → 쓸 외화 목록(국내면 빈 배열)
  SC.currenciesFor = function (text) {
    var out = [];
    SC.countriesOf(text).forEach(function (c) {
      var cur = SC.currencyOf(c);
      if (cur && out.indexOf(cur) < 0) out.push(cur);
    });
    return out;
  };

  SC.recognizeLegs = function (blob) {
    return callVision(blob, legsPrompt(), LEGS_SCHEMA).then(SC.normalizeLegs);
  };

  global.Scan = SC;
})(this);
