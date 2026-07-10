import {
  createDirectus,
  readItems,
  rest,
  staticToken,
  updateItem,
} from "@directus/sdk";
import { config } from "../config.js";
import type { ServiceRecord } from "../types.js";

// Minimal shape of the Directus `form_submissions` collection — only the
// fields the invoicing-service writes back. Directus owns the full schema.
interface FormSubmissionRecord {
  id: string;
  status: string;
  issued_invoice_number: string | null;
  issued_invoice_id: string | null;
  last_error: string | null;
}

interface DirectusSchema {
  services: ServiceRecord[];
  form_submissions: FormSubmissionRecord[];
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

/**
 * Mark a Directus `form_submissions` row as issued, via the REST API.
 *
 * This MUST go through the Directus API (not a raw DB write, and not a
 * flow's internal `item-update` operation): only an API-level
 * `items.update` emits the event that fires the "Grant premium trial on
 * invoice issued" flow. A direct DB write or an in-flow item-update is
 * invisible to event-triggered flows.
 *
 * `submissionId` is the payload's `submission_id`, which the issuing flow
 * sets to the form_submissions record id ($trigger.key).
 */
export async function markSubmissionIssued(
  submissionId: string,
  fields: {
    invoiceNumber: string;
    invoiceId: string;
    warning: string | null;
  },
): Promise<void> {
  await client.request(
    updateItem("form_submissions", submissionId, {
      status: "issued",
      issued_invoice_number: fields.invoiceNumber,
      issued_invoice_id: fields.invoiceId,
      last_error: fields.warning,
    }),
  );
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

/**
 * Download a previously-uploaded invoice PDF from Directus Files by id.
 * Used by the resend route to re-attach the exact same document that was
 * originally issued (rather than regenerating it).
 *
 * Directus serves raw file bytes at `/assets/{id}`; we authenticate with
 * the static token. Returns the PDF as bytes.
 */
export async function downloadInvoicePdf(fileId: string): Promise<Uint8Array> {
  const base = config.directus.url.replace(/\/+$/, "");
  const res = await fetch(`${base}/assets/${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${config.directus.token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Directus file download failed for ${fileId}: HTTP ${res.status} — ${text.slice(0, 300)}`,
    );
  }

  return new Uint8Array(await res.arrayBuffer());
}

function normaliseSize(v: number | string | null | undefined): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
