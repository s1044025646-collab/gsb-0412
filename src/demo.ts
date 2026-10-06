import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { LeqStore } from "./db.js";
import { reportToJson } from "./export.js";

const dbPath = resolve("data/demo.sqlite");
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

const store = new LeqStore(dbPath);
store.createDataset({ id: "demo-point", name: "演示测点" });
store.importSegments(
  "demo-point",
  [
    { segmentId: "a", start: 0, end: 1000, leqDb: 60 },
    { segmentId: "b", start: 1000, end: 2000, leqDb: 70 },
  ],
  { mode: "replace" },
);

const full = store.query({ datasetId: "demo-point", start: 0, end: 2000 });
const clipped = store.query({ datasetId: "demo-point", start: 500, end: 1500 });
const partial = store.query({ datasetId: "demo-point", start: 1500, end: 3000 });
const empty = store.query({ datasetId: "demo-point", start: 3000, end: 4000 });

console.log("1) 完整窗口：60 dB 与 70 dB 各 1000 ms");
console.log(`Leq=${full.measuredPartLeqDbRounded6} dB，算术平均会错误得到 65 dB`);
console.log("2) 从两段中间裁剪：各取 500 ms，仍按段内能量均匀假设估算");
console.log(`Leq=${clipped.measuredPartLeqDbRounded6} dB`);
console.log("3) 含缺口窗口：");
console.log(reportToJson(partial));
console.log("4) 完全无覆盖窗口：");
console.log(reportToJson(empty));
console.log(`\n演示数据库: ${dbPath}`);
store.close();
