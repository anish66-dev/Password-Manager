import { describe, it, expect } from "vitest";
import { handleExtensionMessage } from "./router.js";
import {
  type PopupStatusResponseData,
  type ContentScriptPingResponseData,
} from "@password-manager/shared";

describe("Background Message Router", () => {
  it("handles POPUP_GET_STATUS and returns locked status", async () => {
    const res = await handleExtensionMessage({ type: "POPUP_GET_STATUS" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as PopupStatusResponseData;
      expect(data.appName).toBe("Personal Password Manager");
      expect(data.status).toBe("locked");
      expect(data.version).toBe("0.1.0");
      expect(typeof data.timestamp).toBe("string");
    }
  });

  it("handles CONTENT_SCRIPT_PING and acknowledges sender url", async () => {
    const res = await handleExtensionMessage({
      type: "CONTENT_SCRIPT_PING",
      payload: { url: "https://example.com/login" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as ContentScriptPingResponseData;
      expect(data.acknowledged).toBe(true);
      expect(data.receivedFromUrl).toBe("https://example.com/login");
      expect(typeof data.timestamp).toBe("string");
    }
  });

  it("rejects invalid messages at the boundary", async () => {
    const res1 = await handleExtensionMessage(null);
    expect(res1.ok).toBe(false);

    const res2 = await handleExtensionMessage({ type: "NON_EXISTENT_TYPE" });
    expect(res2.ok).toBe(false);

    const res3 = await handleExtensionMessage({
      type: "CONTENT_SCRIPT_PING",
      payload: { wrongField: 123 },
    });
    expect(res3.ok).toBe(false);
  });
});
