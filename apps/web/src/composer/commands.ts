/** A composer draft parsed for a local slash command that must never reach the model. */
export type ParsedComposerInput =
  | { kind: "send"; text: string }
  | { kind: "command"; name: string; arg: string };

// a single leading "/word" is a command; "//" escapes to a literal message with one slash dropped; a slash
// anywhere else (or a "/ " with no word) is plain text.
const COMMAND = /^\/([a-zA-Z][\w-]*)[ \t]*([\s\S]*)$/;

export function parseComposerInput(draft: string): ParsedComposerInput {
  if (draft.startsWith("//")) return { kind: "send", text: draft.slice(1) };
  const match = COMMAND.exec(draft);
  if (!match) return { kind: "send", text: draft };
  return { kind: "command", name: match[1].toLowerCase(), arg: match[2].trim() };
}

/** The commands the composer handles locally, by name. */
export const COMPOSER_COMMANDS = ["accounts"] as const;
export type ComposerCommand = (typeof COMPOSER_COMMANDS)[number];
export const isComposerCommand = (name: string): name is ComposerCommand =>
  (COMPOSER_COMMANDS as readonly string[]).includes(name);
