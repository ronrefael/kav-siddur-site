// Prayer request link page logic. Plain script (browser) that also exports its
// pure helpers for `node --test site/kav-siddur-site/p/page.test.mjs`.
//
// The page is a model plus a thin view: screenFor(row, ctx) decides what is shown (pure, tested),
// createLighter() is the press-and-hold candle (pure, timers injected), and the DOM code at the
// bottom only draws the model. The closed and thanks lines, the psalms and the say-card Hebrew are
// read from the generated JSON files next to this page (scripts/site), never typed here.
//
// Reporting: pray_for_report_request_by_code(p_code, p_actor, p_reason) is
// granted to anon and records one report per browser token. Web reports never
// hide a request on their own; they alert the owner for manual review. If the
// call fails the page falls back to the support page's abuse contact.
//
// Everything from the server is written with textContent only.
(function (root) {
  "use strict";

  // Public values the app already ships (EXPO_PUBLIC_*). The key is the anon /
  // publishable key; row-level security and the RPC grants are the protection.
  var SUPABASE_URL = "https://yedurzxufuzyxagssdpi.supabase.co";
  var SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InllZHVyenh1ZnV6eXhhZ3NzZHBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5OTk2NDcsImV4cCI6MjA5ODU3NTY0N30.zaMnUGMuS2QbivZlHznGfw5vNTwk04U_UOaL8qRSYY0";
  var SUPPORT_URL = "../support.html";
  // The App Store page. Empty until the app is live: the quiet "Get Kav Siddur" line shows only when this is set.
  var APP_STORE_URL = "";
  var HOLD_MS = 2000;
  var MIN_COUNT = 3;

  // The line under the name: the same name-free dedication as the app and its card (requestKinds.ts).
  var INTENT = {
    refuah: "For a complete healing",
    ilui_nishmat: "For the elevation of the soul",
    safe_return: "For a safe journey and return",
    life_event: "For blessing at this time",
  };
  function dedicationLine(kind) { return INTENT[kind] || INTENT.life_event; }
  // The eyebrow over the name: the same words as the app and its candle card (candleCardContent.ts).
  var HEADINGS = {
    refuah: "Please pray for",
    ilui_nishmat: "In memory of",
    safe_return: "Pray for the safety of",
    life_event: "With a prayer for",
  };
  function headline(kind) { return HEADINGS[kind] || HEADINGS.life_event; }
  // Tab titles.
  var TITLES = {
    refuah: "Prayer for healing",
    ilui_nishmat: "In memory",
    safe_return: "Prayer for safe return",
    life_event: "A prayer",
  };
  // The ledger id of each kind's say-card Hebrew (review-ledger.json); the memory kind has none.
  var SAY_LEDGER = { refuah: "pf.share.he.refuah", safe_return: "pf.share.he.safe", life_event: "pf.thanks.he", ilui_nishmat: null };
  var HEBREW_ADVANCE_EM = 0.55;
  var NAME_PX = 48;
  var NAME_PX_WITH_GIVEN = 28;

  // ── pure helpers ──────────────────────────────────────────────────────────
  function parseCode(search) {
    var m = /[?&]c=([^&#]*)/.exec(String(search || ""));
    if (!m) return null;
    var raw;
    try { raw = decodeURIComponent(m[1]); } catch (e) { return null; }
    // Not upper-cased: same rule as the app (requestLinks.ts), a lower-case code is unavailable.
    var code = raw.trim();
    return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : null;
  }

  function viewState(row, nowMs) {
    if (!row) return "unavailable";
    var exp = Date.parse(row.expires_at);
    if (!isFinite(exp) || exp <= nowMs) return "unavailable";
    if (row.status === "recovered") return "recovered";
    if (row.status === "closed") return "closed";
    if (row.status === "open") return "open";
    return "unavailable";
  }

  // Closed or expired is the quiet page, recovered is the thanks page, anything else is not closed.
  function closedState(row, nowMs) {
    if (!row) return null;
    if (row.status === "recovered") return "thanks";
    var exp = Date.parse(row.expires_at);
    if (row.status === "closed" || (row.status === "open" && isFinite(exp) && exp <= nowMs)) return "quiet";
    return null;
  }

  function randomHex(bytes) {
    var c = root.crypto;
    var a = new Uint8Array(bytes);
    if (c && c.getRandomValues) c.getRandomValues(a);
    else for (var i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
    var s = "";
    for (var j = 0; j < a.length; j++) s += (a[j] < 16 ? "0" : "") + a[j].toString(16);
    return s;
  }

  var memoryToken = null;
  function actorToken(storage) {
    var KEY = "kav-prayer-actor";
    try {
      var t = storage.getItem(KEY);
      if (t && /^[0-9a-f]{32}$/.test(t)) return t;
      t = randomHex(16);
      storage.setItem(KEY, t);
      return t;
    } catch (e) {
      if (!memoryToken) memoryToken = randomHex(16);
      return memoryToken;
    }
  }

  // The count is never shown under 3: a small number reads as a lack of company, not a blessing.
  function showCount(n) { return Number(n) >= MIN_COUNT; }
  function peopleText(n, given) {
    return (n === 1 ? "1 person" : n + " people") + " lit a candle for " + given;
  }

  function dayKey(code, d) {
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return "kav-prayed:" + code + ":" + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  // Whether this browser already lit a candle for the request on this local day.
  function litState(code, day, storage) {
    try { return !!(storage && storage.getItem(dayKey(code, day))); } catch (e) { return false; }
  }

  // Shabbat is the visitor's own Saturday (their device's local weekday).
  function isShabbat(date) { return date.getDay() === 6; }

  // Optional free-text reason: collapse whitespace and control characters, cap at
  // 200 (the server column limit). Empty becomes null.
  function reportReason(text) {
    var t = String(text == null ? "" : text).replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, 200).trim();
    return t || null;
  }

  // ── names: same rules as the app (apps/mobile/src/prayerRequests/nameLines.ts, prefillName.ts) ──
  // Never broken inside a name: one line, shrunk to fit, or two lines broken only
  // before בן / בת (found with niqqud ignored, never the first word). Spaces inside a
  // line are no-break spaces.
  var MARKS = /[\u0591-\u05C7]/g;
  function bare(word) { return word.normalize("NFKD").replace(MARKS, ""); }
  function splitName(name) {
    var text = String(name || "").replace(/\s+/g, " ").trim();
    var words = text ? text.split(" ") : [];
    for (var i = 1; i < words.length - 1; i++) {
      var b = bare(words[i]);
      if (b === "בן" || b === "בת") return { given: words.slice(0, i).join(" "), rest: words.slice(i).join(" "), relation: b };
    }
    return { given: text };
  }
  function visibleLength(text) {
    return Array.from(text.replace(MARKS, "")).length;
  }
  function keepTogether(text) { return text.replace(/ /g, "\u00A0"); }
  function nameLines(name, maxChars) {
    var p = splitName(name);
    var whole = p.rest ? p.given + " " + p.rest : p.given;
    if (!p.rest || visibleLength(whole) <= maxChars) return [keepTogether(whole)];
    return [keepTogether(p.given), keepTogether(p.rest)];
  }
  function charsThatFit(width, fontSize, minScale) {
    return Math.max(1, Math.floor(width / (fontSize * HEBREW_ADVANCE_EM * minScale)));
  }

  // {given} everywhere on the page: the reduced display name exactly as the server sent it.
  // Until the server sends one, the Hebrew given name stands in.
  function givenName(row) {
    var sent = row && typeof row.display_name === "string" ? row.display_name.trim() : "";
    return sent || splitName(row && row.hebrew_name).given;
  }

  // ── the say card ────────────────────────────────────────────────────────────
  var SAY_LEAD = "If you like, say silently:";
  function pronounOf(row) {
    var rel = splitName(row.hebrew_name).relation;
    return rel === "בת" ? "her" : rel === "בן" ? "his" : "their";
  }
  // The same English lines as the app (prayContent.ts sayEnglish).
  function sayEnglish(kind, given, pronoun) {
    if (kind === "refuah") return `May ${given} have a full recovery.`;
    if (kind === "safe_return") return `May ${given} go and return for life, for joy and for peace.`;
    if (kind === "ilui_nishmat") return `For the elevation of the soul of ${given}. May ${pronoun} memory be a blessing; may ${pronoun} soul be bound up in the bond of life.`;
    return `Thank God for the good news about ${given}.`;
  }
  // The section 12c Hebrew with the name filled in, or null when the ledger has not shown the line.
  function sayHebrew(lines, kind, hebrewName) {
    var id = SAY_LEDGER[kind];
    var text = id && lines ? lines[id] : null;
    return typeof text === "string" && text && typeof hebrewName === "string" && hebrewName ? text.replace("{name}", function () { return hebrewName; }) : null;
  }

  // ── the screen model ────────────────────────────────────────────────────────
  // ctx: { now, closedLines, psalms, hebrewLines, storage, still, code, day, appStoreUrl }
  function unavailableScreen(title, line) { return { mode: "unavailable", title: title, line: line }; }

  function psalmRows(kind, psalms) {
    if (!psalms || !psalms.kinds || !psalms.psalms) return [];
    return (psalms.kinds[kind] || []).filter(function (n) { return psalms.psalms[String(n)]; }).map(function (n) {
      var p = psalms.psalms[String(n)];
      return { n: n, title: p.title, paragraphs: p.paragraphs };
    });
  }

  function screenFor(row, ctx) {
    var closed = closedState(row, ctx.now);
    if (closed) {
      var pair = ctx.closedLines && ctx.closedLines[closed];
      if (!pair) return unavailableScreen(loadFailureView(null).title, loadFailureView(null).intent);
      return { mode: closed, title: pair[0], line: pair[1] };
    }
    if (viewState(row, ctx.now) !== "open") {
      return unavailableScreen("This request is no longer available", "It may have expired or been removed by the person who shared it.");
    }
    var kind = INTENT[row.kind] ? row.kind : "life_event";
    var given = givenName(row);
    var n = Math.max(0, Math.floor(Number(row.prayer_count) || 0));
    var day = ctx.day || new Date(ctx.now);
    var still = !!ctx.still;
    var lit = still || !!row.demo_lit || litState(ctx.code, day, ctx.storage);
    var appUrl = ctx.appStoreUrl === undefined ? APP_STORE_URL : ctx.appStoreUrl;
    var rows = psalmRows(kind, ctx.psalms);
    return {
      mode: "open",
      kind: kind,
      still: still,
      lit: lit,
      eyebrow: headline(kind),
      given: given,
      hasDisplayName: !!(typeof row.display_name === "string" && row.display_name.trim()),
      hebrewName: row.hebrew_name,
      dedication: dedicationLine(kind),
      title: TITLES[kind] + " · Kav Siddur",
      candleLabel: still ? `A candle for ${given}` : `Press and hold to light a candle for ${given}`,
      hint: still ? null : "Press and hold the candle to light it.",
      tapText: still ? null : "Can\u2019t hold? Tap here to light it",
      litLine: still ? null : `Your candle for ${given} is lit.`,
      count: n,
      countText: showCount(n) ? peopleText(n, given) : null,
      say: { lead: SAY_LEAD, en: sayEnglish(kind, given, pronounOf(row)), he: sayHebrew(ctx.hebrewLines, kind, row.hebrew_name) },
      appLine: appUrl && !still ? { text: `Get Kav Siddur to keep ${given} in your prayers`, href: appUrl } : null,
      psalms: { title: `Psalms for ${given}`, rows: rows },
      report: true,
    };
  }

  // ── the candle: press and hold, or tap ─────────────────────────────────────
  // o: { code, count, still, startLit, demo, holdMs, day, storage, rpc, timers:{set,clear}, setHint, setHolding, onLit(count), onFail(text) }
  var HINT = "Press and hold the candle to light it.";
  var HOLDING = "Keep holding";
  function createLighter(o) {
    var lit = !!o.startLit || !!o.still;
    var timer = null;
    function stop() { if (timer !== null) { o.timers.clear(timer); timer = null; } }
    function complete() {
      if (lit || o.still) return;
      stop();
      lit = true;
      o.setHolding(false);
      if (o.demo) { o.onLit(o.count + 1); return; }
      var store = o.storage;
      o.rpc("pray_for_record_prayer_by_code", { p_code: o.code, p_actor: actorToken(store) }).then(function (n) {
        try { store.setItem(dayKey(o.code, o.day), "1"); } catch (e) {}
        o.onLit(typeof n === "number" && n > 0 ? n : o.count + 1);
      }).catch(function (err) {
        lit = false;
        o.onFail(prayFailureText(err));
      });
    }
    return {
      isLit: function () { return lit; },
      press: function () {
        if (lit || o.still || timer !== null) return;
        o.setHolding(true);
        o.setHint(HOLDING);
        timer = o.timers.set(complete, o.holdMs);
      },
      release: function () {
        if (lit || o.still) return;
        stop();
        o.setHolding(false);
        o.setHint(HINT);
      },
      tap: function () { complete(); },
    };
  }

  // ── failures: the server may answer Rate limited on any call (HTTP 400 today, 429 once it raises PT429) ──
  var RATE_LIMITED_TEXT = "Too many tries \u2014 please try again in a little while.";
  function isRateLimited(err) {
    return Boolean(err) && (err.status === 429 || /Rate limited/i.test(String(err.message || "")));
  }
  // Opening the request failed: calm for a rate limit, never "no longer available".
  function loadFailureView(err) {
    if (isRateLimited(err)) return { title: RATE_LIMITED_TEXT, intent: "" };
    return { title: "Can't load this request right now", intent: "We could not load this request. Please check your connection and try again." };
  }
  function prayFailureText(err) {
    return isRateLimited(err) ? RATE_LIMITED_TEXT : "Could not record your prayer. Please try again.";
  }
  function reportFailureParts(err) {
    if (isRateLimited(err)) return [RATE_LIMITED_TEXT];
    return ["We could not send your report. Please ", { href: SUPPORT_URL, text: "contact support" }, " instead."];
  }
  // Every call is a POST: the server answers GET with 405.
  function rpcRequest(name, body) {
    return {
      url: SUPABASE_URL + "/rest/v1/rpc/" + name,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY },
        body: JSON.stringify(body),
      },
    };
  }

  // ── demo rows (?demo=open|lit|closed|thanks|expired|long|ilui|safe|unavailable|limited) ──
  function demoRow(name, nowMs) {
    var day = 864e5;
    var base = { kind: "refuah", display_name: "Sarah", hebrew_name: "שרה בת רבקה", status: "open", prayer_count: 23, expires_at: new Date(nowMs + day).toISOString() };
    var rows = {
      open: base,
      lit: Object.assign({}, base, { prayer_count: 24, demo_lit: true }),
      closed: Object.assign({}, base, { status: "closed" }),
      thanks: Object.assign({}, base, { status: "recovered" }),
      expired: Object.assign({}, base, { expires_at: new Date(nowMs - day).toISOString() }),
      long: Object.assign({}, base, { display_name: "Abraham Isaac Benjamin Yaakov Menachem Z", hebrew_name: "אברהם יצחק בן רבקה לאה", prayer_count: 40 }),
      ilui: Object.assign({}, base, { kind: "ilui_nishmat", prayer_count: 31 }),
      safe: Object.assign({}, base, { kind: "safe_return", prayer_count: 5 }),
    };
    return Object.prototype.hasOwnProperty.call(rows, name) ? rows[name] : null;
  }

  var api = {
    reportReason: reportReason, parseCode: parseCode, dedicationLine: dedicationLine, headline: headline, viewState: viewState, closedState: closedState, actorToken: actorToken,
    peopleText: peopleText, showCount: showCount, isShabbat: isShabbat, litState: litState, dayKey: dayKey, nameLines: nameLines, charsThatFit: charsThatFit,
    givenName: givenName, sayHebrew: sayHebrew, screenFor: screenFor, createLighter: createLighter, demoRow: demoRow, APP_STORE_URL: APP_STORE_URL,
    RATE_LIMITED_TEXT: RATE_LIMITED_TEXT, isRateLimited: isRateLimited, loadFailureView: loadFailureView,
    prayFailureText: prayFailureText, reportFailureParts: reportFailureParts, rpcRequest: rpcRequest,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // ── page (the view: draws the model, nothing is decided here) ───────────────
  var $ = function (id) { return document.getElementById(id); };
  function safeStorage() { try { return root.localStorage; } catch (e) { return { getItem: function () { throw e; }, setItem: function () { throw e; } }; } }
  function rpc(name, body) {
    var req = rpcRequest(name, body);
    return fetch(req.url, req.init).then(function (r) {
      // Keep the status and the server's message: either can say "rate limited".
      if (!r.ok) return r.text().then(function (t) {
        var err = new Error("http " + r.status + " " + t);
        err.status = r.status;
        throw err;
      });
      return r.json();
    });
  }
  function getJson(file) {
    return fetch(file).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  // One line shrunk to fit, or two lines broken before בן / בת; never below 50 % of the size.
  function setName(name, px) {
    var el = $("name");
    el.style.fontSize = px + "px";
    var width = el.clientWidth || 320;
    var lines = nameLines(name, charsThatFit(width, px, 0.6));
    el.textContent = lines.join("\n");
    var size = px;
    while (el.scrollHeight > lines.length * size * 1.17 + size * 0.4 && size > px * 0.5) {
      size -= 2;
      el.style.fontSize = size + "px";
    }
  }

  // Swap a line's words with a short crossfade.
  function crossfade(el, text) {
    if (el.textContent === (text || "")) return;
    el.setAttribute("data-fading", "");
    setTimeout(function () {
      el.textContent = text || "";
      el.removeAttribute("data-fading");
    }, 300);
  }

  function showQuiet(title, line) {
    $("request").hidden = true;
    $("reportRow").hidden = true;
    $("privacy").hidden = true;
    $("quietTitle").textContent = title;
    $("quietLine").textContent = line;
    $("quietLine").hidden = !line;
    $("quiet").hidden = false;
  }

  function drawPsalms(model) {
    var box = $("psalms");
    box.textContent = "";
    $("psalmsLabel").textContent = model.psalms.title;
    model.psalms.rows.forEach(function (row) {
      var wrap = document.createElement("div");
      wrap.className = "psalm";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "prow";
      btn.id = "psalm-btn-" + row.n;
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-controls", "psalm-text-" + row.n);
      btn.textContent = row.title;
      var text = document.createElement("div");
      text.className = "ptext";
      text.id = "psalm-text-" + row.n;
      text.lang = "he";
      text.hidden = true;
      row.paragraphs.forEach(function (p) {
        var para = document.createElement("p");
        para.textContent = p;
        text.appendChild(para);
      });
      btn.onclick = function () {
        text.hidden = !text.hidden;
        btn.setAttribute("aria-expanded", text.hidden ? "false" : "true");
      };
      wrap.appendChild(btn);
      wrap.appendChild(text);
      box.appendChild(wrap);
    });
    var any = model.psalms.rows.length > 0;
    box.hidden = !any;
    $("psalmsLabel").hidden = !any;
  }

  function drawSay(model) {
    $("sayLead").textContent = model.say.lead;
    $("sayEn").textContent = model.say.en;
    $("sayHe").textContent = model.say.he || "";
    $("sayHe").hidden = !model.say.he;
    var link = $("appLink");
    link.hidden = !model.appLine;
    if (model.appLine) {
      link.textContent = model.appLine.text;
      link.setAttribute("href", model.appLine.href);
    }
  }

  function drawOpen(model, code, demo) {
    document.body.setAttribute("data-state", "open");
    document.title = model.title;
    $("request").hidden = false;
    $("quiet").hidden = true;
    $("eyebrow").textContent = model.eyebrow;
    $("intent").textContent = model.dedication;
    $("given").hidden = !model.hasDisplayName;
    if (model.hasDisplayName) { $("given").textContent = model.given; document.body.setAttribute("data-given", ""); }
    setName(model.hebrewName, model.hasDisplayName ? NAME_PX_WITH_GIVEN : NAME_PX);
    drawPsalms(model);
    drawSay(model);

    var candle = $("candle"), hint = $("hint"), count = $("count"), tap = $("tap"), litLine = $("litLine"), err = $("err");
    candle.setAttribute("aria-label", model.candleLabel);
    hint.textContent = model.hint || "";
    tap.textContent = model.tapText || "";
    tap.hidden = !model.tapText;
    count.textContent = model.countText || "";
    var showLit = function (instant) {
      candle.setAttribute("data-lit", "");
      if (instant) candle.setAttribute("data-instant", "");
      candle.removeAttribute("data-holding");
    };
    $("after").hidden = true;

    if (model.still) {
      // Shabbat: the candle is drawn lit and does not respond; nothing is recorded; the hint and the tap line are gone.
      candle.setAttribute("data-still", "");
      candle.tabIndex = -1;
      showLit(true);
      $("after").hidden = false;
      $("appLink").hidden = true;
      return;
    }
    if (model.lit) {
      showLit(true);
      hint.hidden = true;
      tap.hidden = true;
      litLine.textContent = model.litLine;
      litLine.hidden = false;
      $("after").hidden = false;
      return;
    }

    var store = safeStorage();
    var lighter = createLighter({
      code: code, count: model.count, still: false, startLit: false, demo: demo, holdMs: HOLD_MS,
      day: new Date(), storage: store, rpc: rpc,
      timers: { set: function (fn, ms) { return setTimeout(fn, ms); }, clear: clearTimeout },
      setHint: function (t) { hint.textContent = t; },
      setHolding: function (on) { if (on) candle.setAttribute("data-holding", ""); else candle.removeAttribute("data-holding"); },
      onLit: function (n) {
        err.hidden = true;
        showLit(false);
        hint.hidden = true;
        // Kept in the layout (just unseen) so the card does not jump when the candle lights.
        tap.setAttribute("data-gone", "");
        litLine.textContent = model.litLine;
        litLine.hidden = false;
        var after = showCount(n) ? peopleText(n, model.given) : "";
        if (after) crossfade(count, after);
        $("after").hidden = false;
      },
      onFail: function (text) {
        candle.removeAttribute("data-lit");
        candle.removeAttribute("data-holding");
        litLine.hidden = true;
        hint.hidden = false;
        hint.textContent = HINT;
        tap.removeAttribute("data-gone");
        tap.hidden = false;
        err.textContent = text;
        err.hidden = false;
      },
    });
    var down = function (e) {
      if (e.preventDefault) e.preventDefault();
      if (candle.setPointerCapture && e.pointerId !== undefined) { try { candle.setPointerCapture(e.pointerId); } catch (x) {} }
      lighter.press();
    };
    candle.addEventListener("pointerdown", down);
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (t) { candle.addEventListener(t, function () { lighter.release(); }); });
    candle.addEventListener("keydown", function (e) { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); lighter.press(); } });
    candle.addEventListener("keyup", function (e) { if (e.key === " " || e.key === "Enter") lighter.release(); });
    candle.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    tap.onclick = function () { lighter.tap(); };
  }

  function setupReport(code, demo) {
    var toggle = $("report"), box = $("reportBox"), msg = $("reportMsg"), send = $("reportSend");
    $("reportRow").hidden = false;
    function say(parts) {
      msg.textContent = "";
      parts.forEach(function (p) {
        if (typeof p === "string") { msg.appendChild(document.createTextNode(p)); return; }
        var a = document.createElement("a");
        a.href = p.href;
        a.textContent = p.text;
        msg.appendChild(a);
      });
      msg.hidden = false;
    }
    function open(v) {
      box.hidden = !v;
      toggle.setAttribute("aria-expanded", v ? "true" : "false");
      if (v) { msg.hidden = true; $("reportReason").focus(); }
    }
    toggle.onclick = function () { open(box.hidden); };
    $("reportCancel").onclick = function () { open(false); toggle.focus(); };
    send.onclick = function () {
      if (send.disabled) return;
      send.disabled = true;
      var done = function () {
        $("reportForm").hidden = true;
        toggle.hidden = true;
        say(["Thanks \u2014 we\u2019ll review it."]);
      };
      if (demo) { done(); return; }
      rpc("pray_for_report_request_by_code", {
        p_code: code, p_actor: actorToken(safeStorage()), p_reason: reportReason($("reportReason").value),
      }).then(function (ok) {
        if (ok === true) done();
        else { send.disabled = false; say(["This request is no longer available to report."]); }
      }).catch(function (err) {
        send.disabled = false;
        say(reportFailureParts(err));
      });
    };
  }

  function render(row, code, demo, assets, still) {
    var model = screenFor(row, {
      now: Date.now(), closedLines: assets.closedLines, psalms: assets.psalms, hebrewLines: assets.hebrewLines,
      storage: safeStorage(), still: still, code: code, day: new Date(),
    });
    document.body.setAttribute("data-state", model.mode);
    if (model.mode !== "open") {
      showQuiet(model.title, model.line);
      return;
    }
    drawOpen(model, code, demo);
    setupReport(code, demo);
  }

  function start() {
    var q = new URLSearchParams(root.location.search);
    var demo = q.get("demo");
    var stillDemo = q.get("still") === "1";
    var still = isShabbat(new Date()) || (!!demo && stillDemo);
    Promise.all([getJson("closed-lines.json"), getJson("psalms.json"), getJson("hebrew-lines.json")]).then(function (files) {
      var assets = { closedLines: files[0], psalms: files[1], hebrewLines: files[2] };
      if (demo === "limited") {
        var view = loadFailureView({ status: 429, message: "" });
        showQuiet(view.title, view.intent);
        return;
      }
      if (demo && /^[a-z]{1,12}$/.test(demo)) {
        render(demoRow(demo, Date.now()), "DEMO2345", true, assets, still);
        return;
      }
      var code = parseCode(root.location.search);
      if (!code) { render(null, null, false, assets, still); return; }
      rpc("pray_for_get_request", { p_code: code }).then(function (rows) {
        render(Array.isArray(rows) && rows.length ? rows[0] : null, code, false, assets, still);
      }).catch(function (err) {
        var view = loadFailureView(err);
        showQuiet(view.title, view.intent);
      });
    });
  }

  start();
})(typeof window !== "undefined" ? window : globalThis);
