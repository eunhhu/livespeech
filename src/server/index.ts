import { timingSafeEqual } from "node:crypto";
import index from "../web/index.html";
import { isSupportedLanguage } from "../shared/languages";
import { TRANSLATE_MODEL, type HealthResponse, type TokenRequest } from "../shared/protocol";
import { hasApiKey, mintTranslateToken } from "./token";

const PORT = Number(process.env.PORT ?? 3000);
const ACCESS_CODE = process.env.ACCESS_CODE ?? "";
const isProd = process.env.NODE_ENV === "production";

// Browsers only expose the mic on https or localhost. For phones reaching this machine
// over LAN/VPN, `bun run cert` creates .certs/*.pem which are picked up here.
const TLS_CERT = process.env.TLS_CERT ?? new URL("../../.certs/cert.pem", import.meta.url).pathname;
const TLS_KEY = process.env.TLS_KEY ?? new URL("../../.certs/key.pem", import.meta.url).pathname;
const tls =
  (await Bun.file(TLS_CERT).exists()) && (await Bun.file(TLS_KEY).exists())
    ? { cert: Bun.file(TLS_CERT), key: Bun.file(TLS_KEY) }
    : undefined;

// Conversation mode opens 2 sessions and connections rotate every ~10 min,
// so a legitimate client needs only a handful of tokens per minute.
const RATE_LIMIT = { windowMs: 60_000, max: 20 };
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT.max;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (e.resetAt < now) hits.delete(ip);
}, RATE_LIMIT.windowMs).unref();

function accessCodeOk(req: Request): boolean {
  if (!ACCESS_CODE) return true;
  const given = Buffer.from(req.headers.get("x-access-code") ?? "");
  const expected = Buffer.from(ACCESS_CODE);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const publicFile = (name: string, type: string) =>
  new Response(Bun.file(new URL(`../web/${name}`, import.meta.url)), {
    headers: { "content-type": type, "cache-control": "public, max-age=3600" },
  });

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  tls,
  development: !isProd && { hmr: true, console: true },

  routes: {
    "/": index,
    "/manifest.webmanifest": publicFile("manifest.webmanifest", "application/manifest+json"),
    "/icon.svg": publicFile("icon.svg", "image/svg+xml"),

    // Dev only: lets a phone download + trust the self-signed cert (iOS: install profile).
    "/dev-cert.crt": () =>
      tls && !isProd
        ? new Response(Bun.file(TLS_CERT), { headers: { "content-type": "application/x-x509-ca-cert" } })
        : new Response("Not found", { status: 404 }),

    "/api/health": () =>
      Response.json({
        ok: true,
        accessCodeRequired: ACCESS_CODE !== "",
        model: TRANSLATE_MODEL,
      } satisfies HealthResponse),

    "/api/token": {
      POST: async (req, srv) => {
        const ip =
          req.headers.get("cf-connecting-ip") ?? srv.requestIP(req)?.address ?? "unknown";
        if (rateLimited(ip)) return Response.json({ error: "rate_limited" }, { status: 429 });
        if (!accessCodeOk(req)) return Response.json({ error: "bad_access_code" }, { status: 401 });

        const body = (await req.json().catch(() => null)) as Partial<TokenRequest> | null;
        if (!isSupportedLanguage(body?.targetLanguageCode)) {
          return Response.json({ error: "unsupported_language" }, { status: 400 });
        }
        if (!hasApiKey) {
          return Response.json({ error: "server_missing_api_key" }, { status: 500 });
        }

        try {
          return Response.json(await mintTranslateToken(body.targetLanguageCode));
        } catch (err) {
          console.error("[token] mint failed:", err);
          return Response.json({ error: "token_mint_failed" }, { status: 502 });
        }
      },
    },
  },

  fetch: () => new Response("Not found", { status: 404 }),
});

console.log(`livespeech listening on ${server.url}`);
if (tls) console.log(`   TLS: ${TLS_CERT}`);
else console.log("   (http only — phones need https for the mic; run `bun run cert`)");
if (!hasApiKey) console.warn("⚠️  GEMINI_API_KEY is not set — /api/token will fail.");
if (!ACCESS_CODE) console.warn("⚠️  ACCESS_CODE is not set — anyone who can reach this server can mint tokens.");
