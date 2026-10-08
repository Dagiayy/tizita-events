/** Shrinks a chosen photo to a web-friendly JPEG (max 1600px wide) so phone photos stay under the API's 3 MB cover limit. */
export async function prepareCover(file: File): Promise<File> {
  if (file.size < 1_500_000 && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / bmp.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error('image_unreadable');
  return new File([blob], 'cover.jpg', { type: 'image/jpeg' });
}
