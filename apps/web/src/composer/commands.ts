/** A composer draft parsed for a local slash command that must never reach the model. */
export type ParsedComposerInput =
  | { kind: "send"; text: string }
  | { kind: "command"; name: string; arg: string };

// a single leading "/word" is a command; "//" escapes to a literal message with one slash dropped; a slash
// anywhere else (or a leading path such as "/usr/bin") is plain text.
const COMMAND = /^\/([a-zA-Z][\w-]*)(?=\s|$)\s*([\s\S]*)$/;

export function parseComposerInput(draft: string): ParsedComposerInput {
  if (draft.startsWith("//")) return { kind: "send", text: draft.slice(1) };
  const match = COMMAND.exec(draft);
  if (!match) return { kind: "send", text: draft };
  return { kind: "command", name: match[1].toLowerCase(), arg: match[2].trim() };
}

/** The commands the composer handles locally, by name. */
export const COMPOSER_COMMANDS = ["accounts", "vim"] as const;
export type ComposerCommand = (typeof COMPOSER_COMMANDS)[number];
export const isComposerCommand = (name: string): name is ComposerCommand =>
  (COMPOSER_COMMANDS as readonly string[]).includes(name);

// zeta lists it, but on the web it would only create a file on the zeta host and print that host path
const HIDDEN = ["project-instructions"];
/** The session's slash commands that make sense in the browser, in the server's order. */
export const webSlashCommands = <T extends { name: string }>(commands: readonly T[]): T[] => commands.filter((command) => !HIDDEN.includes(command.name));

/**
 * The commands a "/prefix" draft (one word, no space yet) offers, in the server's order but with the exact name first,
 * so enter on "/project" runs /project, not /project-instructions; `null` when no menu shows.
 */
export function slashMatches<T extends { name: string }>(draft: string, commands: readonly T[] | null): T[] | null {
  const match = /^\/([\w-]*)$/.exec(draft);
  if (!match || !commands) return null;
  const prefix = match[1].toLowerCase();
  const rows = commands.filter((command) => command.name.toLowerCase().startsWith(prefix));
  const exact = rows.findIndex((command) => command.name.toLowerCase() === prefix);
  if (exact > 0) rows.unshift(...rows.splice(exact, 1));
  return rows.length ? rows : null;
}
