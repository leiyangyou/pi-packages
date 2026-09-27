import type {
  BeforeAgentStartEventResult,
  ExtensionContext,
  Skill,
} from "@earendil-works/pi-coding-agent";
import type { SubagentDetector } from "#src/authority/subagent-detection";
import {
  filterAllowedSkills,
  resolveSkillPromptEntries,
} from "#src/exposure/skill-prompt-sanitizer";
import {
  type RegisteredTools,
  readRegisteredTools,
  type ToolRegistry,
} from "#src/exposure/tool-registry";
import type { ToolSurfaceObservation } from "#src/exposure/tool-surface-baseline";
import {
  renderToolSurface,
  toolSurfaceBullets,
} from "#src/exposure/tool-surface-prompt";
import type { DebugLogger } from "#src/logging/session-logger";
import type { PermissionResolver } from "#src/policy/permission-resolver";
import type { PermissionSession } from "#src/session/permission-session";
import type { TurnPreparation } from "./session-turn-prep";

/** Minimal subset of BeforeAgentStartEvent used by this handler. */
interface BeforeAgentStartPayload {
  systemPrompt: string;
  /**
   * The parts Pi assembled the prompt from. `toolSnippets` is what lets this
   * handler render the session's own tool list instead of editing the one Pi
   * wrote — including in a child, whose inherited identity carries none.
   * `customPrompt` says whether Pi wrote a preamble at all: under one, it
   * writes no tool surface, so there is nothing of Pi's to remove, and a root
   * node adds none either.
   * `promptGuidelines` carries rules other extensions added, which removing
   * Pi's own rules section would otherwise drop.
   */
  systemPromptOptions?: {
    customPrompt?: string;
    forceSystemPrompt?: string;
    appendSystemPrompt?: string;
    skills?: Skill[];
    sections?: Record<string, string>;
    toolSnippets?: Record<string, string>;
    promptGuidelines?: readonly string[];
  };
}

/**
 * Pure helper: returns true when the tool should be exposed to the agent.
 *
 * A tool is withheld only when *every* value under its surface resolves to
 * `deny`, so a blanket `bash: deny` hides the tool entirely while a partially
 * permissive `bash: {"*": "deny", "git *": "ask"}` keeps it reachable (#815).
 */
export function shouldExposeTool(
  toolName: string,
  agentName: string | null,
  isToolFullyDenied: (toolName: string, agentName?: string) => boolean,
): boolean {
  return !isToolFullyDenied(toolName, agentName ?? undefined);
}

/**
 * Handles the `before_agent_start` event: tool filtering + prompt sanitization.
 *
 * Recomputes the active tool set and the returned system-prompt override on
 * every fire (no memoization): the override must be returned each turn so that
 * skill filtering is reapplied and the wire prompt stays stable across turns,
 * rather than letting Pi reset to its skill-unfiltered base prompt on a cache
 * hit.
 *
 * The tool surface is relocated rather than edited in place, so a subagent
 * child's inherited identity stays byte-identical to its parent's (#890).
 * A root node whose prompt Pi built from a custom one states no tool surface,
 * matching Pi, which writes none there; a subagent child's prompt is always a
 * custom one, and it still states its own tools.
 *
 * Constructor deps:
 * - `turnPrep` — brings the node up to date for the turn before anything reads
 *   session state
 * - `session` — encapsulates all mutable session state and lifecycle operations
 * - `resolver` — owns permission-query surface: `isToolFullyDenied`, skill check
 * - `toolRegistry` — Pi tool API subset (getAll + getActive + setActive)
 * - `logger` — records each change to the effective tool surface
 * - `detector` — tells a subagent child from a root, which decides whether a
 *   custom prompt gets this node's tool surface
 *
 * The active set is recomputed from the session's pre-filter tool surface
 * every turn, so relaxing a rule restores the tool it had withheld (#873).
 */
