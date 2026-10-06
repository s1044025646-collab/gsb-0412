import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LeqStore } from "../db.js";

describe("SQLite persistence and transactions", () => {
  let path: string;
  let store: LeqStore;

  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), "leq-")), "test.sqlite");
    store = new LeqStore(path);
  });

  afterEach(() => store.close());

  it("rolls back an entire invalid batch and persists across reopening", () => {
    store.createDataset({ id: "p1", name: "point" });
    store.importSegments("p1", [{ start: 0, end: 1000, leqDb: 60 }]);
    assert.throws(() =>
      store.importSegments("p1", [
        { start: 2000, end: 3000, leqDb: 61 },
        { start: 500, end: 1500, leqDb: 62 },
      ]),
    );
    assert.equal(store.validateDataset("p1").version, 1);
    store.close();
    store = new LeqStore(path);
    const report = store.query({ datasetId: "p1", start: 0, end: 1000 });
    assert.equal(report.measuredPartLeqDbRounded6, 60);
    assert.ok(report.reportId);
  });

  it("keeps historical reports tied to old versions after replacement", () => {
    store.createDataset({ id: "p2", name: "point" });
    store.importSegments("p2", [{ start: 0, end: 1000, leqDb: 60 }]);
    const oldReport = store.query({ datasetId: "p2", start: 0, end: 1000 });
    store.importSegments("p2", [{ start: 0, end: 1000, leqDb: 70 }], { mode: "replace" });
    const newReport = store.query({ datasetId: "p2", start: 0, end: 1000 });
    assert.equal(oldReport.version, 1);
    assert.equal(newReport.version, 2);
    assert.equal(store.getReport(oldReport.reportId!).measuredPartLeqDbRounded6, 60);
    assert.equal(newReport.measuredPartLeqDbRounded6, 70);
  });
});
