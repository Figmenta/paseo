import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { NewWorkspaceScreen } from "@/screens/new-workspace-screen";
import { useEmbedLauncherLocked } from "@/figmenta/launcher-lock"; // Figmenta: launcher gate
import { EmbedSessionClosedNotice } from "@/figmenta/launcher-closed-notice"; // Figmenta: launcher gate

export default function NewWorkspaceRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    dir?: string;
    name?: string;
    projectId?: string;
    draftId?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const sourceDirectory = typeof params.dir === "string" ? params.dir : undefined;
  const displayName = typeof params.name === "string" ? params.name : undefined;
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
  const draftId = typeof params.draftId === "string" ? params.draftId : undefined;
  const screenKey = JSON.stringify([
    serverId,
    sourceDirectory ?? null,
    displayName ?? null,
    projectId ?? null,
    draftId ?? null,
  ]);
  const embedLauncherLocked = useEmbedLauncherLocked(); // Figmenta: launcher gate
  if (embedLauncherLocked) return <EmbedSessionClosedNotice />; // Figmenta: launcher gate

  return (
    <HostRouteBootstrapBoundary>
      <NewWorkspaceScreen
        key={screenKey}
        serverId={serverId}
        sourceDirectory={sourceDirectory}
        displayName={displayName}
        projectId={projectId}
        draftId={draftId}
      />
    </HostRouteBootstrapBoundary>
  );
}
