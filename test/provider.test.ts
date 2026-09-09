import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCalleProvider } from "../src/calle/fake.js";
import { startFakeServer, type FakeServer } from "../src/calle/fake-server.js";
import { LiveCalleProvider } from "../src/calle/live.js";
import { ProviderError } from "../src/calle/provider.js";
import { buildRecipientResultSchema } from "../src/domain/task.js";

const input = (phones: string[]) => ({
  task: "Ask about amoxicillin.",
  recipients: phones.map((phone) => ({ phone, region: "US" })),
  recipientResultSchema: buildRecipientResultSchema(false),
  metadata: { dispatch_id: "dsp_1", product_label: "amoxicillin" }
});

describe("FakeCalleProvider", () => {
  it("honours idempotency keys exactly like the API", async () => {
    const fake = new FakeCalleProvider({ speed: "instant" });
    const a = await fake.create(input(["+14155550101"]), "key-1");
    const b = await fake.create(input(["+14155550101"]), "key-1");
    expect(b.id).toBe(a.id);
    await expect(fake.create(input(["+14155550102"]), "key-1")).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(fake.size).toBe(1);
  });
  it("rejects a missing key and a non-E.164 phone before anything is created", async () => {
    const fake = new FakeCalleProvider({ speed: "instant" });
    await expect(fake.create(input(["+14155550101"]), "")).rejects.toBeInstanceOf(ProviderError);
    await expect(fake.create(input(["415-555-0101"]), "k")).rejects.toMatchObject({ code: "invalid_phone" });
    expect(fake.size).toBe(0);
  });
  it("plays the resolved scenario and emits events", async () => {
    const fake = new FakeCalleProvider({ speed: "instant", resolver: () => "limited_human" });
    const call = await fake.create(input(["+14155550101", "+14155550102"]), "k2");
    expect(call.status).toBe("completed");
    expect(call.recipients.map((r) => r.structuredResult?.availability)).toEqual(["limited", "limited"]);
    expect(call.structuredResult).toEqual({ pharmacies_reached: 2 });
    const events = await fake.listEvents(call.id);
    expect(events.map((e) => e.type)).toContain("call.completed");
  });
});

