import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LeqService } from "./service.js";
import { AppError, HTTP_STATUS, type ErrorCode } from "./errors.js";
import { dbPath } from "./config.js";
import { exportCsv, exportJson } from "./export.js";

interface RouteContext {
  service: LeqService;
  body: unknown;
  params: Record<string, string>;
  query: URLSearchParams;
}

type RouteHandler = (ctx: RouteContext) => { status?: number; body?: unknown; contentType?: string };

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
}

function route(method: string, path: string, handler: RouteHandler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([A-Za-z]+)/g, (_m, key: string) => {
      keys.push(key);
      return "([^/]+)";
    })}$`,
  );
  return { method, pattern, keys, handler };
}

const ROUTES: Route[] = [
  route("POST", "/api/points", ({ service, body }) => {
    const b = (body ?? {}) as { id?: unknown; name?: unknown };
    return { status: 201, body: service.createPoint(b.id, b.name) };
  }),
  route("GET", "/api/points", ({ service }) => ({ body: { points: service.listPoints() } })),
  route("POST", "/api/points/:pointId/segments/validate", ({ service, body, params }) => {
    const b = (body ?? {}) as { segments?: unknown };
    return { body: service.validateIntervals(b.segments) };
  }),
  route("POST", "/api/points/:pointId/segments", ({ service, body, params }) => {
    const b = (body ?? {}) as { segments?: unknown };
    return { status: 201, body: service.importBatch(params.pointId, b.segments, { autoSegId: true }) };
  }),
  route("POST", "/api/points/:pointId/query", ({ service, body, params, query }) => {
    const b = (body ?? {}) as { startMs?: unknown; endMs?: unknown; version?: unknown; persist?: boolean };
    const persist = query.get("persist") === "1" || b.persist === true;
    return {
      body: service.queryWindow(
        params.pointId,
        { startMs: b.startMs, endMs: b.endMs },
        { version: b.version, persist },
      ),
    };
  }),
  route("GET", "/api/reports/:queryId", ({ service, params, query }) => {
    const stored = service.getReport(Number(params.queryId));
    const format = query.get("format");
    if (format === "csv") {
      return { contentType: "text/csv; charset=utf-8", body: exportCsv(stored.report) };
    }
    return { body: stored };
  }),
];

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new AppError("LIMIT_EXCEEDED", "请求体超过 5 MB 限制"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError("INVALID_PARAM", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createApp(service: LeqService): Server {
  const server = createServer(async (req, res) => {
    await handle(service, req, res);
  });
  return server;
}

async function handle(service: LeqService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, payload: unknown, contentType = "application/json; charset=utf-8") => {
    res.writeHead(status, { "content-type": contentType });
    res.end(
      typeof payload === "string" && contentType.startsWith("text/")
        ? payload
        : JSON.stringify(payload, null, 2),
    );
  };
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      send(200, { ok: true, dbPath: dbPath() });
      return;
    }
    const matched = ROUTES.find(
      (r) => r.method === req.method && r.pattern.test(url.pathname),
    );
    if (!matched) {
      send(404, { error: { code: "NOT_FOUND", message: `无此路由: ${req.method} ${url.pathname}` } });
      return;
    }
    const match = url.pathname.match(matched.pattern)!;
    const params: Record<string, string> = {};
    matched.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(match[i + 1]!);
    });
    const body = req.method === "POST" ? await readJson(req) : {};
    const result = matched.handler({ service, body, params, query: url.searchParams });
    const status = result.status ?? 200;
    if (result.contentType) {
      send(status, result.body as string, result.contentType);
    } else {
      send(status, result.body);
    }
  } catch (err) {
    if (err instanceof AppError) {
      const code = err.code as ErrorCode;
      const status = code === "EMPTY_RESULT" ? 200 : HTTP_STATUS[code] ?? 500;
      send(status, { error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    send(500, {
      error: { code: "INVALID_PARAM", message: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** 在指定端口尝试监听；端口 0 或被占用时回退到操作系统分配的空闲端口。 */
export function listenOnFreePort(server: Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, fallback: boolean) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (!fallback && (err.code === "EADDRINUSE" || err.code === "EACCES")) {
          tryListen(0, true);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("无法获取监听端口"));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    };
    tryListen(preferredPort, preferredPort === 0);
  });
}

function parsePort(argv: string[]): number {
  const idx = argv.indexOf("--port");
  if (idx >= 0 && argv[idx + 1]) {
    const port = Number(argv[idx + 1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`--port 必须是 0~65535 的整数，收到 ${argv[idx + 1]}`);
    }
    return port;
  }
  if (process.env.LEQ_PORT) {
    const port = Number(process.env.LEQ_PORT);
    if (Number.isInteger(port) && port >= 0 && port <= 65535) return port;
  }
  return 0;
}

const isMain = process.argv[1]?.endsWith("server.js");
if (isMain) {
  const service = new LeqService();
  const server = createApp(service);
  const preferred = parsePort(process.argv.slice(2));
  listenOnFreePort(server, preferred)
    .then((port) => {
      console.log(`[leq-service] HTTP 已启动: http://127.0.0.1:${port}`);
      console.log(`[leq-service] 数据文件: ${dbPath()}（LEQ_PORT / LEQ_DB_PATH 可覆盖）`);
    })
    .catch((err) => {
      console.error("[leq-service] 启动失败:", err);
      process.exit(1);
    });
}

export { exportJson };
