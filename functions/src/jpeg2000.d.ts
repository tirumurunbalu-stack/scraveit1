declare module "jpeg2000" {
  /** pdf.js JPEG 2000 decoder (pure JavaScript). */
  export class JpxImage {
    width: number;
    height: number;
    componentsCount: number;
    tiles: Array<{items: Uint8ClampedArray | Uint8Array; left: number; top: number; width: number; height: number}>;
    parse(data: Buffer | Uint8Array): void;
  }
}
