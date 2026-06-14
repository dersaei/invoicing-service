/**
 * src/lib/directus.ts — Directus SDK client (catalog + file upload).
 *
 * Two responsibilities:
 *   1. Read a row from the `services` catalog by its `code`.
 *   2. Upload a generated PDF to Directus Files and return its UUID.
 *
 * The SDK uses a static admin token (from Doppler) and talks to the
 * internal Docker network URL `http://directus:8055`, not the public
 * one — internal traffic skips Caddy/proxy and is faster.
 *
 * Errors are translated into named classes so the webhook route can
 * map them to specific HTTP responses (e.g. 422 vs 502) without
 * sniffing error messages.
 */

import {
  createDirectus,
  readItems,
  rest,
  staticToken,
  uploadFiles,
} from "@directus/sdk";
import { config } from "../config.js";
import type { ServiceRecord } from "../types.js";

// ── Minimal schema typing for the SDK ──────────────────────
// We only declare the collections we actually read. Other Directus
// collections exist in the instance (form_submissions, etc.) but
// they're not this service's business — declaring them here would
// be tight coupling for no benefit.
interface DirectusSchema {
  services: ServiceRecord[];
}

const client = createDirectus<DirectusSchema>(config.directus.url)
  .with(staticToken(config.directus.token))
  .with(rest());

// ── Domain errors ──────────────────────────────────────────

/** No row in `services` matched the requested code. */
export class ServiceNotFoundError extends Error {
  constructor(public readonly code: string) {
    super(`Service not found in Directus catalog: ${code}`);
    this.name = "ServiceNotFoundError";
  }
}

/** Row exists but `active = false`. Treat as if not orderable. */
export class ServiceInactiveError extends Error {
  constructor(public readonly code: string) {
    super(`Service exists in catalog but is inactive: ${code}`);
    this.name = "ServiceInactiveError";
  }
}

// ── Public API ─────────────────────────────────────────────

/**
 * Fetch a service definition from the Directus catalog.
 *
 * Throws ServiceNotFoundError if no row matches; ServiceInactiveError
 * if the row exists but is marked inactive. Both let the webhook
 * decide whether to abort with 422 vs surface a clearer log line.
 *
 * Network/Directus errors (token expired, 500 from Directus, etc.)
 * are NOT caught — they propagate as the SDK's native errors so the
 * caller can decide whether to retry or fail hard.
 */
export async function fetchService(code: string): Promise<ServiceRecord> {
  const rows = await client.request(
    readItems("services", {
      filter: { code: { _eq: code } },
      limit: 1,
    }),
  );

  if (rows.length === 0) {
    throw new ServiceNotFoundError(code);
  }

  const svc = rows[0]!;
  if (!svc.active) {
    throw new ServiceInactiveError(code);
  }

  return svc;
}

export interface UploadedFile {
  /** Directus Files UUID — what we store in invoices.pdf_file_id. */
  id: string;
  /** Filename as Directus saved it (usually echo of input). */
  filename: string;
  /** Size in bytes, if reported. */
  size: number | null;
}

/**
 * Upload a PDF buffer to Directus Files. Returns the resulting file's
 * UUID, which we persist on the invoice row.
 *
 * Uses the global FormData + Blob from Node ≥18; no node-fetch or
 * form-data package needed.
 */
export async function uploadInvoicePdf(
  buffer: Uint8Array,
  filename: string,
): Promise<UploadedFile> {
  const form = new FormData();
  // The `as BlobPart` cast silences a strict-mode TS complaint that
  // Uint8Array<ArrayBufferLike> *might* wrap a SharedArrayBuffer,
  // which Blob doesn't accept. In practice our PDF buffer is always
  // a plain ArrayBuffer-backed Uint8Array (from Playwright).
  form.append(
    "file",
    new Blob([buffer as BlobPart], { type: "application/pdf" }),
    filename,
  );

  // SDK returns the created file record. Field names follow the
  // Directus Files schema; `filesize` may be a number or a string
  // depending on driver/version — normalise to number|null.
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
