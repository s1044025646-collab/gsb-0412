import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo, isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { LeqStore } from "./db.js";
import { isAppError } from "./errors.js";
import { reportToCsv, reportToJson } from "./export.js";
import type { LeqReport } from "./types.js";

export interface HttpOptions {
  dbPath?: string;
  port?: number;
  host?: string;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("请求体必须是合法 JSON。");
    (error as Error & { code?: string }).code = "INVALID_JSON";
    throw error;
  }
}

function send(res: ServerResponse, status: number, payload: unknown, contentType = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(contentType.startsWith("application/json") ? JSON.stringify(payload, null, 2) : String(payload));
}

function sendError(res: ServerResponse, error: unknown) {
  if (isAppError(error)) {
    send(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  const code = (error as { code?: string }).code;
  if (code === "INVALID_JSON") {
    send(res, 400, { error: { code, message: (error as Error).message } });
    return;
  }
  send(res, 500, {
    error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "未知错误。" },
  });
}

export function createApp(store: LeqStore): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.replace(/\/+$/, "") || "/";
        const method = req.method ?? "GET";

        if (method === "GET" && path === "/health") {
          send(res, 200, { ok: true, service: "offline-leq" });
          return;
        }
        if (method === "GET" && path === "/datasets") {
          send(res, 200, { datasets: store.listDatasets() });
          return;
        }
        if (method === "POST" && path === "/datasets") {
          const body = (await readJson(req)) as { id?: string; name: string; rules?: never };
          send(res, 201, { dataset: store.createDataset(body) });
          return;
        }

        const datasetMatch = /^\/datasets\/([^/]+)$/.exec(path);
        if (method === "GET" && datasetMatch) {
          send(res, 200, { dataset: store.getDatasetOrThrow(decodeURIComponent(datasetMatch[1])) });
          return;
        }

        const importMatch = /^\/datasets\/([^/]+)\/segments$/.exec(path);
        if (method === "POST" && importMatch) {
          const datasetId = decodeURIComponent(importMatch[1]);
          const body = (await readJson(req)) as { segments?: unknown; mode?: "append" | "replace" };
          send(res, 201, {
            result: store.importSegments(datasetId, body.segments, { mode: body.mode }),
          });
          return;
        }

        const validateMatch = /^\/datasets\/([^/]+)\/validate$/.exec(path);
        if (method === "POST" && validateMatch) {
          const body = (await readJson(req)) as { version?: number };
          send(res, 200, {
            validation: store.validateDataset(decodeURIComponent(validateMatch[1]), body.version),
          });
          return;
        }

        if (method === "POST" && path === "/query") {
          const body = (await readJson(req)) as {
            datasetId?: string;
            start?: number;
            end?: number;
            version?: number;
          };
          if (!body.datasetId) {
            send(res, 400, { error: { code: "MISSING_DATASET_ID", message: "datasetId 不能为空。" } });
            return;
          }
          send(res, 200, {
            report: store.query({
              datasetId: body.datasetId,
              start: body.start as number,
              end: body.end as number,
              version: body.version,
            }),
          });
          return;
        }

        const reportMatch = /^\/reports\/(\d+)$/.exec(path);
        if (method === "GET" && reportMatch) {
          const report = store.getReport(Number(reportMatch[1]));
          const format = url.searchParams.get("format") ?? "json";
          if (format === "csv") {
            send(res, 200, reportToCsv(report), "text/csv; charset=utf-8");
            return;
          }
          if (format === "json") {
            send(res, 200, { report });
            return;
          }
          send(res, 400, { error: { code: "INVALID_FORMAT", message: "format 只能是 json 或 csv。" } });
          return;
        }

        if (method === "GET" && path === "/reports") {
          const datasetId = url.searchParams.get("datasetId");
          if (!datasetId) {
            send(res, 400, { error: { code: "MISSING_DATASET_ID", message: "datasetId 查询参数不能为空。" } });
            return;
          }
          send(res, 200, { reports: store.listReports(datasetId) });
          return;
        }

        send(res, 404, { error: { code: "NOT_FOUND", message: "未找到对应 API 路由。" } });
      } catch (error) {
        sendError(res, error);
      }
    })();
  });
}

export function startServer(options: HttpOptions = {}): Promise<{ server: Server; port: number; store: LeqStore }> {
  const dbPath = resolve(options.dbPath ?? process.env.LEQ_DB ?? "data/leq.sqlite");
  const store = new LeqStore(dbPath);
  const server = createApp(store);
  const port = options.port ?? Number(process.env.PORT ?? 0);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  return new Promise((resolveServer) => {
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo;
      resolveServer({ server, port: address.port, store });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(({ port }) => {
    console.log(`Offline Leq API listening on http://127.0.0.1:${port}`);
    console.log("SQLite database: data/leq.sqlite (override with LEQ_DB)");
  });
}
