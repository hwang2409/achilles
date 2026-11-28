import type { ClipboardEvent, DragEvent } from "react";
import { pastedFiles, type ComposerImage } from "./images";

/** The images the next message carries: a thumbnail each, with a remove button. */
export function ImageChips({ images, onRemove }: { images: ComposerImage[]; onRemove: (index: number) => void }) {
  if (!images.length) return null;
  return (
    <ul data-part="composer-images" aria-label="images to send">
      {images.map((image, index) => (
        <li key={`${index}:${image.name}`} data-part="composer-image">
          <img src={`data:${image.mime_type};base64,${image.data}`} alt={image.name} title={image.name} />
          <button type="button" data-part="composer-image-remove" aria-label={`remove image ${image.name}`} onClick={() => onRemove(index)}>×</button>
        </li>
      ))}
    </ul>
  );
}

/** The form handlers that take pasted and dropped image files; text pastes and drops stay with the field. */
export const imageInputProps = (add: (files: File[]) => void) => ({
  onPaste(event: ClipboardEvent) {
    const files = pastedFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    add(files);
  },
  onDragOver(event: DragEvent) {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  },
  onDrop(event: DragEvent) {
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    event.preventDefault();
    add(files);
  },
});
