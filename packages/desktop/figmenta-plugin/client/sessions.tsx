import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  countSessions,
  formatRelative,
  type SessionListItem,
  type SessionRow,
  type SessionTone,
  toListItems,
} from "./model";
import { useSessions } from "./use-sessions";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];

function toneColor(tone: SessionTone, colors: ThemeColors): string {
  switch (tone) {
    case "running":
      return colors.statusSuccess;
    case "attention":
      return colors.statusWarning;
    case "danger":
      return colors.statusDanger;
    case "idle":
      return colors.accent;
    default:
      return colors.foregroundMuted;
  }
}

function useStyles(theme: PluginSurfaceProps["theme"], compact: boolean) {
  return useMemo(() => {
    const gutter = compact ? 12 : 20;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        paddingHorizontal: gutter,
        paddingTop: compact ? 12 : 18,
        paddingBottom: compact ? 10 : 14,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        gap: 2,
      },
      headerRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      headerTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 15 : 17,
        fontWeight: "600" as const,
        flex: 1,
      },
      headerDetail: { color: theme.colors.foregroundMuted, fontSize: compact ? 11 : 12 },
      refresh: { padding: 4 },
      listContent: { paddingBottom: compact ? 16 : 24 },
      groupHeader: {
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        gap: 8,
        paddingHorizontal: gutter,
        paddingTop: compact ? 14 : 18,
        paddingBottom: 6,
        backgroundColor: theme.colors.surface0,
      },
      groupTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 12 : 13,
        fontWeight: "600" as const,
      },
      groupSubtitle: { color: theme.colors.foregroundMuted, fontSize: compact ? 10 : 11, flex: 1 },
      groupCount: { color: theme.colors.foregroundMuted, fontSize: compact ? 10 : 11 },
      row: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 10,
        marginHorizontal: gutter,
        marginTop: 6,
        paddingVertical: compact ? 8 : 10,
        paddingHorizontal: compact ? 10 : 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      dot: { width: 9, height: 9, borderRadius: 5, marginTop: compact ? 5 : 6, borderWidth: 2 },
      rowBody: { flex: 1, gap: 3 },
      rowTitle: { color: theme.colors.foreground, fontSize: compact ? 13 : 14 },
      rowMeta: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      metaText: { color: theme.colors.foregroundMuted, fontSize: compact ? 10 : 11 },
      statusText: { fontSize: compact ? 10 : 11, fontWeight: "600" as const },
      empty: { padding: compact ? 20 : 32, gap: 8 },
      emptyTitle: { color: theme.colors.foreground, fontSize: compact ? 14 : 15 },
      emptyDetail: { color: theme.colors.foregroundMuted, fontSize: compact ? 11 : 12 },
      error: { color: theme.colors.statusDanger, fontSize: compact ? 11 : 12 },
    };
  }, [theme, compact]);
}

type Styles = ReturnType<typeof useStyles>;

function SessionRowView({
  row,
  styles,
  colors,
  now,
  onOpen,
}: {
  row: SessionRow;
  styles: Styles;
  colors: ThemeColors;
  now: number;
  onOpen: ((agentId: string) => void) | null;
}) {
  const handlePress = useCallback(() => onOpen?.(row.agentId), [onOpen, row.agentId]);
  const body = (
    <View style={styles.row}>
      <View
        style={[
          styles.dot,
          {
            borderColor: toneColor(row.tone, colors),
            backgroundColor: row.tone === "idle" ? "transparent" : toneColor(row.tone, colors),
          },
        ]}
      />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {row.title}
        </Text>
        <View style={styles.rowMeta}>
          <Text style={[styles.statusText, { color: toneColor(row.tone, colors) }]}>
            {row.statusLabel}
          </Text>
          <Text style={styles.metaText}>·</Text>
          <Text style={styles.metaText}>{row.workspaceLabel}</Text>
          <Text style={styles.metaText}>·</Text>
          <Text style={styles.metaText}>{row.providerLabel}</Text>
          <Text style={styles.metaText}>·</Text>
          <Text style={styles.metaText}>{formatRelative(row.lastActivityAt, now)}</Text>
        </View>
      </View>
    </View>
  );
  if (!onOpen) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open session ${row.title} in ${row.workspaceLabel}`}
      onPress={handlePress}
    >
      {body}
    </Pressable>
  );
}

export function SessionsSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const compact = layout.compact;
  const styles = useStyles(theme, compact);
  const { groups, loading, error, now, reload } = useSessions();
  const items = useMemo(() => toListItems(groups), [groups]);
  const totals = useMemo(() => countSessions(groups), [groups]);
  const openAgent = navigation?.openAgent;
  const onOpen = useMemo(
    () => (openAgent ? (agentId: string) => openAgent({ agentId }) : null),
    [openAgent],
  );

  const renderItem = useCallback(
    ({ item }: { item: SessionListItem }) => {
      if (item.kind === "group") {
        return (
          <View style={styles.groupHeader}>
            <Text style={styles.groupTitle}>{item.group.title}</Text>
            <Text style={styles.groupSubtitle} numberOfLines={1}>
              {item.group.subtitle ?? ""}
            </Text>
            <Text style={styles.groupCount}>{item.group.rows.length}</Text>
          </View>
        );
      }
      return (
        <SessionRowView
          row={item.row}
          styles={styles}
          colors={theme.colors}
          now={now}
          onOpen={onOpen}
        />
      );
    },
    [styles, theme.colors, now, onOpen],
  );

  const keyExtractor = useCallback((item: SessionListItem) => item.key, []);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>Sessions</Text>
          {loading ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh the session list"
            onPress={reload}
            style={styles.refresh}
          >
            <Icon name="RefreshCw" size={15} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        <Text style={styles.headerDetail}>
          {`${totals.sessions} ${totals.sessions === 1 ? "session" : "sessions"} in ${
            groups.length
          } ${groups.length === 1 ? "workspace" : "workspaces"} on ${host.label}`}
        </Text>
        <Text style={styles.headerDetail}>
          {`${totals.live} running · ${totals.needAttention} waiting on you · archived not listed`}
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!navigation ? (
          <Text style={styles.headerDetail}>
            This Paseo client cannot open a session from a plugin surface.
          </Text>
        ) : null}
      </View>
      {items.length === 0 && !loading ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No sessions</Text>
          <Text style={styles.emptyDetail}>
            Archived sessions are not listed. Start an agent in any workspace and it appears here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
        />
      )}
    </View>
  );
}
