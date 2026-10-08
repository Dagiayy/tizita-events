declare module 'heic-convert' {
  const convert: (opts: { buffer: Buffer | ArrayBuffer; format: 'JPEG' | 'PNG'; quality?: number }) => Promise<ArrayBuffer>;
  export default convert;
}
declare module 'exif-reader' {
  const exifReader: (buf: Buffer) => any;
  export default exifReader;
}
