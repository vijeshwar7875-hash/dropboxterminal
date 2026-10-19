/**
 * Run this ONCE to get your Dropbox refresh token.
 * Usage: node get-token.js
 */

const http = require("node:http");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const contents = readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?(.*?)"?\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2];
  }
}

loadEnvFile();

const appKey    = process.env.DROPBOX_APP_KEY;
const appSecret = process.env.DROPBOX_APP_SECRET;

if (!appKey || !appSecret) {
  console.error("\n❌  Missing DROPBOX_APP_KEY or DROPBOX_APP_SECRET in .env");
  console.error("   Add them first:\n");
  console.error("   DROPBOX_APP_KEY=your_app_key");
  console.error("   DROPBOX_APP_SECRET=your_app_secret\n");
  process.exit(1);
}

const redirectUri = "http://127.0.0.1:9876/callback";
const authUrl =
  `https://www.dropbox.com/oauth2/authorize` +
  `?client_id=${appKey}` +
  `&response_type=code` +
  `&token_access_type=offline` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}`;

console.log("\n🔑  Opening Dropbox login in your browser...");
console.log("   If it doesn't open, visit this URL manually:\n");
console.log("   " + authUrl + "\n");

// Open browser automatically
const { exec } = require("node:child_process");
exec(`start "" "${authUrl}"`);

// Spin up a tiny local server to catch the redirect
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:9876");
  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400);
    res.end("No code received. Try again.");
    return;
  }

  res.writeHead(200, { "content-type": "text/html" });
  res.end("<h2>✅ Authorized! Check your terminal for the refresh token.</h2><p>You can close this tab.</p>");
  server.close();

  // Exchange code for tokens
  console.log("✅  Authorization received. Fetching refresh token...\n");
  try {
    const auth = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
    const response = await fetch("https://api.dropbox.com/oauth2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${auth}`,
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }).toString(),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("❌  Token exchange failed:", data.error_description || data.error);
      process.exit(1);
    }

    const refreshToken = data.refresh_token;
    console.log("=".repeat(60));
    console.log("✅  SUCCESS! Your refresh token:");
    console.log("=".repeat(60));
    console.log(refreshToken);
    console.log("=".repeat(60));

    // Auto-update .env
    const envPath = path.join(__dirname, ".env");
    let envContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

    // Remove old access token line, add/update refresh token
    envContent = envContent
      .split(/\r?\n/)
      .filter(l => !l.startsWith("DROPBOX_ACCESS_TOKEN") && !l.startsWith("DROPBOX_REFRESH_TOKEN"))
      .join("\n")
      .trim();

    envContent += `\nDROPBOX_REFRESH_TOKEN=${refreshToken}\n`;
    writeFileSync(envPath, envContent, "utf8");

    console.log("\n✅  .env updated automatically!");
    console.log("   DROPBOX_ACCESS_TOKEN removed (no longer needed)");
    console.log("   DROPBOX_REFRESH_TOKEN saved\n");
    console.log("▶   Now run: node .\\server.js\n");

  } catch (err) {
    console.error("❌  Error:", err.message);
    process.exit(1);
  }
});

server.listen(9876, "127.0.0.1", () => {
  console.log("⏳  Waiting for Dropbox to redirect back... (allow in browser)\n");
});

