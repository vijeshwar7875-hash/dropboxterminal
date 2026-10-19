const http = require("node:http");
const path = require("node:path");
const { readFile } = require("node:fs/promises");
const { existsSync, readFileSync } = require("node:fs");

const host = "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const maxUploadBytes = 20 * 1024 * 1024;
const imageExtensions = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  const contents = readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;

    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile();

// ---------------------------------------------------------------------------
// Token management — auto-refreshes using refresh token (never expires)
// Falls back to plain DROPBOX_ACCESS_TOKEN if refresh creds are not set.
// ---------------------------------------------------------------------------
let cachedAccessToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
  const appKey     = process.env.DROPBOX_APP_KEY;
  const appSecret  = process.env.DROPBOX_APP_SECRET;

  if (refreshToken && appKey && appSecret) {
    // Return cached token if still valid (with 60-second buffer)
    if (cachedAccessToken && Date.now() < tokenExpiresAt - 60_000) {
      return cachedAccessToken;
    }

    let res;
    try {
      res = await fetch("https://api.dropbox.com/oauth2/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization:
            "Basic " + Buffer.from(`${appKey}:${appSecret}`).toString("base64"),
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      });
    } catch (cause) {
      const error = new Error(`Could not reach Dropbox token endpoint: ${cause.message}`);
      error.status = 502;
      throw error;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(
        `Dropbox token refresh failed: ${data.error_description || data.error || res.status}`,
      );
      error.status = 502;
      throw error;
    }

    cachedAccessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in ?? 14400) * 1000;
    console.log("Access token refreshed successfully.");
    return cachedAccessToken;
  }

  // Fallback: static access token (expires in ~4 hours — not recommended)
  const token = process.env.DROPBOX_ACCESS_TOKEN;
  if (!token) {
    const error = new Error(
      "Missing credentials. Add DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, and " +
      "DROPBOX_APP_SECRET to .env for permanent access, or DROPBOX_ACCESS_TOKEN " +
      "for a temporary token.",
    );
    error.status = 503;
    throw error;
  }
  return token;
}

function sendJson(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function dropboxRequest(
  endpoint,
  { body, contentType = "application/json", headers = {} } = {},
) {
  const token = await getAccessToken();
  const apiHost = endpoint === "files/upload" ? "content.dropboxapi.com" : "api.dropboxapi.com";

  let response;
  try {
    response = await fetch(`https://${apiHost}/2/${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": contentType,
        ...headers,
      },
      body,
    });
  } catch (cause) {
    const error = new Error(`Could not reach Dropbox for ${endpoint}: ${cause.message}`);
    error.status = 502;
    throw error;
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      result.error_summary
        ? `Dropbox ${endpoint} failed: ${result.error_summary}`
        : `Dropbox ${endpoint} failed with HTTP ${response.status}.`,
    );
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  return result;
}

async function listImages() {
  let result = await dropboxRequest("files/list_folder", {
    body: JSON.stringify({ path: "", recursive: false }),
  });
  const entries = [...result.entries];
  while (result.has_more) {
    result = await dropboxRequest("files/list_folder/continue", {
      body: JSON.stringify({ cursor: result.cursor }),
    });
    entries.push(...result.entries);
  }

  const images = entries.filter(
    (entry) =>
      entry[".tag"] === "file" &&
      imageExtensions.has(path.extname(entry.name).toLowerCase()),
  );
  return Promise.all(
    images.map(async (entry) => {
      const link = await dropboxRequest("files/get_temporary_link", {
        body: JSON.stringify({ path: entry.id }),
      });
      return { id: entry.id, name: entry.name, path: entry.path_lower, url: link.link };
    }),
  );
}

async function readRequestBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Upload exceeds the 20 MB limit.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/images") {
    sendJson(response, 200, { images: await listImages() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/images") {
    const name = url.searchParams.get("name");
    if (!name || path.basename(name) !== name || name.startsWith(".")) {
      sendJson(response, 400, { error: "Provide a valid image filename." });
      return;
    }
    if (!imageExtensions.has(path.extname(name).toLowerCase())) {
      sendJson(response, 400, { error: "Choose a supported image file." });
      return;
    }
    const body = await readRequestBody(request, maxUploadBytes);
    if (body.length === 0) {
      sendJson(response, 400, { error: "The selected file is empty." });
      return;
    }
    await dropboxRequest("files/upload", {
      body,
      contentType: "application/octet-stream",
      headers: {
        "dropbox-api-arg": JSON.stringify({
          path: `/${name}`,
          mode: "add",
          autorename: true,
          mute: false,
        }),
      },
    });
    sendJson(response, 201, { message: "Image uploaded." });
    return;
  }

  if (request.method === "DELETE" && url.pathname === "/api/images") {
    let payload;
    try {
      payload = JSON.parse((await readRequestBody(request, 4096)).toString("utf8"));
    } catch {
      sendJson(response, 400, { error: "Provide a valid image path." });
      return;
    }
    if (
      typeof payload.path !== "string" ||
      !payload.path.startsWith("/") ||
      payload.path.slice(1).includes("/") ||
      !imageExtensions.has(path.extname(payload.path).toLowerCase())
    ) {
      sendJson(response, 400, { error: "Provide a valid image path." });
      return;
    }
    await dropboxRequest("files/delete_v2", {
      body: JSON.stringify({ path: payload.path }),
    });
    sendJson(response, 200, { message: "Image deleted." });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" || !["/", "/index.html"].includes(url.pathname)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const html = await readFile(path.join(__dirname, "public", "index.html"));
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'self'; img-src 'self' https://*.dropboxusercontent.com https://*.dropbox.com data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self';",
      "referrer-policy": "no-referrer",
    });
    response.end(html);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    sendJson(response, error.status || 500, {
      error: error.message || "An unexpected server error occurred.",
    });
  }
});

server.listen(port, host, () => {
  console.log(`Dropbox image library is available at http://${host}:${port}`);
});
