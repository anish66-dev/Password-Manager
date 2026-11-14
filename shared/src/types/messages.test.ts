import { describe, it, expect } from "vitest";
import {
  isValidExtensionMessage,
  isValidExtensionResponse,
  type ExtensionMessage,
} from "./messages.js";

describe("Message bus boundary validation", () => {
  it("validates POPUP_GET_STATUS message correctly", () => {
    const valid: ExtensionMessage = { type: "POPUP_GET_STATUS" };
    expect(isValidExtensionMessage(valid)).toBe(true);
  });

  it("validates CONTENT_SCRIPT_PING message correctly", () => {
    const valid: ExtensionMessage = {
      type: "CONTENT_SCRIPT_PING",
      payload: { url: "https://example.com" },
    };
    expect(isValidExtensionMessage(valid)).toBe(true);
  });

  it("rejects non-object messages", () => {
    expect(isValidExtensionMessage(null)).toBe(false);
    expect(isValidExtensionMessage(undefined)).toBe(false);
    expect(isValidExtensionMessage("hello")).toBe(false);
    expect(isValidExtensionMessage(123)).toBe(false);
    expect(isValidExtensionMessage([])).toBe(false);
  });

  it("rejects unknown message types", () => {
    expect(isValidExtensionMessage({ type: "UNKNOWN_TYPE" })).toBe(false);
    expect(isValidExtensionMessage({})).toBe(false);
  });

  it("rejects malformed payloads", () => {
    expect(
      isValidExtensionMessage({
        type: "CONTENT_SCRIPT_PING",
        payload: null,
      })
    ).toBe(false);

    expect(
      isValidExtensionMessage({
        type: "CONTENT_SCRIPT_PING",
        payload: { url: 123 },
      })
    ).toBe(false);

    expect(
      isValidExtensionMessage({
        type: "CONTENT_SCRIPT_PING",
      })
    ).toBe(false);
  });

  it("validates response envelopes correctly", () => {
    expect(isValidExtensionResponse({ ok: true, data: { test: 1 } })).toBe(true);
    expect(isValidExtensionResponse({ ok: false, error: "Something went wrong" })).toBe(true);

    expect(isValidExtensionResponse(null)).toBe(false);
    expect(isValidExtensionResponse({ ok: "not-a-bool" })).toBe(false);
    expect(isValidExtensionResponse({ ok: false, error: 123 })).toBe(false);
  });
});