export class AgentPrepHandler {
  private lastLegacyPrompt = "";
  private agentName: string | null = null;
  private withheldTools = new Set<string>();
  private withheldRules = new Set<string>();
  constructor(
    private readonly turnPrep: TurnPreparation,
    private readonly session: PermissionSession,
    private readonly resolver: PermissionResolver,
    private readonly toolRegistry: ToolRegistry,
    private readonly logger: DebugLogger,
    private readonly detector: SubagentDetector,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async handle(
    event: BeforeAgentStartPayload,
    ctx: ExtensionContext,
  ): Promise<BeforeAgentStartEventResult> {
    this.turnPrep.prepare(ctx);

    const agentName = this.session.resolveAgentName(ctx, event.systemPrompt);
    const registered = readRegisteredTools(this.toolRegistry.getAll());
    const surface = this.session.resolveExposedTools(
      this.observeToolSurface(registered),
      (toolName) =>
        shouldExposeTool(toolName, agentName, (t, a) =>
          this.resolver.isToolFullyDenied(t, a),
        ),
    );
    const allowedTools = [...surface.exposed];

    this.toolRegistry.setActive(allowedTools);
    if (surface.changed) {
      this.logger.debug("tool_surface.changed", {
        exposed: surface.exposed,
        withheld: surface.withheld,
        restored: surface.restored,
      });
    }

    const toolSurfacePrompt = this.statesOwnToolSurface(event, ctx)
      ? renderToolSurface(event.systemPrompt, {
          allowedTools,
          toolSnippets: event.systemPromptOptions?.toolSnippets ?? {},
          guidelinesByTool: registered.guidelinesByTool,
          promptGuidelines: event.systemPromptOptions?.promptGuidelines ?? [],
          piAuthoredPreamble: !hasCustomPrompt(event),
        })
      : event.systemPrompt;
    const skillPromptResult = resolveSkillPromptEntries(
      toolSurfacePrompt,
      this.resolver,
      agentName,
      this.session.getPathNormalizer(),
    );
    this.lastLegacyPrompt = skillPromptResult.prompt;
    this.agentName = agentName;
    this.withheldTools = new Set(surface.withheld);
    const allowedRules = new Set(
      toolSurfaceBullets({
        allowedTools: registered.names.filter(
          (name) => !this.withheldTools.has(name),
        ),
        toolSnippets: event.systemPromptOptions?.toolSnippets ?? {},
        guidelinesByTool: registered.guidelinesByTool,
        promptGuidelines: event.systemPromptOptions?.promptGuidelines ?? [],
        piAuthoredPreamble: !hasCustomPrompt(event),
      }).rules,
    );
    this.withheldRules = new Set(
      toolSurfaceBullets({
        allowedTools: [...this.withheldTools],
        toolSnippets: event.systemPromptOptions?.toolSnippets ?? {},
        guidelinesByTool: registered.guidelinesByTool,
        promptGuidelines: event.systemPromptOptions?.promptGuidelines ?? [],
        piAuthoredPreamble: !hasCustomPrompt(event),
      }).rules.filter((rule) => !allowedRules.has(rule)),
    );
    this.session.setActiveSkillEntries(skillPromptResult.entries);
    const options = event.systemPromptOptions;
    if (
      options &&
      options.forceSystemPrompt === undefined &&
      options.sections != null &&
      typeof options.sections === "object" &&
      Array.isArray(options.skills)
    ) {
      try {
        const normalizer = this.session.getPathNormalizer();
        const skills = filterAllowedSkills(
          options.skills,
          this.resolver,
          agentName,
        );
        const customPrompt =
          options.customPrompt === undefined
            ? undefined
            : resolveSkillPromptEntries(
                options.customPrompt,
                this.resolver,
                agentName,
                normalizer,
              ).prompt;
        const appendSystemPrompt =
          options.appendSystemPrompt === undefined
            ? undefined
            : resolveSkillPromptEntries(
                options.appendSystemPrompt,
                this.resolver,
                agentName,
                normalizer,
              ).prompt;
        const ownSurface =
          hasCustomPrompt(event) && this.detector.isSubagent(ctx)
            ? toolSurfaceBullets({
                allowedTools,
                toolSnippets: options.toolSnippets ?? {},
                guidelinesByTool: registered.guidelinesByTool,
                promptGuidelines: options.promptGuidelines ?? [],
                piAuthoredPreamble: false,
              })
            : undefined;
        options.skills = skills;
        options.customPrompt = customPrompt;
        options.appendSystemPrompt = appendSystemPrompt;
        if (ownSurface) {
          if (ownSurface.tools.length)
            options.sections.tools = ownSurface.tools.join("\n");
          else delete options.sections.tools;
          options.sections.rules = ownSurface.rules.join("\n");
        }
        const final = resolveSkillPromptEntries(
          event.systemPrompt,
          this.resolver,
          agentName,
          normalizer,
        );
        this.session.setActiveSkillEntries(final.entries);
        if (final.prompt === event.systemPrompt) return {};
      } catch (error) {
        console.error(
          "Permission structured prompt failed; using legacy prompt:",
          error,
        );
      }
      this.session.setActiveSkillEntries(skillPromptResult.entries);
      return { systemPrompt: this.lastLegacyPrompt };
    }
    return skillPromptResult.prompt !== event.systemPrompt
      ? { systemPrompt: skillPromptResult.prompt }
      : {};
  }

  handleContext(event: { messages: unknown[] }): { messages: unknown[] } {
    try {
      let changed = false;
      const sanitize = (text: string) =>
        resolveSkillPromptEntries(
          text,
          this.resolver,
          this.agentName,
          this.session.getPathNormalizer(),
        ).prompt;
      const messages = event.messages.map((message) => {
        if (
          !message ||
          typeof message !== "object" ||
          !("role" in message) ||
          message.role !== "system"
        )
          return message;
        const system = message as {
          role: unknown;
          content: string;
          sections?: Record<string, string | null>;
        };
        const content = sanitize(system.content);
        let sections = system.sections;
        if (sections) {
          const rewritten = Object.fromEntries(
            Object.entries(sections).map(([key, value]) => {
              if (value === null) return [key, value];
              let text = sanitize(value);
              if (key === "tools")
                text = text
                  .split("\n")
                  .filter((line) => {
                    const name = /^- ([^:]+): /.exec(line)?.[1];
                    return name === undefined || !this.withheldTools.has(name);
                  })
                  .join("\n");
              if (key === "rules")
                text = text
                  .split("\n")
                  .filter((line) => !this.withheldRules.has(line))
                  .join("\n");
              return [key, text];
            }),
          );
          if (
            Object.keys(rewritten).some(
              (key) => rewritten[key] !== sections?.[key],
            )
          )
            sections = rewritten;
        }
        if (content === system.content && sections === system.sections)
          return message;
        changed = true;
        return { ...message, content, ...(sections ? { sections } : {}) };
      });
      return { messages: changed ? messages : event.messages };
    } catch (error) {
      console.error(
        "Permission history sanitation failed; using legacy projection:",
        error,
      );
      let head = true;
      return {
        messages: event.messages.map((message) => {
          if (
            !message ||
            typeof message !== "object" ||
            !("role" in message) ||
            message.role !== "system"
          )
            return message;
          const { sections: _sections, ...system } = message as Record<
            string,
            unknown
          >;
          const content = head ? this.lastLegacyPrompt : "";
          head = false;
          return { ...system, content };
        }),
      };
    }
  }

  /**
   * Whether this node renders its own tool surface into the prompt.
   *
   * Every node does except a root whose prompt Pi built from a custom one:
   * there Pi writes no tool list or rules, and the operator's prompt is left
   * as Pi built it. A subagent child's prompt is always a custom one, and its
   * inherited identity carries no tool list, so it still states its own.
   */
  private statesOwnToolSurface(
    event: BeforeAgentStartPayload,
    ctx: ExtensionContext,
  ): boolean {
    return !hasCustomPrompt(event) || this.detector.isSubagent(ctx);
  }

  private observeToolSurface(
    registered: RegisteredTools,
  ): ToolSurfaceObservation {
    return {
      active: readRegisteredTools(this.toolRegistry.getActive()).names,
      registered: new Set(registered.names),
    };
  }
}

/**
 * Whether Pi built the prompt from a custom one, by Pi's own `if (customPrompt)`
 * test, so an empty string reads here the way it reads there: as none.
 */
function hasCustomPrompt(event: BeforeAgentStartPayload): boolean {
  return Boolean(event.systemPromptOptions?.customPrompt);
}
