import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { authenticateBoard } from "@/lib/auth";
import { parsePayload } from "@/lib/validate";
import { ingestBatch } from "@/lib/ingest";
import { runInTransaction } from "@/lib/tx";

export const runtime = "nodejs"; // pg needs Node APIs (net, crypto), not the edge runtime
export const dynamic = "force-dynamic"; // never cache a POST handler's module-level state

const MAX_BODY_BYTES = 64 * 1024;

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status });

export async function POST(req: Request) {
  const boardId = req.headers.get("x-board-id")?.trim() ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  const key = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  // 1. Size check BEFORE reading the body. content-length can lie or be missing, so check the text too.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });

  let client;
  try {
    client = await getPool().connect();
  } catch (err) {
    console.error("ingest: database connect failed", err);
    return json(503, { error: "database_unavailable" });
  }

  try {
    // 2. Who is this? Same 401 for "no such board" and "wrong key", so nobody can probe for valid board ids.
    if (!(await authenticateBoard(client, boardId, key))) return json(401, { error: "unauthorized" });

    // 3. Read and validate. Never trust the device's payload: it is user input.
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid_json" });
    }
    const parsed = parsePayload(body);
    if (!parsed.ok) return json(400, { error: "invalid_payload", detail: parsed.error });

    // 4. One transaction: batch row + readings + last_seen all commit together or not at all.
    const result = await runInTransaction(client, () => ingestBatch(client, boardId, parsed.value));
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error("ingest: failed", err);
    return json(500, { error: "server_error" });
  } finally {
    client.release(); // ALWAYS give the connection back, or the pool runs dry after a few errors
  }
}
