import {
  createDirectus,
  readItems,
  rest,
  staticToken,
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
  form.append(
    "file",
    new Blob([buffer], { type: "application/pdf" }),
    filename,
  );

  // Omijamy @directus/sdk dla uploadu: surowy fetch daje pełną kontrolę
  // nad multipart-payload i czytelne błędy. SDK potrafi zwrócić `null`
  // przy nieoczekiwanym shape odpowiedzi, co maskuje prawdziwą przyczynę.
  const base = config.directus.url.replace(/\/+$/, "");
  const res = await fetch(`${base}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.directus.token}` },
    body: form,
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `Directus file upload failed: HTTP ${res.status} — ${text.slice(0, 500)}`,
    );
  }

  let parsed: {
    data?: {
      id?: string;
      filename_download?: string;
      filesize?: number | string | null;
    };
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Directus file upload returned non-JSON: ${text.slice(0, 200)}`,
    );
  }

  const data = parsed?.data;
  if (!data?.id) {
    throw new Error(
      `Directus file upload returned unexpected shape: ${text.slice(0, 200)}`,
    );
  }

  return {
    id: data.id,
    filename: data.filename_download ?? filename,
    size: normaliseSize(data.filesize),
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
