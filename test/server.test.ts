import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { LeqService } from "../src/service.js";
import { createApp, listenOnFreePort } from "../src/server.js";
import { resetMigrationFlag } from "../src/db.js";
import type { Server } from "node:http";

let port: number;
let server: Server;
let svc: LeqService;

before(async () => {
  resetMigrationFlag();
  svc = new LeqService(":memory:");
  server = createApp(svc);
  port = await listenOnFreePort(server, 0);
});

after(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test("HTTP 端到端：创建、校验、导入、持久化查询、取报告", async () => {
  const health = await call("GET", "/health");
  assert.equal(health.status, 200);

  const created = await call("POST", "/api/points", { id: "P1", name: "API 测点" });
  assert.equal(created.status, 201);

  const bad = await call("POST", "/api/points/P1/segments", {
    segments: [{ startMs: 0, endMs: 100, levelDb: NaN }],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "INVALID_PARAM");

  const validated = await call("POST", "/api/points/P1/segments/validate", {
    segments: [{ startMs: 0, endMs: 1000, levelDb: 60 }],
  });
  assert.equal(validated.status, 200);
  assert.equal(validated.json.count, 1);

  const imported = await call("POST", "/api/points/P1/segments", {
    segments: [
      { startMs: 0, endMs: 1000, levelDb: 60 },
      { startMs: 1000, endMs: 2000, levelDb: 70 },
    ],
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.json.version, 1);

  const overlap = await call("POST", "/api/points/P1/segments", {
    segments: [{ startMs: 1500, endMs: 1600, levelDb: 90 }],
  });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.json.error.code, "OVERLAP_CONFLICT");

  const queried = await call("POST", "/api/points/P1/query?persist=1", {
    startMs: 0,
    endMs: 2000,
  });
  assert.equal(queried.status, 200);
  assert.ok(Math.abs(queried.json.leqDb - 67.4036) < 1e-3);
  assert.equal(queried.json.completeness, "complete");
  const queryId = queried.json.queryId;

  const report = await call("GET", `/api/reports/${queryId}`);
  assert.equal(report.status, 200);

  const csv = await fetch(`http://127.0.0.1:${port}/api/reports/${queryId}?format=csv`);
  assert.equal(csv.status, 200);
  const csvText = await csv.text();
  assert.match(csvText, /# label,/);
  assert.match(csvText, /contribution,/);

  const empty = await call("POST", "/api/points/P1/query", { startMs: 90000, endMs: 91000 });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.leqDb, null);
  assert.equal(empty.json.completeness, "empty");

  const missing = await call("GET", "/api/reports/99999");
  assert.equal(missing.status, 404);
});
