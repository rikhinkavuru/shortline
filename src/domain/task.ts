import type { Product } from "./types.js";

export function productLabel(product: Product): string {
  return [product.name, product.strength, product.form].filter((v): v is string => Boolean(v && v.trim())).join(" ");
}

export interface TaskOptions {
  product: Product;
  /** Name the assistant uses to describe itself. */
  callerName: string;
  askHold: boolean;
  /** Optional pickup context when asking for a hold, e.g. "within two hours". */
  holdWindow?: string;
}

/**
 * The task text is the whole "script". It is deliberately short: one
 * disclosure, one question, two follow-ups, and explicit refusals. CALL-E
 * handles the conversation; Shortline only decides what may be asked.
 */
export function buildTaskText(opts: TaskOptions): string {
  const label = productLabel(opts.product);
  const lines = [
    `You are calling a pharmacy. Identify yourself immediately as an automated assistant calling for ${opts.callerName}, a project that tracks medication availability, and say the call will take under a minute.`,
    `If you reach a phone menu, choose the option for the pharmacy or to speak with pharmacy staff. Use the keypad when the menu asks for it. If you reach voicemail, do not leave a message and end the call.`,
    `Once you are speaking with pharmacy staff, ask one question: whether they currently have ${label} in stock and able to dispense today.`,
    `If they say yes, ask whether supply is limited. If they say no or limited, ask when they expect the next delivery.`,
    opts.askHold
      ? `If they have it in stock, ask whether they could hold one fill for a pickup ${opts.holdWindow ?? "today"} and note their answer. Do not give a patient name; say the pharmacist will provide details at pickup.`
      : `Do not ask them to hold or reserve anything.`,
    `Do not place an order, do not discuss any patient, do not ask about prices, and do not ask for anything beyond these questions.`,
    `If they say they cannot share stock information over the phone, thank them and end the call. If they ask not to be called again, apologise, confirm you will note it, and end the call.`,
    `Be brief and polite. Thank them and end the call as soon as you have an answer.`
  ];
  return lines.join(" ");
}

/**
 * Per-recipient extraction contract. Enums everywhere a decision is made,
 * and `unknown` is always allowed so the extractor is never forced to guess.
 */
export function buildRecipientResultSchema(askHold: boolean): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    availability: {
      type: "string",
      enum: ["in_stock", "limited", "out_of_stock", "not_carried", "refused_to_say", "unknown"],
      description:
        "What pharmacy staff said about the product. in_stock: available now with no stated limit. limited: available but staff said supply is short, rationed, or only a few left. out_of_stock: they normally carry it but have none now. not_carried: they never stock this product. refused_to_say: staff declined to share stock information. unknown: no clear answer, wrong person, or the question was never answered."
    },
    restock_expectation: {
      type: "string",
      description: "When staff expect the next delivery or restock, in their words, or an empty string if none was given."
    },
    quantity_note: {
      type: "string",
      description: "Any quantity, rationing, or limit staff mentioned, in their words, or an empty string."
    },
    answered_by: {
      type: "string",
      enum: ["human", "ivr", "voicemail", "unknown"],
      description: "Who or what answered by the end of the call. Use human if a person spoke at any point, even after a phone menu."
    },
    reached_pharmacy: {
      type: "string",
      enum: ["yes", "no", "unknown"],
      description: "yes only if the person who answered the stock question works in the pharmacy department. no if the call reached a different business, a front-store clerk who could not check, or the wrong number."
    },
    do_not_call_request: {
      type: "string",
      enum: ["yes", "no"],
      description: "yes if anyone on the call asked not to be called again or objected to automated calls."
    },
    evidence_quote: {
      type: "string",
      description: "The shortest exact phrase the pharmacy said that supports the availability value, or an empty string if nothing supports it."
    }
  };
  const required = ["availability", "answered_by", "reached_pharmacy", "do_not_call_request", "evidence_quote", "restock_expectation", "quantity_note"];
  if (askHold) {
    properties.hold_response = {
      type: "string",
      enum: ["offered", "declined", "not_asked", "unknown"],
      description: "offered if staff agreed to hold a fill for pickup. declined if they would not. not_asked if the question was never reached. unknown otherwise."
    };
    required.push("hold_response");
  }
  return { type: "object", additionalProperties: false, required, properties };
}

/** Task-level result: a tiny cross-check the reconciler compares with recipient results. */
export function buildTaskResultSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["pharmacies_reached"],
    properties: {
      pharmacies_reached: {
        type: "integer",
        description: "How many recipients on this task reached pharmacy staff who answered the stock question."
      }
    }
  };
}
