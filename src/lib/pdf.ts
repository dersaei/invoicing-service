/**
 * src/lib/pdf.ts — PDF generator (Playwright + Chromium).
 *
 * One Chromium instance per process, launched lazily on first use.
 * Each PDF gets its own short-lived `page`, closed immediately after
 * rendering — that's how Playwright is designed: cheap pages, expensive
 * browser. We pay the ~1s launch cost only once.
 *
 * Concurrency: multiple webhooks can call generateInvoicePdf() in
 * parallel; each gets its own page in the shared browser context.
 * Chromium handles parallel pages fine for our scale (a few/sec).
 *
 * Lifecycle:
 *   first call  → spawn Chromium → render → close page
 *   later calls → reuse browser → render → close page
 *   SIGTERM     → server.ts calls closePdfBrowser() → cleanup
 *
 * Docker note: this service will run on the official `mcr.microsoft.com
 * /playwright` image as the non-root `pwuser` (per project plan), so we
 * don't need --no-sandbox. The image bundles Chromium with all required
 * system libs — saves us from chasing missing fonts/SO files manually.
 */

import { chromium, type Browser } from "playwright";

/**
 * Singleton browser, lazy-initialised on first call. Stored as a Promise
 * so that two concurrent first-callers don't spawn two Chromium processes
 * — they await the same launch.
 */
let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (browserPromise === null) {
    browserPromise = chromium.launch();
  }
  return browserPromise;
}

/**
 * Render the given HTML to a PDF buffer.
 *
 * Margins are intentionally set to 0 here so that the HTML's `@page` CSS
 * rule controls page geometry — see invoice.html.ts. If we set margins
 * both in CSS and in pdf() options they'd stack and the layout would
 * shift mysteriously.
 *
 * `waitUntil: 'networkidle'` gives in-page assets (e.g. @font-face from
 * file:// URLs we'll add later) a chance to load before snapshotting.
 * For the current self-contained HTML it makes no measurable difference.
 */
export async function generateInvoicePdf(html: string): Promise<Uint8Array> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle" });
    // Fonts are inlined as base64 @font-face (no network request), so
    // `networkidle` doesn't account for them. Wait for the font engine to
    // finish parsing/applying them before snapshotting, otherwise the first
    // render can fall back to a system font for some glyphs.
    // `document` lives in the browser context, not Node — we don't pull in
    // the DOM lib for the whole project just for this one call, so reference
    // it through a locally-typed global instead.
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          document: { fonts: { ready: Promise<unknown> } };
        }
      ).document.fonts.ready,
    );
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  } finally {
    // Always close the page — leaking pages eventually exhausts Chromium.
    await page.close();
  }
}

/**
 * Shut down the singleton browser. Called from server.ts during graceful
 * shutdown so the Chromium process exits cleanly before the Node process
 * does. Idempotent — safe to call even if the browser was never started.
 *
 * After this returns, the next call to generateInvoicePdf() will spawn
 * a fresh Chromium. That's intentional: nothing here ever holds a stale
 * handle.
 */
export async function closePdfBrowser(): Promise<void> {
  if (browserPromise === null) return;
  const current = browserPromise;
  browserPromise = null;
  const browser = await current;
  await browser.close();
}
