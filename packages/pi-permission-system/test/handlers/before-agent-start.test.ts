import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ToolRegistry } from "#src/exposure/tool-registry";
import {
  AgentPrepHandler,
  shouldExposeTool,
} from "#src/handlers/before-agent-start";
import { SessionTurnPrep } from "#src/handlers/session-turn-prep";

import {
  makeCheckResult,
  makeCtx,
  makeStatefulToolRegistry,
  makeToolRegistry,
} from "#test/helpers/handler-fixtures";
import {
  makeRealResolver,
  makeRealSession,
} from "#test/helpers/session-fixtures";

// ── SDK stubs ──────────────────────────────────────────────────────────────
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...original,
    isToolCallEventType: vi.fn().mockReturnValue(false),
  };
});

// ── helpers ────────────────────────────────────────────────────────────────

function makeEvent(
  systemPrompt = "You are an assistant.",
  systemPromptOptions: Partial<BuildSystemPromptOptions> & {
    sections?: Record<string, string>;
  } = {},
) {
  return {
    systemPrompt,
    systemPromptOptions: {
      cwd: "/test/project",
      toolSnippets: {},
      promptGuidelines: [],
      ...systemPromptOptions,
    },
  };
}

function makeSetup(opts?: {
  toolFullyDenied?: boolean;
  toolRegistry?: Partial<ToolRegistry>;
  registry?: ToolRegistry;
  /** Whether the node answers as a subagent child; a root by default. */
  isSubagentChild?: boolean;
}) {
  const {
    session,
    permissionManager,
    sessionRules,
    configStore,
    forwarding,
    logger,
  } = makeRealSession();
  const { resolver } = makeRealResolver(permissionManager, sessionRules);
  if (opts?.toolFullyDenied !== undefined) {
    vi.mocked(permissionManager.isToolFullyDenied).mockReturnValue(
      opts.toolFullyDenied,
    );
  }
  // Default check returns allow (for skill-prompt sanitizer via resolver.checkPermission)
  vi.mocked(permissionManager.check).mockReturnValue(makeCheckResult());
  const toolRegistry = opts?.registry ?? makeToolRegistry(opts?.toolRegistry);
  const warmParser = vi.fn();
  // A real SessionTurnPrep over the same session: the tool-filtering and
  // prompt-sanitization assertions below read state an activated session owns,
  // so a `{ prepare: vi.fn() }` double would quietly change what they exercise.
  const turnPrep = new SessionTurnPrep(
    session,
    warmParser,
    { announceReady: vi.fn() },
    { report: vi.fn() },
  );
  const detector = {
    isSubagent: vi.fn(() => opts?.isSubagentChild ?? false),
  };
  const handler = new AgentPrepHandler(
    turnPrep,
    session,
    resolver,
    toolRegistry,
    logger,
    detector,
  );
  return {
    handler,
    detector,
    turnPrep,
    session,
    resolver,
    permissionManager,
    configStore,
    forwarding,
    toolRegistry,
    logger,
    warmParser,
  };
}

// ── shouldExposeTool (pure helper) ─────────────────────────────────────────

describe("shouldExposeTool", () => {
  it("returns true when some value under the surface is reachable", () => {
    const isFullyDenied = vi.fn().mockReturnValue(false);
    expect(shouldExposeTool("read", null, isFullyDenied)).toBe(true);
  });

  it("returns false when every value under the surface is denied", () => {
    const isFullyDenied = vi.fn().mockReturnValue(true);
    expect(shouldExposeTool("write", null, isFullyDenied)).toBe(false);
  });

  it("passes agentName through to isToolFullyDenied", () => {
    const isFullyDenied = vi.fn().mockReturnValue(false);
    shouldExposeTool("read", "my-agent", isFullyDenied);
    expect(isFullyDenied).toHaveBeenCalledWith("read", "my-agent");
  });

  it("converts null agentName to undefined for isToolFullyDenied", () => {
    const isFullyDenied = vi.fn().mockReturnValue(false);
    shouldExposeTool("read", null, isFullyDenied);
    expect(isFullyDenied).toHaveBeenCalledWith("read", undefined);
  });
});

