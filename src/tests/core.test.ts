import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReport, normalizeAndValidateSegments } from "../core.js";

const rules = { minDb: -100, maxDb: 200, maxSegmentsPerVersion: 10000, maxQuerySpanMs: 10_000_000 };

describe("segmented Leq core", () => {
  it("aggregates equal 60/70 dB durations by linear energy", () => {
    const segments = normalizeAndValidateSegments(
      [
        { start: 0, end: 1000, leqDb: 60 },
        { start: 1000, end: 2000, leqDb: 70 },
      ],
      rules.minDb,
      rules.maxDb,
      rules.maxSegmentsPerVersion,
    );
    const report = buildReport({
      datasetId: "x",
      datasetName: "x",
      version: 1,
      windowStart: 0,
      windowEnd: 2000,
      segments,
    });
    assert.equal(report.status, "COMPLETE");
    assert.ok(Math.abs((report.measuredPartLeqDbRounded6 ?? NaN) - 67.403627) < 1e-6);
    assert.equal(report.gaps.length, 0);
    assert.ok(Math.abs(report.coverageRatio - 1) < 1e-12);
  });

  it("matches an independent hand calculation and reconstructs contributions", () => {
    const segments = normalizeAndValidateSegments(
      [
        { segmentId: "low", start: 0, end: 2000, leqDb: 60 },
        { segmentId: "high", start: 2000, end: 5000, leqDb: 70 },
      ],
      rules.minDb,
      rules.maxDb,
      rules.maxSegmentsPerVersion,
    );
    const report = buildReport({
      datasetId: "hand",
      datasetName: "hand",
      version: 1,
      windowStart: 1000,
      windowEnd: 4000,
      segments,
    });
    const e60 = 1000 * 10 ** 6;
    const e70 = 2000 * 10 ** 7;
    const expected = 10 * Math.log10((e60 + e70) / 3000);
    assert.ok(Math.abs((report.measuredPartLeqDb ?? NaN) - expected) < 1e-10);
    assert.equal(report.contributions[0].linearEnergyWeight, e60);
    assert.equal(report.contributions[1].linearEnergyWeight, e70);
    assert.ok(Math.abs(report.contributions[0].relativeEnergyContributionPercent - (e60 / (e60 + e70)) * 100) < 1e-10);
    assert.equal(report.reconstruction.recomputedLeqDb, Number(expected.toFixed(6)));
  });

  it("is unchanged by splitting, merging, input order, and common duration scaling", () => {
    const make = (data: Array<[number, number, number]>) =>
      normalizeAndValidateSegments(
        data.map(([start, end, leqDb], index) => ({ start, end, leqDb, segmentId: `s${index}` })),
        rules.minDb,
        rules.maxDb,
        rules.maxSegmentsPerVersion,
      );
    const one = make([[0, 4000, 65]]);
    const split = make([
      [0, 1234, 65],
      [1234, 4000, 65],
    ]);
    const reordered = make([
      [3000, 4000, 70],
      [0, 1000, 60],
      [1000, 3000, 65],
    ]);
    const scaled = make([
      [0, 2000, 60],
      [2000, 6000, 65],
      [6000, 8000, 70],
    ]);
    const original = make([
      [0, 1000, 60],
      [1000, 3000, 65],
      [3000, 4000, 70],
    ]);
    const sameLevel = buildReport({ datasetId: "i", datasetName: "i", version: 1, windowStart: 0, windowEnd: 4000, segments: one }).measuredPartLeqDb;
    const splitValue = buildReport({ datasetId: "i", datasetName: "i", version: 1, windowStart: 0, windowEnd: 4000, segments: split }).measuredPartLeqDb;
    const orderedValue = buildReport({ datasetId: "i", datasetName: "i", version: 1, windowStart: 0, windowEnd: 4000, segments: original }).measuredPartLeqDb;
    const reorderedValue = buildReport({ datasetId: "i", datasetName: "i", version: 1, windowStart: 0, windowEnd: 4000, segments: reordered }).measuredPartLeqDb;
    const scaledValue = buildReport({ datasetId: "i", datasetName: "i", version: 1, windowStart: 0, windowEnd: 8000, segments: scaled }).measuredPartLeqDb;
    assert.equal(splitValue, sameLevel);
    assert.ok(Math.abs((reorderedValue ?? NaN) - (orderedValue ?? NaN)) < 1e-10);
    assert.ok(Math.abs((scaledValue ?? NaN) - (orderedValue ?? NaN)) < 1e-10);
  });

  it("clips partial segments and preserves missing duration rather than zero dB", () => {
    const segments = normalizeAndValidateSegments(
      [{ start: 0, end: 1000, leqDb: 70 }],
      rules.minDb,
      rules.maxDb,
      rules.maxSegmentsPerVersion,
    );
    const report = buildReport({
      datasetId: "p",
      datasetName: "p",
      version: 1,
      windowStart: 500,
      windowEnd: 2500,
      segments,
    });
    assert.equal(report.status, "PARTIAL");
    assert.equal(report.measuredPartLeqDbRounded6, 70);
    assert.deepEqual(report.gaps, [{ start: 1000, end: 2500, durationMs: 1500 }]);
    assert.equal(report.measuredDurationMs + report.gaps.reduce((sum, gap) => sum + gap.durationMs, 0), report.windowDurationMs);
    assert.match(report.label, /含缺测/);
  });

  it("returns no numeric result for no coverage", () => {
    const report = buildReport({
      datasetId: "n",
      datasetName: "n",
      version: 1,
      windowStart: 9000,
      windowEnd: 10000,
      segments: [],
    });
    assert.equal(report.status, "NO_COVERAGE");
    assert.equal(report.measuredPartLeqDb, null);
    assert.equal(report.measuredPartLeqDbRounded6, null);
    assert.equal(report.gaps[0].durationMs, 1000);
  });

  it("rejects overlap, non-positive duration, NaN, and out-of-range values", () => {
    assert.throws(() => normalizeAndValidateSegments([{ start: 0, end: 2, leqDb: 60 }, { start: 1, end: 3, leqDb: 60 }], -100, 200, 10), /重叠/);
    assert.throws(() => normalizeAndValidateSegments([{ start: 1, end: 1, leqDb: 60 }], -100, 200, 10), /时长/);
    assert.throws(() => normalizeAndValidateSegments([{ start: 0, end: 1, leqDb: Number.NaN }], -100, 200, 10), /有限/);
    assert.throws(() => normalizeAndValidateSegments([{ start: 0, end: 1, leqDb: 201 }], -100, 200, 10), /范围/);
  });
});
