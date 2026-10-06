import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Credentials } from "./credentials.js";
import type { GitHubApi } from "./github.js";
import type { ApprovalPolicy } from "./roles.js";

export type ToolContext = {
  sessionId: string;
  workspace: string;
  // The human whose instruction led to this call. Side effects go out under
  // this person's credentials and nobody else's.
  onBehalfOf: string | null;
  // Who signed off, when the call needed approval.
  approvedBy: string | null;
  repo: { url: string | null; defaultBranch: string };
  credentials(user: string): Promise<Credentials | null>;
  github: GitHubApi;
};

export type Tool = {
  definition: Anthropic.Beta.BetaTool;
  // Safe to run again if a worker crashed after starting it. A tool that is
  // not idempotent is never re-run; the model is told the outcome is unknown.
  idempotent: boolean;
  // Returns a policy when this particular call needs someone's sign-off.
  approval?(input: any, ctx: { defaultBranch: string }): ApprovalPolicy | null;
  run(input: any, ctx: ToolContext): Promise<string>;
};

export type ToolRegistry = Map<string, Tool>;

export class ToolError extends Error {}

/** Resolves a model-supplied path and refuses anything outside the workspace. */
export function confine(workspace: string, path: string): string {
  const root = resolve(workspace);
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new ToolError(`path escapes the workspace: ${path}`);
  }
  return full;
}

const TYPES: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
};

/**
 * Checks a call's arguments against the tool's schema before anything runs.
 * Claude enforces strict schemas itself; other providers can send a call
 * with arguments missing (one pushed to a branch named "undefined"), so the
 * loop can't rely on that. Returns what is wrong, for the model to fix.
 */
export function checkInput(definition: Anthropic.Beta.BetaTool, input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return `${definition.name} takes an object of arguments`;
  const args = input as Record<string, unknown>;
  const schema = definition.input_schema;
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined);
  if (missing.length) return `${definition.name} is missing required arguments: ${missing.join(", ")}`;
  for (const [k, v] of Object.entries(args)) {
    const type = props[k]?.type;
    if (!props[k]) {
      if (schema.additionalProperties === false) return `${definition.name} has no argument named ${k}`;
    } else if (type && TYPES[type] && !TYPES[type](v)) {
      return `${definition.name}: ${k} must be a ${type}`;
    }
  }
  return null;
}

const pathProp = { type: "string", description: "Path relative to the repository root." } as const;

export const fileTools: Tool[] = [
  {
    definition: {
      name: "list_files",
      description: "List files under a directory of the repository, recursively. Skips .git and node_modules.",
      input_schema: { type: "object", properties: { path: pathProp }, required: ["path"], additionalProperties: false },
      strict: true,
    },
    idempotent: true,
    async run({ path }, ctx) {
      const root = confine(ctx.workspace, path);
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile())
        .map((e) => relative(ctx.workspace, resolve(e.parentPath, e.name)))
        .filter((p) => !p.split(sep).some((part) => part === ".git" || part === "node_modules"))
        .sort();
      return files.join("\n") || "(empty)";
    },
  },
  {
    definition: {
      name: "read_file",
      description: "Read a text file from the repository.",
      input_schema: { type: "object", properties: { path: pathProp }, required: ["path"], additionalProperties: false },
      strict: true,
    },
    idempotent: true,
    async run({ path }, ctx) {
      return readFile(confine(ctx.workspace, path), "utf8");
    },
  },
  {
    definition: {
      name: "write_file",
      description: "Create or overwrite a text file in the repository with the given contents.",
      input_schema: {
        type: "object",
        properties: { path: pathProp, contents: { type: "string" } },
        required: ["path", "contents"],
        additionalProperties: false,
      },
      strict: true,
    },
    // Writing the same contents twice leaves the same file.
    idempotent: true,
    async run({ path, contents }, ctx) {
      const full = confine(ctx.workspace, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
      return `wrote ${contents.length} bytes to ${path}`;
    },
  },
];

export function registry(tools: Tool[]): ToolRegistry {
  return new Map(tools.map((t) => [t.definition.name, t]));
}
