import { randomBytes } from "node:crypto";
import { hashString } from "./random.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function stratumKey(region: string, kind: string): string {
  return `${region}|${kind}`;
}

/**
 * Idempotency keys are derived from the *logical* action, never from an
 * attempt. A crash between "reserved" and "accepted" replays the same key and
 * CALL-E returns the original call task instead of dialling twice.
 */
export function sweepIdempotencyKey(watchId: string, isoWeek: string, siteIds: string[]): string {
  const sites = siteIds.slice().sort().join(",");
  return `sweep:${watchId}:${isoWeek}:${hashString(sites).toString(16)}:v1`;
}

export function findIdempotencyKey(findRequestId: string, waveIndex: number): string {
  return `find:${findRequestId}:wave${waveIndex}:v1`;
}

export const SCHEMA_VERSION = "shortline.recipient.v1";
