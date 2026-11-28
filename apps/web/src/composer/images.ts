/** One image in the composer, in the shape zeta's `send_images` takes: `data` is base64 with no `data:` prefix. */
export type ComposerImage = { name: string; mime_type: string; data: string };

export const IMAGE_FEATURE = "send_images_delivery_id";
export const IMAGE_REQUEST = "send_images";

// zeta's limits (server/handlers/send_images.py): 1 to 4 images, 512 KiB of image bytes in total, these four types,
// and a file name whose extension matches the type. zeta checks them again; the page checks first so it never sends one.
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 512 * 1024;
const EXTENSIONS: Record<string, string[]> = { "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/gif": ["gif"], "image/webp": ["webp"] };

/** The decoded size of a base64 image. */
export const imageBytes = (image: ComposerImage) => Math.floor((image.data.length * 3) / 4) - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0);

const limitError = (images: readonly { mime_type: string; bytes: number }[]) => {
  if (images.some((image) => !EXTENSIONS[image.mime_type])) return "images must be png, jpeg, gif, or webp.";
  if (images.length > MAX_IMAGES) return `a message can carry at most ${MAX_IMAGES} images.`;
  if (images.reduce((total, image) => total + image.bytes, 0) > MAX_IMAGE_BYTES) return "images can be at most 512 KiB in total.";
};

/** Why these images cannot go out together, or undefined when zeta takes them. */
export const imageLimitError = (images: readonly ComposerImage[]): string | undefined => limitError(images.map((image) => ({ mime_type: image.mime_type, bytes: imageBytes(image) })));

// a clipboard image is named "image.png" or nothing: keep a real file name when zeta takes it, else name it by its type
function imageName(file: File, index: number) {
  const name = file.name;
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const valid = name.length <= 128 && !/[/\\\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name) && name !== "." && name !== "..";
  return valid && name.includes(".") && EXTENSIONS[file.type]!.includes(extension) ? name : `image-${index}.${EXTENSIONS[file.type]![0]}`;
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** The image files of a paste or a drop, read and checked against what the box holds: the images to add, or why none
 * are added (one bad file adds none, so the box never holds a set zeta would refuse). */
export async function readImages(files: readonly File[], held: readonly ComposerImage[]): Promise<{ images: ComposerImage[] } | { error: string }> {
  // checked before reading, so a large file is never read into memory
  const error = limitError([...held.map((image) => ({ mime_type: image.mime_type, bytes: imageBytes(image) })), ...files.map((file) => ({ mime_type: file.type, bytes: file.size }))]);
  if (error) return { error };
  const images = await Promise.all(files.map(async (file, index) => ({ name: imageName(file, held.length + index + 1), mime_type: file.type, data: base64(new Uint8Array(await file.arrayBuffer())) })));
  // the size a file reports may differ from the bytes read
  const read = imageLimitError([...held, ...images]);
  return read ? { error: read } : { images };
}

/** The files a paste attaches: none when it carries plain text (a copy from a spreadsheet or slides adds a picture of
 * the text, and the user meant the text). */
export const pastedFiles = (data: DataTransfer | null) => data?.getData("text/plain") ? [] : [...(data?.files ?? [])];
