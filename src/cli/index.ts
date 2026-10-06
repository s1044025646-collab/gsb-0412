#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startServer } from "../server.js";
import { LeqStore } from "../db.js";
import { isAppError } from "../errors.js";
import { reportToCsv, reportToJson } from "../export.js";

function usage() {
  console.log(`用法:
  leq create-dataset --id <id> --name <名称> [--db <sqlite路径>]
  leq list-datasets
  leq import <datasetId> --file <segments.json> [--mode append|replace]
  leq validate <datasetId> [--version <n>]
  leq query <datasetId> --start <毫秒> --end <毫秒> [--version <n>] [--format json|csv] [--out <文件>]
  leq report <reportId> [--format json|csv] [--out <文件>]
  leq list-reports <datasetId>
  leq serve [--port <端口，默认空闲>] [--host 127.0.0.1]

segments.json 示例:
{"segments":[{"segmentId":"s1","start":0,"end":1000,"leqDb":60}]}`);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        options.set(key, "true");
      } else {
        options.set(key, value);
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function requireOption(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (value === undefined) throw new Error(`缺少参数 --${key}`);
  return value;
}

function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(resolve(file), "utf8"));
}

function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`--${name} 必须是数字`);
  return number;
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || command === "help" || options.has("help")) {
    usage();
    return;
  }

  const dbPath = resolve(options.get("db") ?? process.env.LEQ_DB ?? "data/leq.sqlite");
  if (command === "serve") {
    const port = numberOption(options.get("port"), "port");
    const host = options.get("host");
    const started = await startServer({ dbPath, port, host });
    console.log(`Offline Leq API listening on http://${host ?? "127.0.0.1"}:${started.port}`);
    console.log(`SQLite database: ${dbPath}`);
    return;
  }

  const store = new LeqStore(dbPath);
  try {
    if (command === "create-dataset") {
      const name = requireOption(options, "name");
      const id = options.get("id");
      console.log(JSON.stringify({ dataset: store.createDataset({ id, name }) }, null, 2));
      return;
    }
    if (command === "list-datasets") {
      console.log(JSON.stringify({ datasets: store.listDatasets() }, null, 2));
      return;
    }
    if (command === "import") {
      const datasetId = positional[1];
      if (!datasetId) throw new Error("需要提供 datasetId");
      const file = requireOption(options, "file");
      const body = readJsonFile(file) as { segments?: unknown };
      const mode = (options.get("mode") ?? "append") as "append" | "replace";
      console.log(JSON.stringify({ result: store.importSegments(datasetId, body.segments, { mode }) }, null, 2));
      return;
    }
    if (command === "validate") {
      const datasetId = positional[1];
      if (!datasetId) throw new Error("需要提供 datasetId");
      console.log(JSON.stringify({ validation: store.validateDataset(datasetId, numberOption(options.get("version"), "version")) }, null, 2));
      return;
    }
    if (command === "query") {
      const datasetId = positional[1];
      if (!datasetId) throw new Error("需要提供 datasetId");
      const start = Number(requireOption(options, "start"));
      const end = Number(requireOption(options, "end"));
      const report = store.query({
        datasetId,
        start,
        end,
        version: numberOption(options.get("version"), "version"),
      });
      const format = options.get("format") ?? "json";
      const rendered = format === "csv" ? reportToCsv(report) : reportToJson(report);
      emit(rendered, options.get("out"));
      return;
    }
    if (command === "report") {
      const reportId = Number(positional[1]);
      const report = store.getReport(reportId);
      const format = options.get("format") ?? "json";
      emit(format === "csv" ? reportToCsv(report) : reportToJson(report), options.get("out"));
      return;
    }
    if (command === "list-reports") {
      const datasetId = positional[1];
      if (!datasetId) throw new Error("需要提供 datasetId");
      console.log(JSON.stringify({ reports: store.listReports(datasetId) }, null, 2));
      return;
    }
    usage();
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

function emit(content: string, out?: string) {
  if (out) writeFileSync(resolve(out), content, "utf8");
  else console.log(content);
}

main().catch((error: unknown) => {
  if (isAppError(error)) {
    console.error(JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } }, null, 2));
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