describe("LiveCalleProvider against the fake HTTP server", () => {
  let server: FakeServer;
  let received: Array<{ headerId: string | undefined; body: Record<string, unknown> }> = [];
  let receiverUrl = "";
  const receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      received.push({ headerId: req.headers["call-e-event-id"] as string | undefined, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });

  beforeAll(async () => {
    server = await startFakeServer({ apiKey: "iams_live_test", provider: { speed: "instant", resolver: () => "in_stock_human" } });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhooks/calle`;
  });
  afterAll(async () => {
    await server.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });

  it("creates through the official SDK with the idempotency header and reads back snake_case results", async () => {
    const live = new LiveCalleProvider({ apiKey: "iams_live_test", baseUrl: server.baseUrl });
    const created = await live.create({ ...input(["+14155550101"]), webhookUrl: receiverUrl }, "sdk-key-1");
    expect(created.id).toMatch(/^call_fake_/);
    const again = await live.create({ ...input(["+14155550101"]), webhookUrl: receiverUrl }, "sdk-key-1");
    expect(again.id).toBe(created.id);
    const read = await live.get(created.id);
    expect(read.status).toBe("completed");
    expect(read.recipients[0]?.structuredResult?.availability).toBe("in_stock");
    expect(read.recipients[0]?.attempts[0]?.transcriptTurns.length).toBeGreaterThan(3);
    expect(read.metadata.dispatch_id).toBe("dsp_1");
    const events = await live.listEvents(created.id);
    expect(events.some((e) => e.type === "call.completed")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(1);
    expect(received[0]?.headerId).toBe(received[0]?.body.id);
    expect((received[0]?.body.data as { id: string }).id).toBe(created.id);
  });
  it("translates auth failures and unknown ids into ProviderErrors that are not retry-safe", async () => {
    const bad = new LiveCalleProvider({ apiKey: "wrong", baseUrl: server.baseUrl });
    await expect(bad.get("call_x")).rejects.toMatchObject({ code: "unauthorized", retrySafe: false });
    const live = new LiveCalleProvider({ apiKey: "iams_live_test", baseUrl: server.baseUrl });
    await expect(live.get("call_missing")).rejects.toMatchObject({ code: "not_found" });
  });
  it("reports an ambiguous transport failure on create as callStarted unknown", async () => {
    const live = new LiveCalleProvider({ apiKey: "iams_live_test", baseUrl: "http://127.0.0.1:9", fetch: async () => { throw new Error("socket hang up"); } });
    await expect(live.create(input(["+14155550101"]), "k")).rejects.toMatchObject({ code: "transport_ambiguous", callStarted: "unknown", retrySafe: false });
  });
});

describe("API-shaped terminal snapshot through the SDK parser", () => {
  it("parses a snake_case call task exactly as CALL-E returns it and classifies each recipient", async () => {
    const { readFileSync } = await import("node:fs");
    const { classifyRecipient } = await import("../src/domain/classify.js");
    const raw = readFileSync("test/fixtures/calle-call-completed.json", "utf8");
    const live = new LiveCalleProvider({
      apiKey: "iams_live_test",
      baseUrl: "https://api.heycall-e.com",
      fetch: async (request: Request) => {
        expect(request.headers.get("authorization")).toBe("Bearer iams_live_test");
        expect(request.url).toBe("https://api.heycall-e.com/v1/calls/call_01j9x2example");
        return new Response(raw, { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    const call = await live.get("call_01j9x2example");
    expect(call.status).toBe("completed");
    expect(call.metadata.dispatch_id).toBe("dsp_fixture");
    expect(call.recipients[0]?.attempts[0]?.transcriptTurns).toHaveLength(7);
    expect(call.recipients[1]?.status).toBe("skipped");
    const product = { name: "amoxicillin", strength: "400 mg/5 mL", form: "oral suspension" };
    const snap = (i: number) => {
      const r = call.recipients[i]!;
      const attempt = r.attempts[r.attempts.length - 1];
      return {
        recipientId: r.id,
        phone: r.phones[0] ?? "",
        status: r.status,
        structuredResult: r.structuredResult,
        transcript: (attempt?.transcriptTurns ?? []).map((t) => ({ speaker: t.speaker, text: t.text })),
        attemptFailureCode: attempt?.failureCode ?? null,
        attemptStarted: r.attempts.some((a) => a.startedAt !== null)
      };
    };
    const first = classifyRecipient(product, snap(0));
    expect(first.outcome).toBe("limited");
    expect(first.usable).toBe(true);
    expect(first.usableReason).toBe("verified");
    expect(first.restockExpectation).toContain("Thursday");
    const second = classifyRecipient(product, snap(1));
    expect(second.outcome).toBe("unreachable");
    expect(second.usableReason).toBe("not_dialled");
  });
});

describe("real CALL-E snapshot from docs/evidence", () => {
  it("parses the exported live call through the SDK client and reproduces the stored verdict", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { classifyRecipient } = await import("../src/domain/classify.js");
    const dirs = readdirSync("docs/evidence").filter((d) => d.includes("dsp_"));
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const raw = readFileSync(`docs/evidence/${dir}/call.json`, "utf8");
      const stored = JSON.parse(readFileSync(`docs/evidence/${dir}/observations.json`, "utf8")) as Array<{ recipientId: string; outcome: string; usable: boolean; usableReason: string }>;
      const snapshot = JSON.parse(raw) as { id: string; metadata: { product_label: string } };
      const live = new LiveCalleProvider({ apiKey: "iams_live_test", baseUrl: "https://api.heycall-e.com", fetch: async () => new Response(raw, { status: 200, headers: { "content-type": "application/json" } }) });
      const call = await live.get(snapshot.id);
      expect(call.status).toBe("completed");
      expect(call.metadata.app).toBe("shortline");
      const [name, ...rest] = snapshot.metadata.product_label.split(" ");
      const product = { name: name ?? "", strength: rest.join(" ") };
      for (const obs of stored) {
        const r = call.recipients.find((x) => x.id === obs.recipientId)!;
        const attempt = r.attempts[r.attempts.length - 1];
        const verdict = classifyRecipient(product, {
          recipientId: r.id,
          phone: r.phones[0] ?? "",
          status: r.status,
          structuredResult: r.structuredResult,
          transcript: (attempt?.transcriptTurns ?? []).map((t) => ({ speaker: t.speaker, text: t.text })),
          attemptFailureCode: attempt?.failureCode ?? null,
          attemptStarted: r.attempts.some((a) => a.startedAt !== null)
        });
        expect(verdict.outcome).toBe(obs.outcome);
        expect(verdict.usable).toBe(obs.usable);
        expect(verdict.usableReason).toBe(obs.usableReason);
        expect(r.phones[0]).toMatch(/^\+1\d{3}55501\d{2}$/);
      }
    }
  });
});
