/**
 * The tool-surface region of a system prompt: which tools this session may
 * call, and the guidance those tools contribute.
 *
 * Pi writes that region near the top of its preamble, a few hundred characters
 * in. `@gotgenes/pi-subagents` copies everything ahead of the skills catalogue
 * into a child's prompt verbatim, so the child's leading bytes match its
 * parent's for prefix-reusing inference engines — which means editing the
 * region in place ends that shared prefix for every child whose allowed set
 * differs from its parent's (#890).
 *
 * So the region is *relocated* rather than narrowed: the sections Pi wrote are
 * removed, and this node's own are rendered at the end of the prompt, past
 * everything a child inherits. Each session then states its own tool surface
 * and no session edits another's bytes.
 *
 * Removal is bounded to the text this package or Pi wrote. The prompt is split
 * at the cwd layer Pi writes last and unconditionally: a
 * `Current working directory:` footer through Pi 0.85, a `<cwd>` section from
 * 0.86. Everything after it was appended by an extension, and everything
 * before it is Pi's own only when Pi did not build the prompt from a
 * `customPrompt`. Under a custom prompt Pi writes no tool surface at all, so a
 * section matched above the cwd layer is a user's or another extension's, and
 * removing it destroyed their text (#919, #932). On the 0.86 shape even a
 * Pi-authored head is searched only for Pi's own `<tools>` and `<rules>`,
 * bounded to where Pi writes them, since the plain headers it no longer
 * writes would match only a context file's text.
 *
 * Rendering follows `buildSystemPrompt`'s own rules (a tool is listed only
 * when it has a snippet; the guideline bullets are the allowed tools' own
 * `promptGuidelines`, then other extensions' rules, around Pi's built-in
 * ones) and its shape (plain headers or tagged sections, matching the
 * prompt), so the block reads as the one Pi would have written for this
 * session's real surface.
 */

/** What a session's tool surface renders from. */
export interface ToolSurfaceInputs {
  /** Tools this session may call, in the order they should be listed. */
  readonly allowedTools: readonly string[];
  /** Pi's one-line tool descriptions, keyed by tool name. */
  readonly toolSnippets: Readonly<Record<string, string>>;
  /** Guideline bullets each tool contributes, keyed by tool name. */
  readonly guidelinesByTool: ReadonlyMap<string, readonly string[]>;
  /**
   * `systemPromptOptions.promptGuidelines`: bullets Pi writes into its rules
   * after the tools' own.
   *
   * Only a bullet no registered tool contributes is carried. From Pi 0.86 the
   * field holds what other extensions added; through 0.85 it *is* the tools'
   * guidelines, flattened, and a denied tool's bullet must not return by this
   * route.
   */
  readonly promptGuidelines: readonly string[];
  /**
   * Whether Pi wrote the prompt's preamble itself.
   *
   * False when Pi assembled the prompt from `customPrompt` — a user's
   * SYSTEM.md, or a subagent child's assembled prompt — in which case Pi wrote
   * no tool-surface sections and every line above its footer belongs to
   * somebody else.
   */
  readonly piAuthoredPreamble: boolean;
}

type LineSection = {
  start: number;
  end: number;
};

const AVAILABLE_TOOLS_SECTION_HEADER = "Available tools:";
const GUIDELINES_SECTION_HEADER = "Guidelines:";

/**
 * Pi's filler sentence between the tool list and the guidelines.
 *
 * It refers to "the tools above", so it belongs with the list rather than with
 * the text the list is being moved out of.
 */
const CUSTOM_TOOLS_FILLER_PREFIX = "In addition to the tools above";

/** What Pi writes under `Available tools:` when no selected tool has a snippet. */
const EMPTY_LIST_PLACEHOLDER = "(none)";

/**
 * The first line of the footer Pi writes last, in both of its branches.
 *
 * It is the boundary between what Pi assembled and what extensions appended
 * after it — the same anchor `@gotgenes/pi-subagents` uses to find Pi's
 * session-resolved tail.
 */
const PROMPT_FOOTER_PREFIX = "Current working directory: ";

/**
 * The tags of the section Pi renders the working directory into from 0.86,
 * last among its own sections and in both of its branches.
 */
