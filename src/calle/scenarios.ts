import type { ProviderTranscriptTurn } from "./provider.js";

/**
 * Scripted callee behaviours for dry-run mode. Each scenario is a realistic
 * transcript plus the structured result CALL-E would be expected to extract.
 * Several scenarios are deliberately *bad* (a quote that is not in the
 * transcript, a product never named, a null result) so the evidence gates
 * are exercised on every demo run, not only in tests.
 */

export interface Scenario {
  name: string;
  recipientStatus: "completed" | "failed";
  failureCode?: string;
  structuredResult: Record<string, unknown> | null;
  turns: (product: string) => ProviderTranscriptTurn[];
  summary: string;
}

const disclosure = (t: number): ProviderTranscriptTurn => ({
  offsetSeconds: t,
  speaker: "bot",
  text: "Hi, this is an automated assistant calling for Shortline, a project that tracks medication availability. This will take under a minute."
});

const ask = (t: number, product: string): ProviderTranscriptTurn => ({
  offsetSeconds: t,
  speaker: "bot",
  text: `Do you currently have ${product} in stock and able to dispense today?`
});

const thanks = (t: number): ProviderTranscriptTurn => ({ offsetSeconds: t, speaker: "bot", text: "Thank you, that's all I needed. Have a good day." });

const base = (availability: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  availability,
  restock_expectation: "",
  quantity_note: "",
  answered_by: "human",
  reached_pharmacy: "yes",
  do_not_call_request: "no",
  evidence_quote: "",
  ...extra
});

