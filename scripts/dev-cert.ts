/**
 * Generates a self-signed dev certificate so phones on the LAN / VPN (e.g. WireGuard
 * 10.10.0.2) get a secure context — getUserMedia refuses plain http on anything but
 * localhost.
 *
 *   bun run cert                 # SANs: localhost, 127.0.0.1 + every local IPv4
 *   bun run cert 10.10.0.2 foo.lan
 *
 * Output: .certs/cert.pem, .certs/key.pem (picked up automatically by the server).
 */
import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";

const OUT = new URL("../.certs/", import.meta.url).pathname;

const extra = process.argv.slice(2);
const ips = new Set(["127.0.0.1"]);
const dns = new Set(["localhost"]);

for (const addrs of Object.values(networkInterfaces())) {
  for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) ips.add(a.address);
}
for (const h of extra) (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? ips : dns).add(h);

const san = [...[...dns].map((d) => `DNS:${d}`), ...[...ips].map((ip) => `IP:${ip}`)].join(",");

mkdirSync(OUT, { recursive: true });
const proc = Bun.spawnSync(
  [
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-days", "825", // iOS rejects TLS server certs valid for longer than 825 days
    "-keyout", `${OUT}key.pem`,
    "-out", `${OUT}cert.pem`,
    "-subj", "/CN=livespeech-dev",
    "-addext", `subjectAltName=${san}`,
    "-addext", "extendedKeyUsage=serverAuth",
    // CA:TRUE lets iOS "Certificate Trust Settings" fully trust it once installed as a profile.
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
  ],
  { stderr: "pipe" },
);

if (proc.exitCode !== 0) {
  console.error(proc.stderr.toString());
  process.exit(1);
}

console.log(`✓ ${OUT}cert.pem`);
console.log(`  SAN: ${san}`);
