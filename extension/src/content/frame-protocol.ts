import {
  type CaptureDecision,
  type CapturePrompt,
  type FocusState,
  type Suggestion,
  isCapturePrompt,
} from "@password-manager/shared";

/**
 * Messages between the content script and the extension-owned suggestion iframe. They travel
 * only over a MessageChannel port that the content script creates and transfers to the
 * iframe, so page scripts can neither read them nor inject their own.
 */

/** Sent once with window.postMessage (port attached). The nonce proves who created the port. */
export interface FrameInit {
  type: "pm-init";
  nonce: string;
}

export type ToFrame =
  | { type: "render"; state: FocusState; suggestions: Suggestion[] }
  | { type: "prompt"; prompt: CapturePrompt };

export type FromFrame =
  | { type: "ready" }
  | { type: "select"; id: string }
  | { type: "size"; height: number }
  | { type: "dismiss" }
  | { type: "decision"; decision: CaptureDecision };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFrameInit(value: unknown): value is FrameInit {
  return isObject(value) && value["type"] === "pm-init" && typeof value["nonce"] === "string";
}

export function isToFrame(value: unknown): value is ToFrame {
  if (isObject(value) && value["type"] === "prompt") return isCapturePrompt(value["prompt"]);
  if (!isObject(value) || value["type"] !== "render") return false;
  const state = value["state"];
  const suggestions = value["suggestions"];
  return (
    (state === "ineligible" ||
      state === "uninitialized" ||
      state === "locked" ||
      state === "ready") &&
    Array.isArray(suggestions) &&
    suggestions.every(
      (s) =>
        isObject(s) &&
        typeof s["id"] === "string" &&
        typeof s["username"] === "string" &&
        typeof s["displayDomain"] === "string"
    )
  );
}

export function isFromFrame(value: unknown): value is FromFrame {
  if (!isObject(value)) return false;
  switch (value["type"]) {
    case "ready":
    case "dismiss":
      return true;
    case "select":
      return typeof value["id"] === "string";
    case "decision":
      return (
        value["decision"] === "accept" ||
        value["decision"] === "never" ||
        value["decision"] === "dismiss"
      );
    case "size":
      return (
        typeof value["height"] === "number" &&
        Number.isFinite(value["height"]) &&
        value["height"] >= 0 &&
        value["height"] <= 400
      );
    default:
      return false;
  }
}
