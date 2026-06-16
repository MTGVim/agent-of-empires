import type { ProjectInfo, RepoGroup } from "./types";
import type { RepoColor } from "./repoAppearance";
import { workspaceIsSunk } from "./sidebarSort";
import { MULTI_REPO_GROUP_ID, SCRATCH_GROUP_ID } from "../hooks/useRepoGroups";

// Best-effort path key for matching a session-derived repo group against a
// registered project. The backend canonicalizes paths when a project is
// added, but the web only has the raw `Workspace.projectPath` and
// `ProjectInfo.path` strings, so this just trims and strips trailing
// slashes (NO lowercasing: that would wrongly fold distinct repos on a
// case-sensitive filesystem). A symlink / case mismatch the backend would
// resolve can still slip a duplicate header through; the real fix is a
// server endpoint returning the canonical key (tracked as follow-up), but
// session and registry paths share the same backend derivation so an exact
// match is the common case. See #2047.
export function normalizeProjectPathKey(path: string): string {
  return path.trim().replace(/[\\/]+$/g, "");
}

function isSyntheticRepoGroup(id: string): boolean {
  return id === MULTI_REPO_GROUP_ID || id === SCRATCH_GROUP_ID;
}

/** Live session-derived repo groups (with registry metadata attached) plus
 *  the registered projects that have no live group, surfaced separately so
 *  the sidebar can render them in a dedicated "Projects" section instead of
 *  interleaving them with active groups. See #2212. */
export interface MergedRegisteredProjects {
  groups: RepoGroup[];
  emptyProjects: RepoGroup[];
}

// Attach registry metadata to the session-derived repo groups and collect a
// zero-workspace group for every registered project that has no live group
// (a no-session project). Pure so it can be unit-tested directly and memoized
// in `useRepoGroups`.
//
// A registered path that matches a populated group attaches to it (so the
// group renders a pin marker) instead of producing a separate empty entry.
// Registrations are grouped by normalized path, so the same repo registered
// under both global and profile scope collapses into one empty project
// carrying both (remove drops every registration for the path). Synthetic
// Multi-repo / Scratch buckets never pin: their `repoPath` is a sentinel, not
// a repo.
export function mergeRegisteredProjects(
  repoGroups: RepoGroup[],
  projects: ProjectInfo[],
  // Per-browser appearance for the no-session projects, so a repo that was
  // aliased / colored while it had sessions keeps that look once it empties
  // out and only the registration keeps it visible. Omitted in unit tests,
  // where the structural shape is what matters. See #2047, #2212.
  resolve?: {
    alias: (repoPath: string) => string | null;
    color: (repoPath: string) => RepoColor | null;
  },
): MergedRegisteredProjects {
  const byKey = new Map<string, ProjectInfo[]>();
  for (const project of projects) {
    const key = normalizeProjectPathKey(project.path);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(project);
    else byKey.set(key, [project]);
  }

  const seen = new Set<string>();
  const groups = repoGroups.map((group) => {
    if (isSyntheticRepoGroup(group.id)) {
      return { ...group, registeredProjects: [] };
    }
    const key = normalizeProjectPathKey(group.repoPath);
    // Only treat the registration as covered by a live group when that group
    // has a non-sunk workspace. A repo whose only sessions are archived /
    // snoozed renders neither here (sidebarGroupShouldRender hides it) nor in
    // its sessions, so let it fall through to the Projects section instead of
    // vanishing entirely. See #2212.
    if (group.workspaces.some((workspace) => !workspaceIsSunk(workspace))) {
      seen.add(key);
    }
    return { ...group, registeredProjects: byKey.get(key) ?? [] };
  });

  const emptyProjects: RepoGroup[] = [];
  for (const [key, registrations] of byKey) {
    if (seen.has(key)) continue;
    const primary = registrations[0];
    if (!primary) continue;
    const defaultDisplayName = primary.path.split("/").pop() || primary.path;
    const alias = resolve?.alias(primary.path) ?? null;
    emptyProjects.push({
      id: primary.path,
      repoPath: primary.path,
      displayName: alias ?? defaultDisplayName,
      defaultDisplayName,
      alias,
      color: resolve?.color(primary.path) ?? null,
      remoteOwner: null,
      workspaces: [],
      status: "idle",
      collapsed: false,
      registeredProjects: registrations,
    });
  }
  emptyProjects.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return { groups, emptyProjects };
}
