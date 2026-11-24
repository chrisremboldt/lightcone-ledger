import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
export const pdfAssetsUrl = '/pdfjs-assets/6.4.299/';

export function loadPdf(bytes: Uint8Array) {
  return getDocument({
    data: bytes.slice(),
    cMapUrl: `${pdfAssetsUrl}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfAssetsUrl}standard_fonts/`,
    wasmUrl: `${pdfAssetsUrl}wasm/`,
    iccUrl: `${pdfAssetsUrl}iccs/`,
    enableXfa: false,
    verbosity: 0,
  });
}