// ── AgentPrepHandler.handle ────────────────────────────────────────────────

describe("AgentPrepHandler.handle", () => {
  it("redacts historical metadata without deleting shared guidelines or user messages", async () => {
    const registry = makeToolRegistry({
      getAll: () => [
        { name: "read", promptGuidelines: ["Shared rule"] },
        { name: "bash", promptGuidelines: ["Shared rule", "Private rule"] },
      ],
    });
    const { handler, permissionManager } = makeSetup({ registry });
    vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
      (name) => name === "bash",
    );
    vi.mocked(permissionManager.check).mockImplementation((intent) =>
      intent.surface === "skill"
        ? makeCheckResult({ state: "deny" })
        : makeCheckResult(),
    );
    await handler.handle(makeEvent("Identity"), makeCtx());
    const skill =
      "<available_skills><skill><name>secret</name><description>Secret description</description><location>/skills/secret/SKILL.md</location></skill></available_skills>";
    const user = { role: "user", content: skill };
    const messages = [
      {
        role: "system",
        content: "Unrelated text",
        sections: {
          skills: skill,
          tools: "<tools>\n- read: Read\n- bash: Shell\n</tools>",
          rules:
            "<rules>\n- Shared rule\n- Private rule\n- User-authored rule\n</rules>",
        },
        toolsAdded: [{ name: "read" }],
        timestamp: 1,
      },
      user,
    ];
    const result = handler.handleContext({ messages });
    expect(result.messages).toEqual([
      {
        ...messages[0],
        sections: {
          skills: "",
          tools: "<tools>\n- read: Read\n</tools>",
          rules: "<rules>\n- Shared rule\n- User-authored rule\n</rules>",
        },
      },
      user,
    ]);
    expect(result.messages[1]).toBe(user);
    expect(handler.handleContext(result).messages).toBe(result.messages);
  });

  it("projects the sanitized legacy head when historical sanitation throws", async () => {
    const { handler, resolver } = makeSetup();
    const prepared = await handler.handle(
      makeEvent("Safe identity"),
      makeCtx(),
    );
    vi.spyOn(resolver, "checkPermission").mockImplementation(() => {
      throw new Error("sanitizer failed");
    });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const messages = [
      {
        role: "system",
        content:
          "<available_skills><skill><name>secret</name><description>secret</description><location>/secret</location></skill></available_skills>",
        sections: { skills: "secret" },
        toolsAdded: [{ name: "read" }],
      },
      { role: "user", content: "Keep me" },
      {
        role: "system",
        content: "old",
        sections: { rules: "old" },
        toolsRemoved: ["bash"],
      },
    ];
    expect(handler.handleContext({ messages }).messages).toEqual([
      {
        role: "system",
        content: prepared.systemPrompt,
        toolsAdded: [{ name: "read" }],
      },
      messages[1],
      { role: "system", content: "", toolsRemoved: ["bash"] },
    ]);
    expect(diagnostic.mock.calls[0][1]).toEqual(new Error("sanitizer failed"));
    diagnostic.mockRestore();
  });
  it.each(["tools", "rules"])(
    "uses legacy projection for a stale getter exposing withheld %s",
    async (section) => {
      const registry = makeToolRegistry({
        getActive: () => ["read", "bash"],
        getAll: () => [
          { name: "read", promptGuidelines: ["Shared rule"] },
          { name: "bash", promptGuidelines: ["Shared rule", "Private rule"] },
        ],
      });
      const { handler, permissionManager } = makeSetup({ registry });
      vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
        (name) => name === "bash",
      );
      const event = makeEvent(
        `Pi head\n\n<tools>\n- read: Visible\n${section === "tools" ? "- bash: Hidden\n" : ""}</tools>\n\n<rules>\n- Shared rule\n${section === "rules" ? "- Private rule\n" : ""}</rules>\n\n<cwd>\n/test/project\n</cwd>\n\nUser text mentions bash and Private rule.`,
        {
          sections: {},
          skills: [],
          toolSnippets: { read: "Visible", bash: "Hidden" },
        },
      );
      const optionsBefore = structuredClone(event.systemPromptOptions);
      const diagnostic = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      try {
        const result = await handler.handle(event, makeCtx());
        expect(result.systemPrompt).toContain("- read: Visible");
        expect(result.systemPrompt).toContain("- Shared rule");
        expect(result.systemPrompt).not.toContain("- bash: Hidden");
        expect(result.systemPrompt).not.toContain("- Private rule");
        expect(result.systemPrompt).toContain(
          "User text mentions bash and Private rule.",
        );
        expect(event.systemPromptOptions).toEqual(optionsBefore);
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
          "Permission prompt getter retains withheld metadata; using legacy projection.",
        );
      } finally {
        diagnostic.mockRestore();
      }
    },
  );

  it("does not treat unrelated mentions or shared rules as stale owned metadata", async () => {
    const registry = makeToolRegistry({
      getActive: () => ["read", "bash"],
      getAll: () => [
        { name: "read", promptGuidelines: ["Shared rule"] },
        { name: "bash", promptGuidelines: ["Shared rule"] },
      ],
    });
    const { handler, permissionManager } = makeSetup({ registry });
    vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
      (name) => name === "bash",
    );
    const event = makeEvent(
      "Pi head\n\n<tools>\n- read: Visible\n</tools>\n\n<rules>\n- Shared rule\n</rules>\n\n<cwd>\n/test/project\n</cwd>\n\n- bash: User-authored mention",
      { sections: {}, skills: [] },
    );
    expect(await handler.handle(event, makeCtx())).toEqual({});
    expect(event.systemPrompt).toContain("- bash: User-authored mention");
  });

  it("keeps supported root prompts structured instead of relocating the tool surface", async () => {
    const { handler, toolRegistry } = makeSetup();
    const event = makeEvent(
      "Pi head\n\n<tools>\n- read: Read files\n</tools>\n\n<cwd>\n/test/project\n</cwd>",
    );
    Object.assign(event.systemPromptOptions, { sections: {}, skills: [] });
    expect(await handler.handle(event, makeCtx())).toEqual({});
    expect(toolRegistry.setActive).toHaveBeenCalled();
    expect(event.systemPrompt).toContain("Pi head");
  });
  it("prepares the session for the turn before reading its state", async () => {
    const ctx = makeCtx();
    const { handler, turnPrep, session } = makeSetup();
    const order: string[] = [];
    vi.spyOn(turnPrep, "prepare").mockImplementation(() => {
      order.push("prepare");
    });
    vi.spyOn(session, "resolveAgentName").mockImplementation(() => {
      order.push("resolveAgentName");
      return null;
    });
    await handler.handle(makeEvent(), ctx);
    expect(order).toEqual(["prepare", "resolveAgentName"]);
    expect(turnPrep.prepare).toHaveBeenCalledWith(ctx);
  });

  it("resolves agent name using systemPrompt", async () => {
    const ctx = makeCtx();
    const { handler, session } = makeSetup();
    const spy = vi.spyOn(session, "resolveAgentName");
    await handler.handle(makeEvent("<active_agent name='x'>"), ctx);
    expect(spy).toHaveBeenCalledWith(ctx, "<active_agent name='x'>");
  });

  it("filters out denied tools from allowed list", async () => {
    const { handler, toolRegistry } = makeSetup({
      toolFullyDenied: true,
      toolRegistry: {
        getActive: vi.fn().mockReturnValue(["write", "read"]),
      },
    });
    await handler.handle(makeEvent(), makeCtx());
    expect(toolRegistry.setActive).toHaveBeenCalledWith([]);
  });

  it("includes allowed and ask tools in the active list", async () => {
    const { handler, toolRegistry } = makeSetup({
      toolRegistry: {
        getActive: vi.fn().mockReturnValue(["read", "write"]),
      },
    });
    await handler.handle(makeEvent(), makeCtx());
    expect(toolRegistry.setActive).toHaveBeenCalledWith(["read", "write"]);
  });

  it("does not activate registered tools pi left inactive (find/grep/ls)", async () => {
    // Regression for #385: the active set is the base, not the full registry.
    const { handler, toolRegistry } = makeSetup({
      toolRegistry: {
        getActive: vi.fn().mockReturnValue(["read", "bash", "edit", "write"]),
        getAll: vi
          .fn()
          .mockReturnValue([
            { name: "read" },
            { name: "bash" },
            { name: "edit" },
            { name: "write" },
            { name: "find" },
            { name: "grep" },
            { name: "ls" },
          ]),
      },
    });
    await handler.handle(makeEvent(), makeCtx());
    expect(toolRegistry.setActive).toHaveBeenCalledWith([
      "read",
      "bash",
      "edit",
      "write",
    ]);
  });

  it("calls setActive on every turn (no dedup gate)", async () => {
    const { handler, toolRegistry } = makeSetup({
      toolRegistry: {
        getActive: vi.fn().mockReturnValue(["read"]),
      },
    });
    await handler.handle(makeEvent(), makeCtx());
    await handler.handle(makeEvent(), makeCtx());
    expect(toolRegistry.setActive).toHaveBeenCalledTimes(2);
  });

  it("filters a denied skill from the systemPrompt on every turn, not just the first", async () => {
    const systemPrompt = [
      "You are an assistant.",
      "",
      "<available_skills>",
      "  <skill>",
      "    <name>secret</name>",
      "    <description>A denied skill</description>",
      "    <location>/skills/secret/SKILL.md</location>",
      "  </skill>",
      "</available_skills>",
    ].join("\n");
    const { handler, permissionManager } = makeSetup();
    vi.mocked(permissionManager.check).mockImplementation((intent) =>
      intent.surface === "skill"
        ? makeCheckResult({ state: "deny" })
        : makeCheckResult(),
    );

    const first = await handler.handle(makeEvent(systemPrompt), makeCtx());
    const second = await handler.handle(makeEvent(systemPrompt), makeCtx());

    expect(first).toHaveProperty("systemPrompt");
    expect((first as { systemPrompt: string }).systemPrompt).not.toContain(
      "secret",
    );
    expect(second).toHaveProperty("systemPrompt");
    expect((second as { systemPrompt: string }).systemPrompt).not.toContain(
      "secret",
    );
  });

  it("returns the same override on repeated calls with unchanged inputs", async () => {
    const { handler } = makeSetup();
    const first = await handler.handle(makeEvent(), makeCtx());
    const second = await handler.handle(makeEvent(), makeCtx());
    expect(second.systemPrompt).toBe(first.systemPrompt);
  });

  it("stores resolved skill entries on the session", async () => {
    const { handler, session } = makeSetup();
    const spy = vi.spyOn(session, "setActiveSkillEntries");
    await handler.handle(makeEvent(), makeCtx());
    expect(spy).toHaveBeenCalledWith(expect.any(Array));
  });

  it("returns modified systemPrompt when prompt changes", async () => {
    const systemPrompt = `You are an assistant.\n\nAvailable tools:\n- read\n- write\n`;
    const { handler } = makeSetup();
    const result = await handler.handle(makeEvent(systemPrompt), makeCtx());
    expect(result).toHaveProperty("systemPrompt");
  });

  it("states the session's tools for a prompt that carries no tool surface", async () => {
    // A subagent child's inherited identity has none: its parent's node already
    // relocated the surface out of the region the child copies (#890).
    const prompt = "No tools section here.";
    const { handler } = makeSetup({
      toolRegistry: { getActive: vi.fn().mockReturnValue(["read"]) },
    });

    const result = await handler.handle(
      makeEvent(prompt, { toolSnippets: { read: "Read file contents" } }),
      makeCtx(),
    );

    expect(result.systemPrompt).toContain(
      "Available tools:\n- read: Read file contents",
    );
    expect(result.systemPrompt?.startsWith(prompt)).toBe(true);
  });

  describe("under a custom system prompt", () => {
    const custom = "You are my personal coding assistant.";

    it("returns an operator's custom prompt as Pi built it", async () => {
      // Pi writes no tool list or rules under a custom prompt, so a root node
      // adds none either.
      const { handler } = makeSetup({
        toolRegistry: { getActive: vi.fn().mockReturnValue(["read"]) },
      });

      const result = await handler.handle(
        makeEvent(custom, {
          customPrompt: custom,
          toolSnippets: { read: "Read file contents" },
        }),
        makeCtx(),
      );

      expect(result).toEqual({});
    });

    it("still filters the active tools under an operator's custom prompt", async () => {
      const { handler, toolRegistry, permissionManager } = makeSetup();
      vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
        (tool) => tool === "bash",
      );

      const result = await handler.handle(
        makeEvent(custom, {
          customPrompt: custom,
          toolSnippets: { read: "Read file contents", bash: "Run commands" },
        }),
        makeCtx(),
      );

      expect(toolRegistry.setActive).toHaveBeenCalledWith(["read"]);
      expect(result).toEqual({});
    });

    it("still filters a denied skill out of an operator's custom prompt", async () => {
      const systemPrompt = [
        custom,
        "",
        "<available_skills>",
        "  <skill>",
        "    <name>secret</name>",
        "    <description>A denied skill</description>",
        "    <location>/skills/secret/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n");
      const { handler, permissionManager } = makeSetup({
        toolRegistry: { getActive: vi.fn().mockReturnValue(["read"]) },
      });
      vi.mocked(permissionManager.check).mockImplementation((intent) =>
        intent.surface === "skill"
          ? makeCheckResult({ state: "deny" })
          : makeCheckResult(),
      );

      const result = await handler.handle(
        makeEvent(systemPrompt, {
          customPrompt: custom,
          toolSnippets: { read: "Read file contents" },
        }),
        makeCtx(),
      );

      const out = result.systemPrompt ?? "";
      expect(out.startsWith(custom)).toBe(true);
      expect(out).not.toContain("secret");
      expect(out).not.toContain("Available tools:");
      expect(out).not.toContain("<tools>");
    });

    it("states a subagent child's tools although Pi built its prompt from a custom one", async () => {
      // Every pi-subagents child is a customPrompt session too, and its
      // inherited identity carries no tool list, so the block is its only
      // tool prose.
      const { handler } = makeSetup({
        isSubagentChild: true,
        toolRegistry: { getActive: vi.fn().mockReturnValue(["read"]) },
      });

      const result = await handler.handle(
        makeEvent(custom, {
          customPrompt: custom,
          toolSnippets: { read: "Read file contents" },
        }),
        makeCtx(),
      );

      expect(result.systemPrompt).toContain(
        "Available tools:\n- read: Read file contents",
      );
    });

    it("reads an empty custom prompt as none, the way Pi does", async () => {
      const systemPrompt = [
        "You are an assistant.",
        "",
        "Available tools:",
        "- read: Read file contents",
      ].join("\n");
      const { handler } = makeSetup({
        toolRegistry: { getActive: vi.fn().mockReturnValue(["read"]) },
      });

      const result = await handler.handle(
        makeEvent(systemPrompt, {
          customPrompt: "",
          toolSnippets: { read: "Read file contents" },
        }),
        makeCtx(),
      );

      expect(result.systemPrompt).toBe(
        [
          "You are an assistant.",
          "",
          "Available tools:",
          "- read: Read file contents",
          "",
          "Guidelines:",
          "- Use read to examine files.",
          "- Be concise in your responses",
          "- Show file paths clearly when working with files",
        ].join("\n"),
      );
    });

    it("keeps a subagent child's inherited custom tool and guideline sections", async () => {
      // A child whose root runs a user's SYSTEM.md inherits that text as its
      // identity; the pass still runs there and must not remove it.
      const inherited = [
        custom,
        "",
        "Available tools:",
        "- read: only for reviewing code",
        "",
        "Guidelines:",
        "- Always ask before writing files",
        "",
        "Answer with one word.",
      ].join("\n");
      const { handler } = makeSetup({
        isSubagentChild: true,
        toolRegistry: { getActive: vi.fn().mockReturnValue(["read"]) },
      });

      const result = await handler.handle(
        makeEvent(inherited, {
          customPrompt: inherited,
          toolSnippets: { read: "Read file contents" },
        }),
        makeCtx(),
      );

      expect(result.systemPrompt?.startsWith(inherited)).toBe(true);
    });
  });

  it("states the allowed tools instead of editing the listing Pi wrote", async () => {
    const identity = "You are an assistant.";
    const systemPrompt = [
      identity,
      "",
      "Available tools:",
      "- read: Read file contents",
      "- bash: Run shell commands",
    ].join("\n");
    const { handler, permissionManager } = makeSetup({
      toolRegistry: {
        getActive: vi.fn().mockReturnValue(["read", "bash"]),
      },
    });
    vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
      (tool) => tool === "bash",
    );

    const result = await handler.handle(
      makeEvent(systemPrompt, {
        toolSnippets: {
          read: "Read file contents",
          bash: "Run shell commands",
        },
      }),
      makeCtx(),
    );

    const out = result.systemPrompt ?? "";
    // The identity Pi wrote is left alone; the surface is restated after it.
    expect(out.startsWith(identity)).toBe(true);
    expect(out).toContain("Available tools:\n- read: Read file contents");
    expect(out).not.toContain("- bash");
  });

  it("carries the registry's guidelines for allowed tools and drops a denied tool's", async () => {
    // The whole path: toolRegistry.getAll() -> readRegisteredTools ->
    // guidelinesByTool -> renderToolSurface. The unit tests cover each hop; this
    // pins that the handler actually connects them.
    const { handler, permissionManager } = makeSetup();
    vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
      (tool) => tool === "bash",
    );

    const result = await handler.handle(makeEvent(), makeCtx());

    expect(result.systemPrompt).toContain("- Use read to examine files.");
    expect(result.systemPrompt).not.toContain("Use bash for file operations.");
  });

  it("carries the rules another extension added to the prompt options", async () => {
    const { handler } = makeSetup();

    const result = await handler.handle(
      makeEvent(undefined, { promptGuidelines: ["An extension's rule"] }),
      makeCtx(),
    );

    expect(result.systemPrompt).toContain("- An extension's rule");
  });

  it("keeps the wire system prompt stable across the tool-listing drift between turns", async () => {
    const fullProse = [
      "You are an assistant.",
      "",
      "Available tools:",
      "- bash: Run shell commands",
      "- read: Read file contents",
      "- edit: Edit a file",
      "",
      "Guidelines:",
      "- Use bash for file operations like ls, rg, find",
      "- Be concise in your responses",
    ].join("\n");
    const narrowedProse = [
      "You are an assistant.",
      "",
      "Available tools:",
      "- read: Read file contents",
      "- edit: Edit a file",
      "",
      "Guidelines:",
      "- Be concise in your responses",
    ].join("\n");
    const snippets = {
      bash: "Run shell commands",
      read: "Read file contents",
      edit: "Edit a file",
    };
    const { handler, permissionManager } = makeSetup({
      toolRegistry: {
        getActive: vi.fn().mockReturnValue(["bash", "read", "edit"]),
      },
    });
    vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
      (tool) => tool === "bash",
    );

    // Turn 1: Pi feeds the full default listing.
    const first = await handler.handle(
      makeEvent(fullProse, { toolSnippets: snippets }),
      makeCtx(),
    );
    // Turn 2: Pi's setActive rebuild means the event now carries the narrowed
    // listing, so the override the handler returns must still match turn 1.
    const second = await handler.handle(
      makeEvent(narrowedProse, { toolSnippets: snippets }),
      makeCtx(),
    );

    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(first.systemPrompt).toBe(
      [
        "You are an assistant.",
        "",
        "Available tools:",
        "- read: Read file contents",
        "- edit: Edit a file",
        "",
        "Guidelines:",
        "- Use read to examine files.",
        "- Be concise in your responses",
        "- Show file paths clearly when working with files",
      ].join("\n"),
    );
  });

  describe("policy changes across turns", () => {
    const PI_DEFAULTS = ["read", "bash", "edit", "write"];
    const LAUNCHED_WITH = [...PI_DEFAULTS, "ls", "find", "grep"];

    function denyOnly(deniedTool: string) {
      return (toolName: string) => toolName === deniedTool;
    }

    it("restores a tool after its deny rule is removed, without a restart", async () => {
      const registry = makeStatefulToolRegistry({ active: LAUNCHED_WITH });
      const { handler, permissionManager } = makeSetup({ registry });

      await handler.handle(makeEvent(), makeCtx());
      expect(registry.getActive()).toEqual(LAUNCHED_WITH);

      vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
        denyOnly("ls"),
      );
      await handler.handle(makeEvent(), makeCtx());
      expect(registry.getActive()).toEqual([
        "read",
        "bash",
        "edit",
        "write",
        "find",
        "grep",
      ]);

      vi.mocked(permissionManager.isToolFullyDenied).mockReturnValue(false);
      await handler.handle(makeEvent(), makeCtx());
      expect(registry.getActive()).toEqual(LAUNCHED_WITH);
    });

    it("keeps a tool withheld for as long as its deny rule stands", async () => {
      const registry = makeStatefulToolRegistry({ active: LAUNCHED_WITH });
      const { handler, permissionManager } = makeSetup({ registry });
      vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
        denyOnly("ls"),
      );

      await handler.handle(makeEvent(), makeCtx());
      await handler.handle(makeEvent(), makeCtx());
      await handler.handle(makeEvent(), makeCtx());

      expect(registry.getActive()).not.toContain("ls");
    });

    it("does not reactivate a withheld tool that pi unregistered and re-registered", async () => {
      const registry = makeStatefulToolRegistry({ active: LAUNCHED_WITH });
      const { handler, permissionManager } = makeSetup({ registry });
      vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
        denyOnly("ls"),
      );

      await handler.handle(makeEvent(), makeCtx());
      registry.unregister("ls");
      await handler.handle(makeEvent(), makeCtx());
      registry.register("ls");
      vi.mocked(permissionManager.isToolFullyDenied).mockReturnValue(false);
      await handler.handle(makeEvent(), makeCtx());

      expect(registry.getActive()).not.toContain("ls");
    });

    it("records the withheld tools on the debug stream when the surface changes", async () => {
      const registry = makeStatefulToolRegistry({ active: LAUNCHED_WITH });
      const { handler, permissionManager, logger } = makeSetup({ registry });
      vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
        denyOnly("ls"),
      );

      await handler.handle(makeEvent(), makeCtx());

      expect(logger.debug).toHaveBeenCalledWith("tool_surface.changed", {
        exposed: ["read", "bash", "edit", "write", "find", "grep"],
        withheld: ["ls"],
        restored: [],
      });
    });

    it("records the restored tools when a rule is relaxed", async () => {
      const registry = makeStatefulToolRegistry({ active: LAUNCHED_WITH });
      const { handler, permissionManager, logger } = makeSetup({ registry });
      vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
        denyOnly("ls"),
      );
      await handler.handle(makeEvent(), makeCtx());
      vi.mocked(logger.debug).mockClear();

      vi.mocked(permissionManager.isToolFullyDenied).mockReturnValue(false);
      await handler.handle(makeEvent(), makeCtx());

      expect(logger.debug).toHaveBeenCalledWith("tool_surface.changed", {
        exposed: LAUNCHED_WITH,
        withheld: [],
        restored: ["ls"],
      });
    });

    it("stays quiet while the surface is unchanged", async () => {
      const registry = makeStatefulToolRegistry({ active: LAUNCHED_WITH });
      const { handler, permissionManager, logger } = makeSetup({ registry });
      vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
        denyOnly("ls"),
      );
      await handler.handle(makeEvent(), makeCtx());
      vi.mocked(logger.debug).mockClear();

      await handler.handle(makeEvent(), makeCtx());
      await handler.handle(makeEvent(), makeCtx());

      expect(logger.debug).not.toHaveBeenCalled();
    });

    it("does not activate a registered tool pi left inactive when the policy relaxes", async () => {
      const registry = makeStatefulToolRegistry({
        active: PI_DEFAULTS,
        registered: LAUNCHED_WITH,
      });
      const { handler, permissionManager } = makeSetup({ registry });
      vi.mocked(permissionManager.isToolFullyDenied).mockImplementation(
        denyOnly("bash"),
      );

      await handler.handle(makeEvent(), makeCtx());
      vi.mocked(permissionManager.isToolFullyDenied).mockReturnValue(false);
      await handler.handle(makeEvent(), makeCtx());

      expect(registry.getActive()).toEqual(PI_DEFAULTS);
    });
  });
});
