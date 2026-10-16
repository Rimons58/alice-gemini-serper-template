import test from "node:test";
import assert from "node:assert/strict";
import handler, { aliceResponse, fitAliceText, isSearchIntent, safeHistory } from "../api/index.js";

function prepareEnvironment(t, search = false) {
  const keys = ["GEMINI_API_KEY", "SERPER_API_KEY", "GEMINI_MODEL"];
  const previous = keys.map(key => [key, process.env[key]]);
  process.env.GEMINI_API_KEY = "test-gemini-key";
  if (search) process.env.SERPER_API_KEY = "test-serper-key";
  else delete process.env.SERPER_API_KEY;
  delete process.env.GEMINI_MODEL;
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const level of ["info", "warn", "error"]) t.mock.method(console, level, () => {});
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function geminiAnswer(text) {
  return jsonResponse({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });
}

async function request(command, history = []) {
  let status;
  let payload;
  const res = {
    status(code) { status = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command }, state: { session: { history } } } }, res);
  return { status, payload };
}

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
  assert.equal(isSearchIntent("полный список подразделений на сервере arma 3 rising sun red"), true);
  assert.equal(isSearchIntent("Придумай список покупок"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-gemini-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

test("native fetch AbortError produces the timeout message instead of a generic Gemini error", async t => {
  prepareEnvironment(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("This operation was aborted", "AbortError");
  });
  const { status, payload } = await request("Расскажи о картографии");
  assert.equal(status, 200);
  assert.match(payload.response.text, /Не успела подготовить ответ/);
  assert.deepEqual(payload.session_state.history, []);
});

test("an abort while reading the response body is treated as a timeout", async t => {
  prepareEnvironment(t);
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => { throw new DOMException("This operation was aborted", "AbortError"); }
  }));
  const { payload } = await request("Расскажи о картографии");
  assert.match(payload.response.text, /Не успела подготовить ответ/);
});

test("Gemini has room for a 2.8-second answer within Alice's response budget", async t => {
  prepareEnvironment(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((resolve, reject) => {
    setTimeout(() => resolve(geminiAnswer("Картография изучает карты.")), 2800);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const pending = request("Расскажи о картографии");
  t.mock.timers.tick(2800);
  const { payload } = await pending;
  assert.equal(payload.response.text, "Картография изучает карты.");
});

test("a stalled fetch is aborted before Alice's 4.5-second deadline", async t => {
  prepareEnvironment(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const pending = request("Расскажи о картографии");
  t.mock.timers.tick(3000);
  const { payload } = await pending;
  assert.match(payload.response.text, /Не успела подготовить ответ/);
});

test("the RSR divisions question performs search and passes its evidence to Gemini", async t => {
  prepareEnvironment(t, true);
  const command = "полный список подразделений на сервере arma 3 rising sun red";
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(String(url));
    const body = JSON.parse(options.body);
    if (String(url).startsWith("https://google.serper.dev/")) {
      assert.equal(body.q, command);
      return jsonResponse({ organic: [{ title: "Тестовый источник", snippet: "Тестовое подразделение Альфа", link: "https://example.com/divisions" }] });
    }
    assert.match(body.contents.at(-1).parts[0].text, /Тестовое подразделение Альфа/);
    return geminiAnswer("В тестовом источнике указано подразделение Альфа.");
  });
  const { status, payload } = await request(command);
  assert.equal(status, 200);
  assert.equal(calls.length, 2);
  assert.equal(payload.response.text, "В тестовом источнике указано подразделение Альфа.");
  assert.equal(payload.session_state.history.length, 2);
});

test("failed search returns an honest search error without an ungrounded Gemini answer", async t => {
  prepareEnvironment(t, true);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async url => {
    calls++;
    assert.ok(String(url).startsWith("https://google.serper.dev/"));
    return jsonResponse({ error: "Unavailable" }, 503);
  });
  const { payload } = await request("Найди подразделения сервера");
  assert.match(payload.response.text, /Не удалось получить результаты поиска/);
  assert.equal(calls, 1);
  assert.deepEqual(payload.session_state.history, []);
});

test("search without a Serper key reports the missing capability without network calls", async t => {
  prepareEnvironment(t);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("No provider should be called"); });
  const { payload } = await request("Какая погода сегодня?");
  assert.match(payload.response.text, /Поиск в интернете пока не настроен/);
});

test("oversized Cyrillic and emoji history fits Alice's 1-KiB state limit without broken Unicode", () => {
  const history = [
    { role: "user", text: "Карта 🧭 ".repeat(150) },
    { role: "model", text: "Разведка 🗺️ ".repeat(150) }
  ];
  const { session_state } = aliceResponse("Готово", false, history);
  assert.ok(Buffer.byteLength(JSON.stringify(session_state), "utf8") <= 1024);
  assert.equal(session_state.history.length, 2);
  for (const item of session_state.history) {
    assert.ok(item.text.length > 0);
    assert.ok(item.text.isWellFormed());
  }
  assert.equal(history[0].text, "Карта 🧭 ".repeat(150));
});

test("state keeps the newest exchange and removes older messages before truncating it", () => {
  const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: "История ".repeat(100) }));
  const latest = [{ role: "user", text: "Где карта?" }, { role: "model", text: "На столе." }];
  const { session_state } = aliceResponse("На столе.", false, [...history, ...latest]);
  assert.deepEqual(session_state.history, latest);
});
