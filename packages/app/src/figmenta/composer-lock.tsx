/**
 * Figmenta embed: what a `maestro.composer.lock` does to an agent's composer
 * (docs/FIGMENTA.md, «Embed bridge v2», the hunk table names every call site).
 *
 * Not part of upstream Paseo. While Orchestra holds a lock on an agent, that agent's
 * composer sends nothing: `EmbedComposerLockGate` renders a read-only bar with the
 * label in place of the message input; `isEmbedComposerLocked` and
 * `assertEmbedComposerUnlocked` stop submit, queue and «send now» at call time;
 * `useEmbedComposerLockGuard` gives the render its flag (queue list, autocomplete and
 * file drop off) and ends voice mode on that agent. The queue the host runtime drains
 * at turn end is held back there, in `drainQueuedAgentMessage`.
 */
import { useEffect, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { readEmbedComposerLock, useEmbedComposerLock } from "@/figmenta/embed";
import { RenderProfile } from "@/utils/render-profiler";

/** The part of `useVoiceOptional()` the lock needs. */
export interface EmbedComposerLockVoice {
  isVoiceSwitching: boolean;
  isVoiceModeForAgent: (serverId: string, agentId: string) => boolean;
  stopVoice: () => Promise<void>;
}

/**
 * For the submit and queue handlers: true while Orchestra locks this agent. Reads the
 * lock at call time, so one that landed after the last render still stops the send.
 */
export function isEmbedComposerLocked(agentId: string): boolean {
  return readEmbedComposerLock(agentId) !== null;
}

/**
 * For the one path every send out of the composer takes («send now» on a queued row
 * included): throws with the bar's label, so the send fails and the text comes back.
 */
export function assertEmbedComposerUnlocked(agentId: string): void {
  const label = readEmbedComposerLock(agentId);
  if (label !== null) throw new Error(label);
}

/**
 * The render's side of the lock: returns true while Orchestra locks this agent, and
 * stops voice mode on it, which talks to the agent without going through the input.
 */
export function useEmbedComposerLockGuard(input: {
  agentId: string;
  serverId: string;
  voice: EmbedComposerLockVoice | null;
}): boolean {
  const { agentId, serverId, voice } = input;
  const isLocked = useEmbedComposerLock(agentId) !== null;
  useEffect(() => {
    if (!isLocked || !voice || voice.isVoiceSwitching) return;
    if (!voice.isVoiceModeForAgent(serverId, agentId)) return;
    void voice.stopVoice().catch((error) => {
      console.error("[Composer] Failed to stop voice mode on a locked composer", error);
    });
  }, [agentId, isLocked, serverId, voice]);
  return isLocked;
}

/** In place of the composer's `<RenderProfile>` around the message input. */
export function EmbedComposerLockGate({
  agentId,
  profileId,
  children,
}: {
  agentId: string;
  profileId: string;
  children: ReactNode;
}) {
  const label = useEmbedComposerLock(agentId);
  if (label === null) return <RenderProfile id={profileId}>{children}</RenderProfile>;
  return (
    <View style={styles.bar} testID="composer-embed-lock">
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    width: "100%",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