export const SCENARIOS: Record<string, Scenario> = {
  in_stock_human: {
    name: "in_stock_human",
    recipientStatus: "completed",
    summary: "Pharmacy staff confirmed the product is in stock.",
    structuredResult: base("in_stock", { evidence_quote: "yes, we have that in stock" }),
    turns: (p) => [
      { offsetSeconds: 0, speaker: "user", text: "Pharmacy, this is Dana." },
      disclosure(2),
      ask(9, p),
      { offsetSeconds: 15, speaker: "user", text: "Let me check... yes, we have that in stock." },
      { offsetSeconds: 19, speaker: "bot", text: "Great. Is the supply limited at all?" },
      { offsetSeconds: 22, speaker: "user", text: "No, we're fine on it." },
      thanks(24)
    ]
  },
  limited_human: {
    name: "limited_human",
    recipientStatus: "completed",
    summary: "In stock but supply is limited; next delivery expected Thursday.",
    structuredResult: base("limited", {
      evidence_quote: "we only have a couple of bottles left",
      quantity_note: "a couple of bottles left",
      restock_expectation: "Thursday's delivery"
    }),
    turns: (p) => [
      { offsetSeconds: 0, speaker: "user", text: "Pharmacy." },
      disclosure(1),
      ask(8, p),
      { offsetSeconds: 14, speaker: "user", text: "We do, but we only have a couple of bottles left." },
      { offsetSeconds: 18, speaker: "bot", text: "Understood. When do you expect the next delivery?" },
      { offsetSeconds: 21, speaker: "user", text: "Should be on Thursday's delivery." },
      thanks(24)
    ]
  },
  out_of_stock_human: {
    name: "out_of_stock_human",
    recipientStatus: "completed",
    summary: "Out of stock; staff do not know when it will return.",
    structuredResult: base("out_of_stock", { evidence_quote: "we're completely out", restock_expectation: "no idea, it's on backorder" }),
    turns: (p) => [
      { offsetSeconds: 0, speaker: "user", text: "Thanks for calling the pharmacy, how can I help?" },
      disclosure(2),
      ask(9, p),
      { offsetSeconds: 15, speaker: "user", text: "No, sorry, we're completely out. Everyone's asking." },
      { offsetSeconds: 19, speaker: "bot", text: "When do you expect the next delivery?" },
      { offsetSeconds: 22, speaker: "user", text: "Honestly no idea, it's on backorder with our wholesaler." },
      thanks(26)
    ]
  },
  not_carried: {
    name: "not_carried",
    recipientStatus: "completed",
    summary: "The pharmacy does not stock this product.",
    structuredResult: base("not_carried", { evidence_quote: "we don't carry that, it's a hospital product" }),
    turns: (p) => [
      { offsetSeconds: 0, speaker: "user", text: "Pharmacy." },
      disclosure(1),
      ask(8, p),
      { offsetSeconds: 13, speaker: "user", text: "We don't carry that, it's a hospital product." },
      thanks(16)
    ]
  },
  refused: {
    name: "refused",
    recipientStatus: "completed",
    summary: "Staff declined to share stock information by phone.",
    structuredResult: base("refused_to_say", { evidence_quote: "we can't give out stock information over the phone" }),
    turns: (p) => [
      { offsetSeconds: 0, speaker: "user", text: "Pharmacy, how can I help you?" },
      disclosure(2),
      ask(9, p),
      { offsetSeconds: 14, speaker: "user", text: "Sorry, we can't give out stock information over the phone." },
      { offsetSeconds: 17, speaker: "bot", text: "Understood, thank you for your time." }
    ]
  },
  do_not_call: {
    name: "do_not_call",
    recipientStatus: "completed",
    summary: "Staff asked not to be called again.",
    structuredResult: base("unknown", { do_not_call_request: "yes", evidence_quote: "please take us off your list" }),
    turns: () => [
      { offsetSeconds: 0, speaker: "user", text: "Pharmacy." },
      disclosure(1),
      { offsetSeconds: 8, speaker: "user", text: "We don't take automated calls, please take us off your list." },
      { offsetSeconds: 11, speaker: "bot", text: "I apologise. I will note that you should not be called again. Goodbye." }
    ]
  },
  voicemail: {
    name: "voicemail",
    recipientStatus: "completed",
    summary: "Reached voicemail; no message left.",
    structuredResult: base("unknown", { answered_by: "voicemail", reached_pharmacy: "no" }),
    turns: () => [{ offsetSeconds: 0, speaker: "user", text: "You've reached the pharmacy. We're currently closed. Please leave a message after the tone." }]
  },
  ivr_then_in_stock: {
    name: "ivr_then_in_stock",
    recipientStatus: "completed",
    summary: "Navigated the store menu to the pharmacy; product confirmed in stock.",
    structuredResult: base("in_stock", { evidence_quote: "yep, we've got it on the shelf" }),
    turns: (p) => [
      { offsetSeconds: 0, speaker: "user", text: "Thank you for calling. For store hours press 1. For the pharmacy press 2." },
      { offsetSeconds: 6, speaker: "bot", text: "[keypad 2]" },
      { offsetSeconds: 8, speaker: "user", text: "To refill a prescription press 1. To speak with pharmacy staff press 0." },
      { offsetSeconds: 12, speaker: "bot", text: "[keypad 0]" },
      { offsetSeconds: 31, speaker: "user", text: "Pharmacy, this is Sam." },
      disclosure(33),
      ask(40, p),
      { offsetSeconds: 47, speaker: "user", text: "Yep, we've got it on the shelf." },
      thanks(50)
    ]
  },
  ivr_dead_end: {
    name: "ivr_dead_end",
    recipientStatus: "completed",
    summary: "The phone menu never reached a person.",
    structuredResult: base("unknown", { answered_by: "ivr", reached_pharmacy: "no" }),
    turns: () => [
      { offsetSeconds: 0, speaker: "user", text: "For store hours press 1. For the pharmacy press 2." },
      { offsetSeconds: 5, speaker: "bot", text: "[keypad 2]" },
      { offsetSeconds: 7, speaker: "user", text: "Our pharmacy is currently closed. Goodbye." }
    ]
  },
  wrong_number: {
    name: "wrong_number",
    recipientStatus: "completed",
    summary: "The number did not reach a pharmacy.",
    structuredResult: base("unknown", { reached_pharmacy: "no", evidence_quote: "this is a dental office" }),
    turns: () => [
      { offsetSeconds: 0, speaker: "user", text: "Good morning, Sunset Dental." },
      disclosure(2),
      { offsetSeconds: 9, speaker: "user", text: "I think you have the wrong number, this is a dental office." },
      { offsetSeconds: 12, speaker: "bot", text: "My apologies. Goodbye." }
    ]
  },
  no_answer: {
    name: "no_answer",
    recipientStatus: "failed",
    failureCode: "no_answer",
    summary: "The call was not answered.",
    structuredResult: null,
    turns: () => []
  },
  unattributed_quote: {
    name: "unattributed_quote",
    recipientStatus: "completed",
    summary: "Structured result claims in stock but the transcript does not support it.",
    structuredResult: base("in_stock", { evidence_quote: "plenty on hand, no problem at all" }),
    turns: (p) => [
      { offsetSeconds: 0, speaker: "user", text: "Pharmacy." },
      disclosure(1),
      ask(8, p),
      { offsetSeconds: 13, speaker: "user", text: "Hold on. Um. Can you call back later? We're slammed." },
      { offsetSeconds: 17, speaker: "bot", text: "Of course, thank you." }
    ]
  },
  never_asked: {
    name: "never_asked",
    recipientStatus: "completed",
    summary: "The assistant never named the product.",
    structuredResult: base("in_stock", { evidence_quote: "yes we have it" }),
    turns: () => [
      { offsetSeconds: 0, speaker: "user", text: "Pharmacy." },
      disclosure(1),
      { offsetSeconds: 8, speaker: "bot", text: "Do you have it in stock today?" },
      { offsetSeconds: 11, speaker: "user", text: "Have what? ... sure, yes we have it." },
      thanks(14)
    ]
  },
  null_result: {
    name: "null_result",
    recipientStatus: "completed",
    summary: "The call completed but no schema-valid result could be extracted.",
    structuredResult: null,
    turns: (p) => [
      { offsetSeconds: 0, speaker: "user", text: "Pharmacy." },
      disclosure(1),
      ask(8, p),
      { offsetSeconds: 12, speaker: "user", text: "[inaudible]" }
    ]
  },
  hold_offered: {
    name: "hold_offered",
    recipientStatus: "completed",
    summary: "In stock; staff agreed to hold one fill for pickup today.",
    structuredResult: base("in_stock", { evidence_quote: "we have it, I can set one aside", hold_response: "offered" }),
    turns: (p) => [
      { offsetSeconds: 0, speaker: "user", text: "Pharmacy, this is Priya." },
      disclosure(2),
      ask(9, p),
      { offsetSeconds: 15, speaker: "user", text: "We have it. I can set one aside if someone's coming today." },
      { offsetSeconds: 19, speaker: "bot", text: "Yes please, the pharmacist will provide details at pickup. Thank you." }
    ]
  }
};

