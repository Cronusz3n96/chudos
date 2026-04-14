/**
 * Cloudflare Pages Function — Bare Server v3
 * Mounted at /bare/[[path]] — handles all /bare/* requests
 */

const BARE_INFO = JSON.stringify({
  versions: ["v3"],
  language: "JS",
  memoryUsage: 0,
  maintainer: { email: "", website: "" },
  project: { name: "cf-bare", description: "Bare server for Cloudflare Pages", email: "", website: "", repository: "", version: "1.0.0" },
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Expose-Headers": "*",
};

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Server info
  if (path === "/bare/" || path === "/bare") {
    return new Response(BARE_INFO, {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  // v3 HTTP proxy
  if (path.startsWith("/bare/v3/") && request.headers.get("Upgrade") !== "websocket") {
    return handleHTTP(request);
  }

  // v3 WebSocket proxy
  if (path.startsWith("/bare/v3/") && request.headers.get("Upgrade") === "websocket") {
    return handleWebSocket(request);
  }

  return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
}

async function handleHTTP(request) {
  const targetURL = request.headers.get("X-Bare-URL");
  if (!targetURL) {
    return new Response("Missing X-Bare-URL", { status: 400, headers: CORS_HEADERS });
  }

  let forwardHeaders = {};
  try {
    const raw = request.headers.get("X-Bare-Headers");
    if (raw) forwardHeaders = JSON.parse(raw);
  } catch {
    return new Response("Invalid X-Bare-Headers JSON", { status: 400, headers: CORS_HEADERS });
  }

  let passBody = null;
  if (!["GET", "HEAD"].includes(request.method)) {
    passBody = request.body;
  }

  let response;
  try {
    response = await fetch(targetURL, {
      method: request.method,
      headers: forwardHeaders,
      body: passBody,
      redirect: "manual",
    });
  } catch (err) {
    return new Response(`Upstream error: ${err.message}`, { status: 500, headers: CORS_HEADERS });
  }

  // Collect response headers for X-Bare-Headers
  const responseHeadersObj = {};
  for (const [k, v] of response.headers.entries()) {
    responseHeadersObj[k] = v;
  }

  const outHeaders = new Headers(CORS_HEADERS);
  outHeaders.set("X-Bare-Status", String(response.status));
  outHeaders.set("X-Bare-Status-Text", response.statusText);
  outHeaders.set("X-Bare-Headers", JSON.stringify(responseHeadersObj));

  // Forward content-type so the browser renders correctly
  const ct = response.headers.get("content-type");
  if (ct) outHeaders.set("Content-Type", ct);

  return new Response(response.body, { status: 200, headers: outHeaders });
}

async function handleWebSocket(request) {
  const targetURL = request.headers.get("X-Bare-URL");
  if (!targetURL) {
    return new Response("Missing X-Bare-URL", { status: 400, headers: CORS_HEADERS });
  }

  let extraHeaders = {};
  try {
    const raw = request.headers.get("X-Bare-Headers");
    if (raw) extraHeaders = JSON.parse(raw);
  } catch { /* ignore */ }

  // Upgrade the request to a WebSocket pair
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  // Connect to the target WS
  const remote = new WebSocket(targetURL, extraHeaders["Sec-WebSocket-Protocol"] ?? []);

  remote.addEventListener("message", (e) => {
    try { server.send(e.data); } catch { /* client closed */ }
  });
  remote.addEventListener("close", (e) => {
    try { server.close(e.code, e.reason); } catch { /* already closed */ }
  });
  remote.addEventListener("error", () => {
    try { server.close(1011, "Remote error"); } catch { /* already closed */ }
  });

  server.addEventListener("message", (e) => {
    try { remote.send(e.data); } catch { /* remote closed */ }
  });
  server.addEventListener("close", (e) => {
    try { remote.close(e.code, e.reason); } catch { /* already closed */ }
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: CORS_HEADERS,
  });
}
