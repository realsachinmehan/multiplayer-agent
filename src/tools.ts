import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

export type ToolContext = {
  sessionId: string;
  workspace: string;
  // The human whose instruction led to this call. Later steps use it to pick
  // whose credentials a side effect goes out under.
  onBehalfOf: string | null;
};

export type Tool = {
  definition: Anthropic.Beta.BetaTool;
  // Safe to run again if a worker crashed after starting it. A tool that is
  // not idempotent is never re-run; the model is told the outcome is unknown.
  idempotent: boolean;
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
