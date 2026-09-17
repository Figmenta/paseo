import { describe, expect, it } from "vitest";
import { connectedMessage, parseBridgeMessage, readyMessage } from "./bridge";
import { PLUGIN_VERSION } from "./version";

describe("parseBridgeMessage", () => {
  it("accepts a well-formed connect message and trims it", () => {
    expect(
      parseBridgeMessage({
        type: "maestro.connect",
        baseUrl: " https://orchestra.figmenta.site ",
        token: " orcc_abc ",
      }),
    ).toEqual({
      type: "maestro.connect",
      baseUrl: "https://orchestra.figmenta.site",
      token: "orcc_abc",
    });
  });

  it.each([
    null,
    "maestro.connect",
    { type: "other", baseUrl: "https://x", token: "t" },
    { type: "maestro.connect", baseUrl: "https://x" },
    { type: "maestro.connect", baseUrl: "", token: "t" },
    { type: "maestro.connect", baseUrl: "https://x", token: 42 },
  ])("rejects %j", (data) => {
    expect(parseBridgeMessage(data)).toBeNull();
  });
});

describe("outbound messages", () => {
  it("announces the plugin version", () => {
    expect(readyMessage(true)).toEqual({
      type: "maestro.plugin.ready",
      version: PLUGIN_VERSION,
      connected: true,
    });
  });
  it("carries only the handle", () => {
    expect(connectedMessage("fhg")).toEqual({
      type: "maestro.plugin.connected",
      user: { handle: "fhg" },
    });
  });
});
