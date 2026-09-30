/**
 * Figmenta embed: what the frame shows in place of the launcher, the `/new` screen, a missing
 * agent or a terminal tab while Orchestra keeps the launcher closed (see launcher-lock.ts).
 */
import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  draftGatedByLauncher,
  EMBED_SESSION_CLOSED_MESSAGE,
  useEmbedLauncherLocked,
} from "@/figmenta/launcher-lock";

export function EmbedSessionClosedNotice() {
  return (
    <View style={styles.container} testID="embed-session-closed">
      <Text style={styles.label}>{EMBED_SESSION_CLOSED_MESSAGE}</Text>
    </View>
  );
}

/**
 * For a `draft` tab: the notice when the embed gate is shut and the draft was restored from the
 * persisted layout; `children` otherwise (drafts created in this page, e.g. by /clear).
 */
export function EmbedDraftGate({
  draftId,
  children,
}: {
  draftId: string;
  children: ReactElement;
}): ReactElement {
  const locked = useEmbedLauncherLocked();
  return draftGatedByLauncher(draftId, locked) ? <EmbedSessionClosedNotice /> : children;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    maxWidth: 520,
  },
}));
