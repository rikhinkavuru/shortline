import { describe, expect, it } from "vitest";
import { classifyRecipient, productWasAsked, quoteIsAttributed, type RecipientSnapshot } from "../src/domain/classify.js";
import { SCENARIOS } from "../src/calle/scenarios.js";

const product = { name: "amoxicillin", strength: "400 mg/5 mL", form: "oral suspension" };

function snapFrom(scenario: string, status = "completed"): RecipientSnapshot {
  const s = SCENARIOS[scenario]!;
  return {
    recipientId: "rcp_1",
    phone: "+14155550101",
    status: s.recipientStatus === "failed" ? "failed" : status,
    structuredResult: s.structuredResult,
    transcript: s.turns("amoxicillin 400 mg/5 mL oral suspension").map((t) => ({ speaker: t.speaker, text: t.text })),
    attemptFailureCode: s.failureCode ?? null
  };
}

describe("classifyRecipient", () => {
  it("accepts a clean human answer with an attributed quote", () => {
    const c = classifyRecipient(product, snapFrom("in_stock_human"));
    expect(c.outcome).toBe("in_stock");
    expect(c.usable).toBe(true);
    expect(c.usableReason).toBe("verified");
  });
  it("keeps limited and out-of-stock answers with their restock note", () => {
    const limited = classifyRecipient(product, snapFrom("limited_human"));
    expect(limited.outcome).toBe("limited");
    expect(limited.usable).toBe(true);
    expect(limited.restockExpectation).toContain("Thursday");
    const out = classifyRecipient(product, snapFrom("out_of_stock_human"));
    expect(out.outcome).toBe("out_of_stock");
    expect(out.usable).toBe(true);
  });
  it("counts a menu-navigated call once a person answered", () => {
    const c = classifyRecipient(product, snapFrom("ivr_then_in_stock"));
    expect(c.outcome).toBe("in_stock");
    expect(c.usable).toBe(true);
  });
  it("rejects a schema-valid result whose quote is not in the transcript", () => {
    const c = classifyRecipient(product, snapFrom("unattributed_quote"));
    expect(c.outcome).toBe("in_stock");
    expect(c.usable).toBe(false);
    expect(c.usableReason).toBe("evidence_unattributed");
  });
  it("rejects an answer when the product was never named", () => {
    const c = classifyRecipient(product, snapFrom("never_asked"));
    expect(c.usable).toBe(false);
    expect(c.usableReason).toBe("product_never_asked");
  });
  it("treats voicemail, menus, refusals, and wrong numbers as non-observations, not as answers", () => {
    expect(classifyRecipient(product, snapFrom("voicemail")).outcome).toBe("voicemail");
    expect(classifyRecipient(product, snapFrom("ivr_dead_end")).outcome).toBe("ivr_dead_end");
    expect(classifyRecipient(product, snapFrom("refused")).outcome).toBe("refused");
    expect(classifyRecipient(product, snapFrom("wrong_number")).outcome).toBe("not_reached");
    for (const name of ["voicemail", "ivr_dead_end", "refused", "wrong_number"]) {
      expect(classifyRecipient(product, snapFrom(name)).usable).toBe(false);
    }
  });
  it("records a do-not-call request even when nothing else is usable", () => {
    const c = classifyRecipient(product, snapFrom("do_not_call"));
    expect(c.doNotCallRequest).toBe(true);
    expect(c.usable).toBe(false);
  });
  it("maps a failed attempt to unreachable and a null result to unknown", () => {
    expect(classifyRecipient(product, snapFrom("no_answer")).outcome).toBe("unreachable");
    const nul = classifyRecipient(product, snapFrom("null_result"));
    expect(nul.outcome).toBe("unknown");
    expect(nul.usableReason).toBe("no_structured_result");
  });
  it("removes a site that does not carry the product from the frame", () => {
    const c = classifyRecipient(product, snapFrom("not_carried"));
    expect(c.outcome).toBe("not_carried");
    expect(c.usableReason).toBe("not_in_frame");
  });
  it("lenient policy keeps an unattributed quote usable but flags it", () => {
    const c = classifyRecipient(product, snapFrom("unattributed_quote"), "lenient");
    expect(c.usable).toBe(true);
    expect(c.flags).toContain("evidence_unattributed");
  });
});

describe("evidence helpers", () => {
  it("detects whether the bot named the product", () => {
    expect(productWasAsked(product, [{ speaker: "bot", text: "Do you have amoxicillin suspension?" }])).toBe(true);
    expect(productWasAsked(product, [{ speaker: "bot", text: "Do you have it?" }])).toBe(false);
    expect(productWasAsked(product, [{ speaker: "user", text: "amoxicillin" }])).toBe(false);
  });
  it("attributes a quote only to what the callee said", () => {
    const transcript = [
      { speaker: "bot", text: "we have plenty in stock" },
      { speaker: "user", text: "sorry, we are completely out today" }
    ];
    expect(quoteIsAttributed("completely out", transcript)).toBe(true);
    expect(quoteIsAttributed("plenty in stock", transcript)).toBe(false);
  });
});
