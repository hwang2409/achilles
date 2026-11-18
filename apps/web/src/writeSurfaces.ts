export const READ_ONLY_REASON = "this tab is read-only; take control to make changes";

export const WRITE_SURFACE = {
  emptySend: "empty.send",
  emptyCreate: "empty.create",
  emptyContinue: "empty.continue",
  busyRetry: "busy.retry",
  createRetry: "create.retry",
  createDiscard: "create.discard",
  missingNewChat: "missing.new-chat",
  approvalApprove: "approval.approve",
  approvalDeny: "approval.deny",
  composerSend: "composer.send",
  composerSteer: "composer.steer",
  composerAbort: "composer.abort",
  deliveryRetry: "delivery.retry",
  headerCreate: "header.create",
  headerRename: "header.rename",
  sidebarRename: "sidebar.rename",
  shellNewChat: "shell.new-chat",
  keyboardCommands: "keyboard.commands",
  paletteCommands: "palette.commands",
  pageChat: "page.chat",
  historyRestore: "history.restore",
  recordInsert: "record.insert",
  recordUpdate: "record.update",
  recordAdd: "record.add",
  settingsTheme: "settings.theme",
  settingsUiFont: "settings.ui-font",
  settingsCodeFont: "settings.code-font",
  settingsSize: "settings.size",
  settingsDensity: "settings.density",
  settingsVim: "settings.vim",
  settingsAutoApprove: "settings.auto-approve",
  settingsReset: "settings.reset",
  passiveLastState: "passive.last-state",
  passiveFirstMessage: "passive.first-message",
  passiveTitle: "passive.title",
  passiveAttachment: "passive.attachment",
  passiveRepair: "passive.repair",
} as const;

export type WriteSurfaceId = (typeof WRITE_SURFACE)[keyof typeof WRITE_SURFACE];
export type WriteSurfaceMetadata = { readonly id: WriteSurfaceId; readonly channel: "websocket" | "http" | "storage" | "persistence"; readonly visibility: "visible" | "command" | "passive" };

export const WRITE_SURFACES: readonly WriteSurfaceMetadata[] = [
  ["emptySend", "websocket", "visible"], ["emptyCreate", "websocket", "visible"], ["emptyContinue", "websocket", "visible"],
  ["busyRetry", "websocket", "visible"], ["createRetry", "websocket", "visible"], ["createDiscard", "websocket", "visible"], ["missingNewChat", "websocket", "visible"],
  ["approvalApprove", "websocket", "visible"], ["approvalDeny", "websocket", "visible"], ["composerSend", "websocket", "visible"], ["composerSteer", "websocket", "visible"], ["composerAbort", "websocket", "visible"], ["deliveryRetry", "websocket", "visible"],
  ["headerCreate", "http", "visible"], ["headerRename", "http", "visible"], ["sidebarRename", "http", "visible"], ["shellNewChat", "http", "visible"], ["keyboardCommands", "http", "command"], ["paletteCommands", "http", "command"], ["pageChat", "websocket", "visible"], ["historyRestore", "http", "visible"], ["recordInsert", "http", "visible"], ["recordUpdate", "http", "visible"], ["recordAdd", "http", "visible"],
  ["settingsTheme", "storage", "visible"], ["settingsUiFont", "storage", "visible"], ["settingsCodeFont", "storage", "visible"], ["settingsSize", "storage", "visible"], ["settingsDensity", "storage", "visible"], ["settingsVim", "storage", "visible"], ["settingsAutoApprove", "storage", "visible"], ["settingsReset", "storage", "visible"],
  ["passiveLastState", "persistence", "passive"], ["passiveFirstMessage", "persistence", "passive"], ["passiveTitle", "persistence", "passive"], ["passiveAttachment", "persistence", "passive"], ["passiveRepair", "persistence", "passive"],
].map(([key, channel, visibility]) => ({ id: WRITE_SURFACE[key as keyof typeof WRITE_SURFACE], channel: channel as WriteSurfaceMetadata["channel"], visibility: visibility as WriteSurfaceMetadata["visibility"] }));

export const writeSurfaceIds: readonly WriteSurfaceId[] = WRITE_SURFACES.map(({ id }) => id);
