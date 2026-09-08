import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { toApiCallTask } from "./api-shape.js";
import { FakeCalleProvider, type FakeProviderOptions } from "./fake.js";
import { type CreateBatchInput, ProviderError } from "./provider.js";

/**
 * HTTP stand-in for `https://api.heycall-e.com` so the *live* adapter and
 * the official SDK can be exercised end to end, including terminal webhook
 * delivery with the `CALL-E-Event-Id` header, without any credentials.
 */
export interface FakeServer {
  server: Server;
  baseUrl: string;
  provider: FakeCalleProvider;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: ProviderError): void {
  send(res, error.status ?? 500, { error: { code: error.code, message: error.message, details: {} } });
}

export async function startFakeServer(options: { apiKey: string; provider?: FakeProviderOptions; port?: number } ): Promise<FakeServer> {
  const provider = new FakeCalleProvider({
    ...(options.provider ?? {}),
    onWebhook: async (url, event) => {
      const body = JSON.stringify({ id: event.id, type: event.type, created_at: event.createdAt, data: toApiCallTask(event.call) });
      await fetch(url, { method: "POST", headers: { "content-type": "application/json", "CALL-E-Event-Id": event.id }, body }).catch(() => undefined);
      await options.provider?.onWebhook?.(url, event);
    }
  });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${options.apiKey}`) {
        send(res, 401, { error: { code: "unauthorized", message: "Missing or invalid API key.", details: {} } });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/calls") {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as Record<string, unknown>;
        const key = req.headers["idempotency-key"];
        const input: CreateBatchInput = {
          task: String(body.task ?? ""),
          recipients: ((body.recipients as Array<{ phones: string[]; region?: string; locale?: string }>) ?? []).map((r) => {
            const out: { phone: string; region?: string; locale?: string } = { phone: r.phones?.[0] ?? "" };
            if (r.region) {
              out.region = r.region;
            }
            if (r.locale) {
              out.locale = r.locale;
            }
            return out;
          }),
          recipientResultSchema: (body.recipient_result_schema as Record<string, unknown>) ?? {},
          metadata: (body.metadata as Record<string, unknown>) ?? {}
        };
        if (body.result_schema) {
          input.resultSchema = body.result_schema as Record<string, unknown>;
        }
        if (typeof body.webhook_url === "string") {
          input.webhookUrl = body.webhook_url;
        }
        const call = await provider.create(input, typeof key === "string" ? key : "");
        send(res, 201, toApiCallTask(call));
        return;
      }
      const eventsMatch = /^\/v1\/calls\/([^/]+)\/events$/.exec(url.pathname);
      if (req.method === "GET" && eventsMatch) {
        const events = await provider.listEvents(eventsMatch[1] ?? "");
        send(res, 200, {
          object: "list",
          data: events.map((e) => ({ id: e.id, type: e.type, call_id: e.callId, created_at: e.createdAt, level: e.level, status: e.status, message: e.message, details: e.details })),
          next_cursor: null
        });
        return;
      }
      const getMatch = /^\/v1\/calls\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && getMatch) {
        const call = await provider.get(getMatch[1] ?? "");
        send(res, 200, toApiCallTask(call));
        return;
      }
      send(res, 404, { error: { code: "not_found", message: "No such route.", details: {} } });
    } catch (error) {
      if (error instanceof ProviderError) {
        sendError(res, error);
        return;
      }
      send(res, 500, { error: { code: "internal_error", message: error instanceof Error ? error.message : String(error), details: {} } });
    }
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    provider,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}
