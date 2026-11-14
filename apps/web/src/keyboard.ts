export function isEditableTarget(event: KeyboardEvent) {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable], [role="textbox"], .cm-editor'));
}