const CWD_SECTION_OPEN = "<cwd>";
const CWD_SECTION_CLOSE = "</cwd>";

/** The sections Pi 0.86+ writes its tool surface into, in the order it writes them. */
const TOOL_SURFACE_SECTION_NAMES = ["tools", "rules"] as const;

/**
 * Opening tags of the sections Pi writes after its tool surface.
 *
 * Pi writes `<tools>` and `<rules>` directly under its preamble and ahead of
 * every one of these, so a match that opens or closes past the first of them
 * is text somebody quoted, not Pi's.
 */
const LATER_PI_SECTION_OPENS: ReadonlySet<string> = new Set([
  "<docs>",
  "<addendum>",
  "<project_context>",
  "<skills>",
  CWD_SECTION_OPEN,
]);

/** Pi's two unconditional guideline bullets, in the order it writes them. */
const UNIVERSAL_GUIDELINES: readonly string[] = [
  "Be concise in your responses",
  "Show file paths clearly when working with files",
];

/**
 * Relocate the tool surface: drop the sections Pi wrote, append this session's.
 *
 * The result always carries a tool-surface block, so a child whose inherited
 * identity has none — its parent's node having already relocated it — still
 * describes its own tools.
 */
export function renderToolSurface(
  systemPrompt: string,
  inputs: ToolSurfaceInputs,
): string {
  const lines = normalizePrompt(systemPrompt).split("\n");
  const { layout, tailStart } = detectPromptLayout(lines);
  const body = [
    settleRegion(
      lines.slice(0, tailStart),
      inputs.piAuthoredPreamble ? layout.removePiSurface : null,
    ),
    settleRegion(lines.slice(tailStart), layout.removeRelocatedSurface),
  ]
    .filter((region) => region.length > 0)
    .join("\n")
    .trimEnd();
  const block = layout.renderBlock(toolSurfaceBullets(inputs));

  return body.length > 0 ? `${body}\n\n${block}` : block;
}

export function hasWithheldToolSurface(
  systemPrompt: string,
  withheldTools: ReadonlySet<string>,
  withheldRules: ReadonlySet<string>,
  piAuthoredPreamble: boolean,
): boolean {
  const lines = normalizePrompt(systemPrompt).split("\n");
  const { layout, tailStart } = detectPromptLayout(lines);
  const head = lines.slice(0, tailStart);
  const remaining = [
    ...(piAuthoredPreamble ? layout.removePiSurface(head) : head),
    ...layout.removeRelocatedSurface(lines.slice(tailStart)),
  ];
  const removedCounts = new Map<string, number>();
  for (const line of lines)
    removedCounts.set(line, (removedCounts.get(line) ?? 0) + 1);
  for (const line of remaining)
    removedCounts.set(line, (removedCounts.get(line) ?? 0) - 1);
  return [...removedCounts].some(
    ([line, count]) =>
      count > 0 &&
      (withheldRules.has(line) ||
        withheldTools.has(/^- ([^:]+): /.exec(line)?.[1] ?? "")),
  );
}

/** Lines removed from one region of the prompt; the rest are returned in order. */
type RegionRemoval = (lines: readonly string[]) => string[];

/**
 * How one prompt shape bounds and writes the tool surface.
 *
 * Pi has written its prompt in more than one shape, and each shape answers the
 * same three questions differently, so the shape is decided once per prompt
 * and every answer is read off the layout it selected.
 */
interface PromptLayout {
  /** Pi's own tool surface, removed from the head when Pi wrote the preamble. */
  readonly removePiSurface: RegionRemoval;
  /** A relocated block (this package's or a peer's), removed from the tail. */
  readonly removeRelocatedSurface: RegionRemoval;
  /** This session's block, in this layout's shape. */
  readonly renderBlock: (bullets: ToolSurfaceBullets) => string;
}

/** A prompt's layout, and the line at which the text extensions appended begins. */
interface DetectedLayout {
  readonly layout: PromptLayout;
  readonly tailStart: number;
}

/**
 * The shape Pi wrote through 0.85: `Available tools:` and `Guidelines:`
 * sections in its preamble, and a `Current working directory:` footer last.
 */