/** Realistic mix used when a site has no explicit scenario. */
export const DEFAULT_MIX: Array<[string, number]> = [
  ["in_stock_human", 30],
  ["ivr_then_in_stock", 10],
  ["limited_human", 12],
  ["out_of_stock_human", 22],
  ["refused", 6],
  ["voicemail", 8],
  ["no_answer", 6],
  ["ivr_dead_end", 3],
  ["null_result", 2],
  ["unattributed_quote", 1]
];

export function pickScenario(roll: number, mix: Array<[string, number]> = DEFAULT_MIX): string {
  const total = mix.reduce((acc, [, w]) => acc + w, 0);
  let cursor = roll * total;
  for (const [name, weight] of mix) {
    cursor -= weight;
    if (cursor <= 0) {
      return name;
    }
  }
  return "in_stock_human";
}

/**
 * A mix whose out-of-stock share rises with `pressure` in [0, 1], used to
 * simulate a shortage building over several weeks in the demo.
 */
export function mixUnderPressure(pressure: number): Array<[string, number]> {
  const p = Math.max(0, Math.min(1, pressure));
  return [
    ["in_stock_human", Math.round(34 * (1 - p) + 4)],
    ["ivr_then_in_stock", Math.round(10 * (1 - p) + 2)],
    ["limited_human", Math.round(8 + 14 * p)],
    ["out_of_stock_human", Math.round(8 + 44 * p)],
    ["refused", 5],
    ["voicemail", 7],
    ["no_answer", 5],
    ["ivr_dead_end", 3],
    ["null_result", 2],
    ["unattributed_quote", 1]
  ];
}
