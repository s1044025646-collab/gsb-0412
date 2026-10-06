#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { LeqService } from "./service.js";
import { AppError } from "./errors.js";
import { dbPath } from "./config.js";
import { exportCsv, exportJson, explainText } from "./export.js";

function usage(): string {
  return [
    "用法: leq <命令> [参数]",
    "命令:",
    "  create-point <pointId> [name]            创建测点数据集",
    "  list-points                              列出测点",
    "  validate <segments.json>                 仅校验区间与声级，不写库",
    "  import <pointId> <segments.json>         批量导入（原子事务，建立新版本）",
    "  query <pointId> <startMs> <endMs> [--version N] [--persist]",
    "                                           查询窗口；--persist 持久化报告",
    "  explain <queryId>                        解释已保存报告的逐段贡献与缺口",
    "  export <queryId> <csv|json> [outFile]    导出已保存报告",
    "环境: LEQ_DB_PATH（默认 data/leq.sqlite）",
  ].join("\n");
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new AppError("INVALID_PARAM", `无法读取/解析 JSON 文件 ${file}: ${(err as Error).message}`);
  }
}

function extractSegments(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray((payload as { segments?: unknown }).segments)) {
    return (payload as { segments: unknown }).segments;
  }
  throw new AppError("INVALID_PARAM", "JSON 顶层必须是段数组，或含 segments 数组的对象");
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const service = new LeqService();

  switch (cmd) {
    case "create-point": {
      const [id, name] = rest;
      if (!id) throw new AppError("INVALID_PARAM", "缺少 pointId");
      console.log(JSON.stringify(service.createPoint(id, name), null, 2));
      return 0;
    }
    case "list-points": {
      console.log(JSON.stringify({ points: service.listPoints() }, null, 2));
      return 0;
    }
    case "validate": {
      const [file] = rest;
      if (!file) throw new AppError("INVALID_PARAM", "缺少 segments.json");
      console.log(JSON.stringify(service.validateIntervals(extractSegments(readJsonFile(file))), null, 2));
      return 0;
    }
    case "import": {
      const [pointId, file] = rest;
      if (!pointId || !file) throw new AppError("INVALID_PARAM", "用法: import <pointId> <segments.json>");
      const result = service.importBatch(pointId, extractSegments(readJsonFile(file)), {
        autoSegId: true,
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return 0;
    }
    case "query": {
      const positional = rest.filter((a) => !a.startsWith("--"));
      const flags = rest.filter((a) => a.startsWith("--"));
      const [pointId, startRaw, endRaw] = positional;
      if (!pointId || startRaw === undefined || endRaw === undefined) {
        throw new AppError("INVALID_PARAM", "用法: query <pointId> <startMs> <endMs> [--version N] [--persist]");
      }
      let version: unknown;
      const vi = flags.indexOf("--version");
      if (vi >= 0) version = Number(rest[rest.indexOf("--version") + 1]);
      const persist = flags.includes("--persist");
      const report = service.queryWindow(
        pointId,
        { startMs: Number(startRaw), endMs: Number(endRaw) },
        { version, persist },
      );
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    case "explain": {
      const [queryIdRaw] = rest;
      const stored = service.getReport(Number(queryIdRaw));
      console.log(explainText(stored.report));
      return 0;
    }
    case "export": {
      const [queryIdRaw, format, outFile] = rest;
      if (!queryIdRaw || !format) {
        throw new AppError("INVALID_PARAM", "用法: export <queryId> <csv|json> [outFile]");
      }
      const stored = service.getReport(Number(queryIdRaw)).report;
      const content = format === "csv" ? exportCsv(stored) : format === "json" ? exportJson(stored) : null;
      if (content === null) throw new AppError("INVALID_PARAM", "format 只能是 csv 或 json");
      if (outFile) {
        writeFileSync(outFile, content, "utf-8");
        console.log(`已导出到 ${outFile}`);
      } else {
        process.stdout.write(content + (format === "json" ? "\n" : ""));
      }
      return 0;
    }
    case undefined:
    case "--help":
    case "-h":
      console.log(usage());
      return 0;
    default:
      throw new AppError("INVALID_PARAM", `未知命令: ${cmd}\n\n${usage()}`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    void dbPath;
    process.exit(code);
  })
  .catch((err: unknown) => {
    if (err instanceof AppError) {
      console.error(`错误 [${err.code}]: ${err.message}`);
      if (err.details !== undefined) console.error(JSON.stringify(err.details, null, 2));
      process.exit(2);
    }
    console.error("错误:", err);
    process.exit(1);
  });