const HEADER_LAYOUT: PromptLayout = {
  removePiSurface: removeToolSurfaceSections,
  removeRelocatedSurface: removeToolSurfaceSections,
  renderBlock: renderHeaderBlock,
};

/**
 * The shape Pi writes from 0.86: an untagged preamble, then `<name>` sections
 * joined by a blank line (`<tools>` and `<rules>` among them), and a `<cwd>`
 * section last among its own.
 */
const SECTION_LAYOUT: PromptLayout = {
  removePiSurface: removePiToolSurfaceSections,
  removeRelocatedSurface: removeRelocatedToolSurface,
  renderBlock: renderSectionBlock,
};

/**
 * The prompt's layout, read off the cwd layer Pi wrote, and where the text
 * extensions appended after that layer begins.
 *
 * Pi writes its cwd layer last among its own, in both of its branches: a
 * `Current working directory:` footer through 0.85, a `<cwd>` section from
 * 0.86. So whichever of the two sits later is Pi's, and a line of either shape
 * quoted in a context file or a custom prompt is always above it. The shape is
 * told apart by which layer is present, never by version sniffing.
 *
 * A prompt carrying neither is read as the header layout and treated as all
 * head, so a block appended to *that* prompt cannot be found and replaced, and
 * a custom preamble would collect a second one. Pi writes a cwd layer in both
 * branches of both renderers, so reaching this needs a downstream rewrite of
 * Pi's whole output.
 */
function detectPromptLayout(lines: readonly string[]): DetectedLayout {
  const footerAt = lines.findLastIndex((line) =>
    line.startsWith(PROMPT_FOOTER_PREFIX),
  );
  const cwdCloseAt = lastCwdSectionClose(lines);
  if (cwdCloseAt > footerAt) {
    return { layout: SECTION_LAYOUT, tailStart: cwdCloseAt + 1 };
  }
  return {
    layout: HEADER_LAYOUT,
    tailStart: footerAt === -1 ? lines.length : footerAt + 1,
  };
}

/**
 * Line index of the closing tag of the last `<cwd>` section, or -1 when there
 * is none.
 *
 * Pi renders the section as exactly three lines (the opening tag, the
 * directory, the closing tag), so that is the shape matched, the way the
 * footer is matched by its prefix.
 */
function lastCwdSectionClose(lines: readonly string[]): number {
  return lines.findLastIndex(
    (line, index) =>
      line === CWD_SECTION_CLOSE && lines[index - 2] === CWD_SECTION_OPEN,
  );
}

/**
 * One region's surviving text: its sections removed, when they are ours to
 * remove, or returned as it arrived when `removal` is `null`.
 *
 * Blank runs are collapsed only where a removal opened one, so a region this
 * pass took nothing out of is returned exactly as it arrived rather than
 * reflowed by a pass that had nothing to do with it.
 */
function settleRegion(
  lines: readonly string[],
  removal: RegionRemoval | null,
): string {
  if (!removal) {
    return lines.join("\n");
  }
  const kept = removal(lines);
  const text = kept.join("\n");
  return kept.length === lines.length ? text : collapseExtraBlankLines(text);
}

/**
 * Remove the `Available tools:` and `Guidelines:` sections, and the filler
 * sentence between them, from one region.
 *
 * Each section is located by its own header, so the two are removed whether
 * they sit adjacent in Pi's preamble or alone in the tail — including a block
 * this function already produced, which is what makes it safe to apply to its
 * own output, and what keeps it order-independent with a second writer.
 */
function removeToolSurfaceSections(lines: readonly string[]): string[] {
  let remaining = [...lines];
  for (const header of [
    AVAILABLE_TOOLS_SECTION_HEADER,
    GUIDELINES_SECTION_HEADER,
  ]) {
    const section = findSection(remaining, header);
    if (section) {
      remaining = [
        ...remaining.slice(0, section.start),
        ...remaining.slice(section.end),
      ];
    }
  }

  return remaining.filter(
    (line) => !line.trimStart().startsWith(CUSTOM_TOOLS_FILLER_PREFIX),
  );
}

/**
 * Remove Pi 0.86+'s own `<tools>` and `<rules>` sections, tags included.
 *
 * A section is Pi's only when it opens and closes before the first section Pi
 * writes after it; the plain headers `removeToolSurfaceSections` matches are
 * never searched here, because Pi writes none on this shape and every match
 * would be a user's or another extension's text.
 */
