/**
 * The only file in this plugin allowed to touch browser globals.
 *
 * When Paseo's web build runs inside the Orchestra iframe, this bridge announces
 * the plugin to the parent window and accepts one message from it: the Orchestra
 * base URL plus a connect token, which it hands to the daemon over RPC.
 */
import { Platform } from "react-native";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { setConnectionRpc, statusRpc } from "../shared/maestro";
import { connectedMessage, parseBridgeMessage, readyMessage } from "../shared/bridge";

// This project typechecks without the DOM library. Declare only what is used here.
interface BridgeMessageEvent {
  readonly origin: string;
  readonly data: unknown;
}
declare const window: {
  readonly location: { readonly origin: string };
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: "message", listener: (event: BridgeMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: BridgeMessageEvent) => void): void;
};

export type BridgeHost = Pick<PluginClientContext, "rpc">;

/**
 * Returns the remover. On iOS and Android it is a no-op: there is no parent
 * window to talk to.
 */
export function installMaestroBridge(client: BridgeHost): () => void {
  if (Platform.OS !== "web") return () => undefined;

  const post = (message: unknown): void => {
    // "*" is deliberate: the iframe cannot know the parent origin up front. The
    // payload carries no secret — only a version, a flag and a handle.
    window.parent.postMessage(message, "*");
  };

  const listener = (event: BridgeMessageEvent): void => {
    // Same-origin only: Orchestra serves this iframe from its own origin.
    if (event.origin !== window.location.origin) return;
    const message = parseBridgeMessage(event.data);
    if (message === null) return;
    void client
      .rpc(setConnectionRpc, { baseUrl: message.baseUrl, token: message.token })
      .then((result) => {
        if (result.ok && result.user !== null) post(connectedMessage(result.user.handle));
      })
      .catch(() => undefined);
  };

  window.addEventListener("message", listener);

  void client
    .rpc(statusRpc, {})
    .then((status) => post(readyMessage(status.connected)))
    .catch(() => post(readyMessage(false)));

  return () => {
    window.removeEventListener("message", listener);
  };
}
