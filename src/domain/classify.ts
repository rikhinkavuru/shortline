import { productLabel } from "./task.js";
import type { AnsweredBy, ObservationOutcome, Product } from "./types.js";

/** Normalised view of one CALL-E recipient result, independent of transport. */
export interface RecipientSnapshot {
  recipientId: string;
  phone: string;
  status: string;
  structuredResult: Record<string, unknown> | null;
  transcript: Array<{ speaker: string; text: string }>;
  attemptFailureCode: string | null;
  /** Whether any dial attempt actually started (distinguishes skipped/pending from failed). */
  attemptStarted?: boolean;
}

export interface Classification {
  outcome: ObservationOutcome;
  answeredBy: AnsweredBy;
  reachedPharmacy: "yes" | "no" | "unknown";
  restockExpectation: string;
  quantityNote: string;
  evidenceQuote: string;
  doNotCallRequest: boolean;
  holdResponse: "offered" | "declined" | "not_asked" | "unknown";
  usable: boolean;
  usableReason: string;
  flags: string[];
}

export type EvidencePolicy = "strict" | "lenient";

const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "for", "with", "on", "at", "is", "it", "we", "do", "have", "any", "that", "this", "our", "your"]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%./-]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** True if the product was actually named by the bot at some point. */
export function productWasAsked(product: Product, transcript: RecipientSnapshot["transcript"]): boolean {
  const botText = transcript
    .filter((t) => t.speaker === "bot")
    .map((t) => t.text.toLowerCase())
    .join(" ");
  if (!botText) {
    return false;
  }
  const nameTokens = tokens(product.name);
  if (nameTokens.length === 0) {
    return false;
  }
  return nameTokens.some((t) => botText.includes(t));
}

/** Lowercase, drop apostrophes (straight and curly), everything else non-alphanumeric becomes a space. */
export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2019'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * True if the quote appears as a contiguous phrase in ONE callee turn.
 *
 * A bag-of-words overlap is not enough: after stop words, "we have that in
 * stock" reduces to "stock", which also matches "we are completely out of
 * stock". The rule is therefore: normalised quote of at least two words found
 * whole in a single non-bot turn; failing that, the quote's content tokens
 * appear in order and adjacent in that turn's content-token stream (this
 * absorbs small ASR drift such as a dropped article).
 */
export function quoteIsAttributed(quote: string, transcript: RecipientSnapshot["transcript"]): boolean {
  const nq = normalizePhrase(quote);
  if (nq.split(" ").filter(Boolean).length < 2) {
    return false;
  }
  const contentQuote = tokens(quote);
  for (const turn of transcript) {
    if (turn.speaker === "bot") {
      continue;
    }
    const nt = normalizePhrase(turn.text);
    if (!nt) {
      continue;
    }
    if (` ${nt} `.includes(` ${nq} `)) {
      return true;
    }
    if (contentQuote.length >= 2) {
      const stream = tokens(turn.text);
      for (let i = 0; i + contentQuote.length <= stream.length; i += 1) {
        let ok = true;
        for (let j = 0; j < contentQuote.length; j += 1) {
          if (stream[i + j] !== contentQuote[j]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          return true;
        }
      }
    }
  }
  return false;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function enumOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Turn one recipient result into an observation verdict.
 *
 * The estimator only sees observations where `usable` is true, and the
 * reason string explains every exclusion. Nothing is inferred from a status
 * code alone: a failed attempt is "unreachable", not "no answer" or "no".
 */
export function classifyRecipient(product: Product, snap: RecipientSnapshot, policy: EvidencePolicy = "strict"): Classification {
  const flags: string[] = [];
  const base: Classification = {
    outcome: "unknown",
    answeredBy: "unknown",
    reachedPharmacy: "unknown",
    restockExpectation: "",
    quantityNote: "",
    evidenceQuote: "",
    doNotCallRequest: false,
    holdResponse: "not_asked",
    usable: false,
    usableReason: "",
    flags
  };
  const sr = snap.structuredResult;
  if (snap.status !== "completed") {
    // RecipientStatus is pending | in_progress | completed | failed | skipped. Anything
    // that did not complete is not an observation; say whether a dial ever started.
    const started = snap.attemptStarted ?? snap.status === "failed";
    return { ...base, outcome: "unreachable", usableReason: started ? `recipient_${snap.status}` : "not_dialled" };
  }
  if (!sr) {
    return { ...base, outcome: "unknown", usableReason: "no_structured_result" };
  }
  const availability = enumOr(sr.availability, ["in_stock", "limited", "out_of_stock", "not_carried", "refused_to_say", "unknown"] as const, "unknown");
  const answeredBy = enumOr(sr.answered_by, ["human", "ivr", "voicemail", "unknown"] as const, "unknown");
  const reached = enumOr(sr.reached_pharmacy, ["yes", "no", "unknown"] as const, "unknown");
  const doNotCall = sr.do_not_call_request === "yes";
  const holdResponse = enumOr(sr.hold_response, ["offered", "declined", "not_asked", "unknown"] as const, "not_asked");
  const quote = str(sr.evidence_quote);
  const filled: Classification = {
    ...base,
    answeredBy,
    reachedPharmacy: reached,
    restockExpectation: str(sr.restock_expectation),
    quantityNote: str(sr.quantity_note),
    evidenceQuote: quote,
    doNotCallRequest: doNotCall,
    holdResponse
  };
  if (answeredBy === "voicemail") {
    return { ...filled, outcome: "voicemail", usableReason: "voicemail" };
  }
  if (answeredBy === "ivr") {
    return { ...filled, outcome: "ivr_dead_end", usableReason: "ivr_only" };
  }
  if (reached === "no") {
    return { ...filled, outcome: "not_reached", usableReason: "pharmacy_not_reached" };
  }
  if (availability === "refused_to_say") {
    return { ...filled, outcome: "refused", usableReason: "refused" };
  }
  if (availability === "unknown") {
    return { ...filled, outcome: "unknown", usableReason: "no_clear_answer" };
  }
  if (answeredBy !== "human" || reached !== "yes") {
    return { ...filled, outcome: availability, usableReason: "pharmacy_staff_not_confirmed" };
  }
  if (availability === "not_carried") {
    return { ...filled, outcome: "not_carried", usableReason: "not_in_frame" };
  }
  // A substantive answer from pharmacy staff. Now check the evidence.
  const hasTranscript = snap.transcript.length > 0;
  if (hasTranscript && !productWasAsked(product, snap.transcript)) {
    flags.push("product_not_mentioned");
    return { ...filled, outcome: availability, usableReason: "product_never_asked" };
  }
  if (!quote) {
    flags.push("no_evidence_quote");
    return { ...filled, outcome: availability, usableReason: "no_evidence" };
  }
  if (hasTranscript && !quoteIsAttributed(quote, snap.transcript)) {
    flags.push("evidence_unattributed");
    if (policy === "strict") {
      return { ...filled, outcome: availability, usableReason: "evidence_unattributed" };
    }
  }
  if (!hasTranscript) {
    flags.push("no_transcript");
  }
  return { ...filled, outcome: availability, usable: true, usableReason: hasTranscript ? "verified" : "quoted_without_transcript" };
}

export function describeProduct(product: Product): string {
  return productLabel(product);
}
