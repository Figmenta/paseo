import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SessionsSurface } from "./client/sessions";
import { installMaestroBridge } from "./client/web";

export default function contribute(client: PluginClientContext) {
  // The bridge lives here, in the contribution function itself: it is the only
  // client code Paseo runs unconditionally at plugin load. A surface would only
  // mount once the user opened it, and Orchestra needs the handshake before that.
  const removeBridge = installMaestroBridge(client);
  const removeSurface = client.addSurface("sessions", SessionsSurface);
  const removeSidebarItem = client.addSidebarItem({
    id: "sessions",
    title: "Sessions",
    icon: "Layers",
    surface: "sessions",
  });
  const removeCommand = client.addCommandCenterItem({
    id: "open-sessions",
    title: "Open sessions",
    icon: "Layers",
    context: "global",
    keywords: ["sessions", "agents", "figmenta"],
    onSelect({ openSurface }) {
      openSurface("sessions");
    },
  });
  return () => {
    removeBridge();
    removeCommand();
    removeSidebarItem();
    removeSurface();
  };
}
