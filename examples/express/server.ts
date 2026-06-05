/**
 * Express server with Better Auth + DynamoDB adapter.
 *
 * Start:    npm run dev
 * Requires: DynamoDB Local running (npm run docker:up)
 *           Tables created (npm run setup)
 */

import express from "express";
import { auth } from "./auth";

const app = express();

// ── Auth routes ─────────────────────────────────────────────────
// Use raw body parser so Better Auth receives the unprocessed body
// (it handles its own JSON / form data parsing internally).
app.use("/api/auth", express.raw({ type: "*/*" }));

app.all("/api/auth/*", async (req, res) => {
  const protocol = req.secure ? "https" : "http";
  const host = req.get("host") || "localhost:3000";
  const url = `${protocol}://${host}${req.originalUrl}`;

  // Build a web-standard Request from the Express req
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      if (Array.isArray(value)) {
        headers.set(key, value.join(", "));
      } else {
        headers.set(key, value);
      }
    }
  }

  const body =
    req.method !== "GET" && req.method !== "HEAD" && Buffer.isBuffer(req.body)
      ? req.body
      : undefined;

  const webReq = new Request(url, { method: req.method, headers, body });
  const response = await auth.handler(webReq);

  // Proxy the response back to Express
  res.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "transfer-encoding") {
      res.setHeader(key, value);
    }
  });

  const responseBody = await response.text();
  if (responseBody) {
    res.send(responseBody);
  } else {
    res.end();
  }
});

// ── Health check ────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`   Auth:  http://localhost:${PORT}/api/auth/*`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
