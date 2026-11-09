import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { authorizeOrigin, normalizeAuthorizedOrigin, readSecurityConfig } from "../lib.js";
import { startBridge } from "../index.js";

test("安全本机模式隔离 Origin、Host、凭证并支持预检", async () => {
  const dir = join(process.cwd(), `.security-test-${randomUUID()}`);
  const saved = { ...process.env };
  mkdirSync(dir);
  let server;
  try {
    process.env.BLENDER_SECURITY_DIR = dir;
    process.env.BLENDER_PORT = "0";
    delete process.env.BLENDER_BIND;
    delete process.env.BLENDER_SHARED;
    const origin = "https://canvas.example:8443";
    const token = authorizeOrigin(origin);
    const other = authorizeOrigin("https://other.example");
    assert.equal(readSecurityConfig().origins[origin], token);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "authorized-origins.json")).mode & 0o077, 0);
    for (const bad of ["null", "*", "https://example.com/", "https://example.com/path", "https://user@example.com", "file:///x"]) {
      assert.throws(() => normalizeAuthorizedOrigin(bad));
    }

    server = startBridge({ secureLocal: true });
    await new Promise((resolve) => server.once("listening", resolve));
    const port = server.address().port;
    const call = (headers = {}, method = "GET", path = "/presets") => new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
    const preflight = await call({ origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type", "access-control-request-private-network": "true" }, "OPTIONS");
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], origin);
    assert.equal(preflight.headers["access-control-allow-private-network"], "true");
    assert.match(preflight.headers["access-control-allow-methods"], /DELETE/);
    const evil = await call({ origin: "https://evil.example", authorization: `Bearer ${token}` });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
    const badHost = await call({ host: `evil.example:${port}`, origin, authorization: `Bearer ${token}` });
    assert.equal(badHost.status, 403);
    assert.equal(badHost.headers["access-control-allow-origin"], undefined);
    assert.equal((await call({ authorization: `Bearer ${token}` })).status, 403);
    assert.equal((await call({ origin })).status, 401);
    assert.equal((await call({ origin, authorization: `Bearer ${other}` })).status, 401);
    const ok = await call({ origin, authorization: `Bearer ${token}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["access-control-allow-origin"], origin);
    assert.doesNotMatch(ok.body, new RegExp(token));
    const health = await call({ origin, authorization: `Bearer ${token}` }, "GET", "/health");
    const healthBody = JSON.parse(health.body);
    assert.match(healthBody.bridgeInstanceId, /^[0-9a-f-]{36}$/);
    assert.equal(healthBody.secureLocal, true);
    const rotated = authorizeOrigin(origin);
    assert.notEqual(rotated, token);
    assert.equal(readSecurityConfig().origins[origin], rotated);
    await new Promise((resolve) => server.close(resolve));
    server = startBridge({ secureLocal: true });
    await new Promise((resolve) => server.once("listening", resolve));
    const newPort = server.address().port;
    const restartedHealth = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: newPort, path: "/health", headers: { origin, authorization: `Bearer ${rotated}` } }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve(JSON.parse(body)));
      });
      req.on("error", reject);
      req.end();
    });
    assert.notEqual(restartedHealth.bridgeInstanceId, healthBody.bridgeInstanceId);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const key of ["BLENDER_SECURITY_DIR", "BLENDER_PORT", "BLENDER_BIND", "BLENDER_SHARED"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
