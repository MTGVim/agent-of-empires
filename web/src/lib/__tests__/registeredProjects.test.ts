// @vitest-environment node
//
// Unit tests for the registry merge that brings the TUI's project-pin
// feature to the web sidebar (#2047): populated repo groups gain their
// registry entries, and registered repos with no live group come back as
// separate `emptyProjects` for the dedicated Projects section (#2212),
// deduped by normalized path.

import { describe, expect, it } from "vitest";

import { mergeRegisteredProjects, normalizeProjectPathKey } from "../registeredProjects";
import { repoGroupToSidebarGroup, sidebarGroupShouldRender } from "../sidebarGroups";
import { MULTI_REPO_GROUP_ID } from "../../hooks/useRepoGroups";
import type { ProjectInfo, RepoGroup, Workspace } from "../types";

function workspace(repoPath: string): Workspace {
  return {
    id: `${repoPath}::w`,
    branch: null,
    projectPath: repoPath,
    displayName: "w",
    agents: ["claude"],
    primaryAgent: "claude",
    status: "idle",
    sessions: [],
  };
}

// A workspace whose only session is archived, so workspaceIsSunk() is true.
function sunkWorkspace(repoPath: string): Workspace {
  return {
    ...workspace(repoPath),
    sessions: [{ archived_at: "2026-01-01T00:00:00Z" } as Workspace["sessions"][number]],
  };
}

function repoGroup(repoPath: string, over: Partial<RepoGroup> = {}): RepoGroup {
  return {
    id: repoPath,
    repoPath,
    displayName: repoPath.split("/").pop() ?? repoPath,
    defaultDisplayName: repoPath.split("/").pop() ?? repoPath,
    alias: null,
    color: null,
    remoteOwner: null,
    workspaces: [workspace(repoPath)],
    status: "idle",
    collapsed: false,
    registeredProjects: [],
    ...over,
  };
}

function project(path: string, over: Partial<ProjectInfo> = {}): ProjectInfo {
  return { name: path.split("/").pop() ?? path, path, scope: "global", ...over };
}

describe("normalizeProjectPathKey", () => {
  it("trims and strips trailing slashes without lowercasing", () => {
    expect(normalizeProjectPathKey("/work/Foo/ ".trim())).toBe("/work/Foo");
    expect(normalizeProjectPathKey("/work/foo/")).toBe("/work/foo");
    expect(normalizeProjectPathKey("/work/foo")).toBe("/work/foo");
    // Case is preserved: distinct repos on a case-sensitive filesystem.
    expect(normalizeProjectPathKey("/work/Foo")).not.toBe(normalizeProjectPathKey("/work/foo"));
  });
});

describe("mergeRegisteredProjects", () => {
  it("attaches the registry entry to a matching populated group (no empty entry)", () => {
    const { groups, emptyProjects } = mergeRegisteredProjects([repoGroup("/work/alpha")], [project("/work/alpha")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.registeredProjects).toHaveLength(1);
    expect(groups[0]!.workspaces).toHaveLength(1);
    expect(emptyProjects).toHaveLength(0);
  });

  it("matches across a trailing-slash difference", () => {
    const { groups, emptyProjects } = mergeRegisteredProjects([repoGroup("/work/alpha")], [project("/work/alpha/")]);
    expect(groups[0]!.registeredProjects).toHaveLength(1);
    expect(emptyProjects).toHaveLength(0);
  });

  it("surfaces a zero-workspace empty project for a registered repo with no live group", () => {
    const { groups, emptyProjects } = mergeRegisteredProjects([], [project("/work/beta")]);
    expect(groups).toHaveLength(0);
    expect(emptyProjects).toHaveLength(1);
    expect(emptyProjects[0]!.repoPath).toBe("/work/beta");
    expect(emptyProjects[0]!.displayName).toBe("beta");
    expect(emptyProjects[0]!.workspaces).toHaveLength(0);
    expect(emptyProjects[0]!.registeredProjects).toHaveLength(1);
  });

  it("collapses a path registered under both global and profile into one empty project", () => {
    const { emptyProjects } = mergeRegisteredProjects(
      [],
      [project("/work/beta", { scope: "global" }), project("/work/beta", { scope: "profile" })],
    );
    expect(emptyProjects).toHaveLength(1);
    expect(emptyProjects[0]!.registeredProjects.map((p) => p.scope)).toEqual(["global", "profile"]);
  });

  it("surfaces a registered repo whose only workspace is sunk as an empty project", () => {
    // All-sunk groups are hidden from the live list, so the registration must
    // fall through to the Projects section instead of vanishing. See #2212.
    const allSunk = repoGroup("/work/alpha", { workspaces: [sunkWorkspace("/work/alpha")] });
    const { groups, emptyProjects } = mergeRegisteredProjects([allSunk], [project("/work/alpha")]);
    expect(groups[0]!.registeredProjects).toHaveLength(1);
    expect(emptyProjects).toHaveLength(1);
    expect(emptyProjects[0]!.repoPath).toBe("/work/alpha");
  });

  it("sorts empty projects by display name", () => {
    const { emptyProjects } = mergeRegisteredProjects([], [project("/work/zeta"), project("/work/alpha")]);
    expect(emptyProjects.map((g) => g.displayName)).toEqual(["alpha", "zeta"]);
  });

  it("leaves an unregistered populated repo untouched", () => {
    const { groups } = mergeRegisteredProjects([repoGroup("/work/gamma")], [project("/work/beta")]);
    const gamma = groups.find((g) => g.repoPath === "/work/gamma")!;
    expect(gamma.registeredProjects).toHaveLength(0);
  });

  it("never pins synthetic Multi-repo / Scratch buckets", () => {
    const synthetic = repoGroup(MULTI_REPO_GROUP_ID, { id: MULTI_REPO_GROUP_ID });
    const { groups } = mergeRegisteredProjects([synthetic], [project(MULTI_REPO_GROUP_ID)]);
    const found = groups.find((g) => g.id === MULTI_REPO_GROUP_ID)!;
    expect(found.registeredProjects).toHaveLength(0);
  });

  it("applies resolved alias/color to empty projects", () => {
    const { emptyProjects } = mergeRegisteredProjects([], [project("/work/beta")], {
      alias: () => "Beta",
      color: () => "teal",
    });
    expect(emptyProjects[0]!.displayName).toBe("Beta");
    expect(emptyProjects[0]!.alias).toBe("Beta");
    expect(emptyProjects[0]!.color).toBe("teal");
  });
});

describe("SidebarGroup pin derivation + render gating", () => {
  it("marks a populated registered repo pinned and renders it", () => {
    const { groups } = mergeRegisteredProjects([repoGroup("/work/alpha")], [project("/work/alpha")]);
    const sg = repoGroupToSidebarGroup(groups[0]!);
    expect(sg.pinned).toBe(true);
    expect(sidebarGroupShouldRender(sg)).toBe(true);
  });

  it("does not render a repo group that has no live workspace", () => {
    const sg = repoGroupToSidebarGroup(repoGroup("/work/beta", { workspaces: [] }));
    expect(sidebarGroupShouldRender(sg)).toBe(false);
  });

  it("leaves an unregistered repo unpinned", () => {
    const sg = repoGroupToSidebarGroup(repoGroup("/work/gamma"));
    expect(sg.pinned).toBe(false);
  });
});