function removePiToolSurfaceSections(head: readonly string[]): string[] {
  return removeTaggedToolSurface(head, laterPiSectionStart);
}

/**
 * Remove a relocated block from the extension tail, in either shape.
 *
 * This package writes the tagged shape here, and a peer writer may write
 * either, so both are removed: the pass stays safe to apply to its own output
 * and order-independent with a second writer.
 */
function removeRelocatedToolSurface(tail: readonly string[]): string[] {
  return removeToolSurfaceSections(
    removeTaggedToolSurface(tail, (lines) => lines.length),
  );
}

/**
 * Remove the first `<tools>` and the first `<rules>` section, each only when
 * it closes before the line `limitOf` names.
 */
function removeTaggedToolSurface(
  lines: readonly string[],
  limitOf: (lines: readonly string[]) => number,
): string[] {
  let remaining = [...lines];
  for (const name of TOOL_SURFACE_SECTION_NAMES) {
    const section = findTaggedSection(remaining, name, limitOf(remaining));
    if (section) {
      remaining = [
        ...remaining.slice(0, section.start),
        ...remaining.slice(section.end),
      ];
    }
  }
  return remaining;
}

/** Line index of the first section Pi writes after its tool surface. */
function laterPiSectionStart(lines: readonly string[]): number {
  const at = lines.findIndex((line) => LATER_PI_SECTION_OPENS.has(line));
  return at === -1 ? lines.length : at;
}

/**
 * The first `<name>` section, opening tag through closing tag, that ends
 * before `limit`; `null` when there is none.
 */
function findTaggedSection(
  lines: readonly string[],
  name: string,
  limit: number,
): LineSection | null {
  const start = lines.indexOf(`<${name}>`);
  if (start === -1 || start >= limit) {
    return null;
  }
  const closeAt = lines.indexOf(`</${name}>`, start + 1);
  if (closeAt === -1 || closeAt >= limit) {
    return null;
  }
  return { start, end: closeAt + 1 };
}

/**
 * This session's tool surface, as Pi 0.86+ would have rendered it: a `<tools>`
 * section, when any allowed tool has a snippet, then a `<rules>` section.
 */
function renderSectionBlock(bullets: ToolSurfaceBullets): string {
  const sections: string[] = [];
  if (bullets.tools.length > 0) {
    sections.push(taggedSection("tools", bullets.tools));
  }
  sections.push(taggedSection("rules", bullets.rules));

  return sections.join("\n\n");
}

/** A section in the form Pi 0.86+ renders: its tags on their own lines. */
function taggedSection(name: string, lines: readonly string[]): string {
  return [`<${name}>`, ...lines, `</${name}>`].join("\n");
}

/** This session's tool surface, as Pi through 0.85 would have rendered it. */
function renderHeaderBlock(bullets: ToolSurfaceBullets): string {
  const sections: string[] = [];

  const toolList = renderAvailableTools(bullets.tools);
  if (toolList) {
    sections.push(toolList);
  }
  sections.push(renderGuidelines(bullets.rules));

  return sections.join("\n\n");
}

/** The `Available tools:` section, or `null` when it lists no tool. */
function renderAvailableTools(bullets: readonly string[]): string | null {
  return bullets.length > 0
    ? [AVAILABLE_TOOLS_SECTION_HEADER, ...bullets].join("\n")
    : null;
}

/** The `Guidelines:` section. */
function renderGuidelines(bullets: readonly string[]): string {
  return [GUIDELINES_SECTION_HEADER, ...bullets].join("\n");
}

/** The bullets a tool-surface block wraps, whatever shape wraps them. */
interface ToolSurfaceBullets {
  /** `- name: snippet` lines; empty when no allowed tool has a snippet. */
  readonly tools: readonly string[];
  /** `- rule` lines, in `buildSystemPrompt`'s order. */
  readonly rules: readonly string[];
}

export function toolSurfaceBullets(
  inputs: ToolSurfaceInputs,
): ToolSurfaceBullets {
  return { tools: toolBullets(inputs), rules: ruleBullets(inputs) };
}

