import {
  createDirectus,
  readItems,
  rest,
  staticToken,
  uploadFiles,
} from "@directus/sdk";
import { config } from "../config.js";
import type { ServiceRecord } from "../types.js";

interface DirectusSchema {
  services: ServiceRecord[];
}

const client = createDirectus<DirectusSchema>(config.directus.url)
  .with(staticToken(config.directus.token))
  .with(rest());

export class ServiceNotFoundError extends Error {
  constructor(public readonly code: string) {
    super(`Service not found in Directus catalog: ${code}`);
    this.name = "ServiceNotFoundError";
  }
}
export class ServiceInactiveError extends Error {
  constructor(public readonly code: string) {
    super(`Service exists in catalog but is inactive: ${code}`);
    this.name = "ServiceInactiveError";
  }
}

export async function fetchService(code: string): Promise<ServiceRecord> {
  const rows = await client.request(
    readItems("services", { filter: { code: { _eq: code } }, limit: 1 }),
  );
  if (rows.length === 0) throw new ServiceNotFoundError(code);
  const svc = rows[0]!;
  if (!svc.active) throw new ServiceInactiveError(code);
  return svc;
}

export interface UploadedFile {
  id: string;
  filename: string;
  size: number | null;
}

export async function uploadInvoicePdf(
  buffer: Uint8Array,
  filename: string,
): Promise<UploadedFile> {
  const form = new FormData();
  // Buffer.from kopiuje do nowego buffera z gwarantowanym ArrayBuffer
  // storage (nie SharedArrayBuffer), co rozwiązuje strict-mode TS error
  // o BlobPart bez wymagania DOM lib w tsconfig.
  form.append(
    "file",
    new Blob([Buffer.from(buffer)], { type: "application/pdf" }),
    filename,
  );
  const result = (await client.request(uploadFiles(form))) as {
    id: string;
    filename_download?: string;
    filesize?: number | string | null;
  };
  return {
    id: result.id,
    filename: result.filename_download ?? filename,
    size: normaliseSize(result.filesize),
  };
}

function normaliseSize(v: number | string | null | undefined): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
