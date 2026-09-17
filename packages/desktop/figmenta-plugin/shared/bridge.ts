/**
 * The postMessage protocol between the Orchestra web app and this plugin running
 * inside the embedded Paseo iframe. Pure parsing: no window, no RPC.
 */
import { PLUGIN_VERSION } from "./version";

export interface MaestroConnectMessage {
  readonly type: "maestro.connect";
  readonly baseUrl: string;
  readonly token: string;
}

export type InboundBridgeMessage = MaestroConnectMessage;

export interface PluginReadyMessage {
  readonly type: "maestro.plugin.ready";
  readonly version: string;
  readonly connected: boolean;
}

export interface PluginConnectedMessage {
  readonly type: "maestro.plugin.connected";
  readonly user: { readonly handle: string };
}

/**
 * Returns the message only when it is one we own and every field is a usable
 * string. Anything else — a foreign frame, a devtools ping, a half-built
 * payload — returns null and the caller ignores it.
 */
export function parseBridgeMessage(data: unknown): InboundBridgeMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record["type"] !== "maestro.connect") return null;
  const baseUrl = record["baseUrl"];
  const token = record["token"];
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) return null;
  if (typeof token !== "string" || token.trim().length === 0) return null;
  return { type: "maestro.connect", baseUrl: baseUrl.trim(), token: token.trim() };
}

export function readyMessage(connected: boolean): PluginReadyMessage {
  return { type: "maestro.plugin.ready", version: PLUGIN_VERSION, connected };
}

export function connectedMessage(handle: string): PluginConnectedMessage {
  return { type: "maestro.plugin.connected", user: { handle } };
}