/**
 * One bullet per allowed tool that has a snippet.
 *
 * Pi lists a tool only when the caller supplied a one-line snippet for it, so
 * a tool without one is left unlisted here too rather than rendered bare.
 */
function toolBullets(inputs: ToolSurfaceInputs): string[] {
  return inputs.allowedTools
    .map((toolName) => ({ toolName, snippet: inputs.toolSnippets[toolName] }))
    .filter((tool) => Boolean(tool.snippet))
    .map((tool) => `- ${tool.toolName}: ${tool.snippet}`);
}

/**
 * The guideline bullets for the allowed set.
 *
 * Mirrors `buildSystemPrompt`'s assembly: its conditional file-exploration
 * bullet first, then each allowed tool's own contributions, then the bullets
 * other extensions added, then its two unconditional bullets — de-duplicated in first-seen order, as Pi does.
 */
function ruleBullets(inputs: ToolSurfaceInputs): string[] {
  const bullets: string[] = [];
  const seen = new Set<string>();
  const addGuideline = (guideline: string): void => {
    const normalized = guideline.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    bullets.push(normalized);
  };

  const fileOperations = fileExplorationGuideline(new Set(inputs.allowedTools));
  if (fileOperations) {
    addGuideline(fileOperations);
  }

  for (const toolName of inputs.allowedTools) {
    for (const guideline of inputs.guidelinesByTool.get(toolName) ?? []) {
      addGuideline(guideline);
    }
  }

  for (const guideline of extensionGuidelines(inputs)) {
    addGuideline(guideline);
  }

  for (const guideline of UNIVERSAL_GUIDELINES) {
    addGuideline(guideline);
  }

  return bullets.map((bullet) => `- ${bullet}`);
}

/** The `promptGuidelines` bullets no registered tool contributes. */
function extensionGuidelines(inputs: ToolSurfaceInputs): string[] {
  const toolGuidelines = new Set(
    [...inputs.guidelinesByTool.values()]
      .flat()
      .map((guideline) => guideline.trim()),
  );
  return inputs.promptGuidelines.filter(
    (guideline) => !toolGuidelines.has(guideline.trim()),
  );
}

/**
 * Pi's shell-only file-exploration bullet, or `null` when it does not apply.
 *
 * Pi writes it only when a shell is available and none of the dedicated
 * exploration tools is, so a session holding `grep`/`find`/`ls` is not told to
 * reach for the shell instead.
 */
function fileExplorationGuideline(
  allowedTools: ReadonlySet<string>,
): string | null {
  const hasBash = allowedTools.has("bash");
  const hasPowerShell = allowedTools.has("powershell");
  const hasExplorationTool =
    allowedTools.has("grep") ||
    allowedTools.has("find") ||
    allowedTools.has("ls");

  if ((!hasBash && !hasPowerShell) || hasExplorationTool) {
    return null;
  }
  if (hasBash && hasPowerShell) {
    return "Use bash or PowerShell for file operations like listing, searching, and finding files";
  }
  if (hasPowerShell) {
    return "Use PowerShell for file operations like listing, searching, and finding files";
  }
  return "Use bash for file operations like ls, rg, find";
}

function normalizePrompt(prompt: string): string {
  return (prompt || "").replace(/\r\n/g, "\n");
}

function collapseExtraBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Whether the line belongs to the body of the section above it.
 *
 * Pi writes a section as its header, then bullets — or the `(none)` placeholder
 * when the list is empty — and separates it from what follows with a blank
 * line. Anything else is already outside the section, however it is punctuated:
 * a section that ran on to "the next line ending in a colon" swallowed the
 * prose in between, which is somebody else's text whenever the match was not
 * Pi's own (#919, #932).
 */
function isSectionBodyLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true; // blank line
  if (trimmed.startsWith("- ")) return true; // bullet
  if (trimmed === EMPTY_LIST_PLACEHOLDER) return true; // Pi's empty list
  if (line !== line.trimStart()) return true; // indented
  return false;
}

/** The header line plus its own body, or `null` when the header is absent. */
function findSection(
  lines: readonly string[],
  header: string,
): LineSection | null {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    return null;
  }

  let end = start + 1;
  while (end < lines.length && isSectionBodyLine(lines[end])) {
    end += 1;
  }

  return { start, end };
}
