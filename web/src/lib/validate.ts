import { UUID_RE } from "./auth";

export type Sample = { channel: number; t: string; raw: number; spread: number };
export type Payload = {
  clientBatchId: string;
  firmwareVersion: string | null;
  uptimeS: number | null;
  wifiRssi: number | null;
  samples: Sample[];
};
export type ParseResult = { ok: true; value: Payload } | { ok: false; error: string };

export const MAX_SAMPLES = 500; // a whole day of backlog is 4 channels x 96 = 384
const MIN_TIME_MS = Date.UTC(2024, 0, 1); // same floor as the CHECK on readings.recorded_at
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

// ISO 8601 WITH an explicit zone (Z or +hh:mm). Without a zone, JS reads "2026-11-03T21:45:00" as the SERVER's
// local time, so the same payload would mean different instants on your laptop (Pacific) and on Vercel (UTC).
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

// `now` is a parameter so tests can pin the clock.
export function parsePayload(body: unknown, now: number = Date.now()): ParseResult {
  const fail = (error: string): ParseResult => ({ ok: false, error });
  if (!isObject(body)) return fail("body must be a JSON object");

  const { client_batch_id, firmware_version, uptime_s, wifi_rssi, samples } = body;

  if (typeof client_batch_id !== "string" || !UUID_RE.test(client_batch_id)) return fail("client_batch_id must be a uuid");
  if (firmware_version !== undefined && (typeof firmware_version !== "string" || firmware_version.length > 40))
    return fail("firmware_version must be a string up to 40 chars");
  if (uptime_s !== undefined && !isIntIn(uptime_s, 0, 2_000_000_000)) return fail("uptime_s must be a non-negative integer");
  if (wifi_rssi !== undefined && !isIntIn(wifi_rssi, -127, 0)) return fail("wifi_rssi must be an integer from -127 to 0");

  if (!Array.isArray(samples)) return fail("samples must be an array");
  if (samples.length < 1) return fail("samples must not be empty");
  if (samples.length > MAX_SAMPLES) return fail(`samples must have at most ${MAX_SAMPLES} entries`);

  const out: Sample[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s: unknown = samples[i];
    if (!isObject(s)) return fail(`samples[${i}] must be an object`);
    if (!isIntIn(s.channel, 1, 32)) return fail(`samples[${i}].channel must be an integer 1..32`);
    if (!isIntIn(s.raw, 0, 4095)) return fail(`samples[${i}].raw must be an integer 0..4095`);
    const spread = s.spread === undefined ? 0 : s.spread;
    if (!isIntIn(spread, 0, 4095)) return fail(`samples[${i}].spread must be an integer 0..4095`);
    if (typeof s.t !== "string" || !ISO_WITH_ZONE.test(s.t)) return fail(`samples[${i}].t must be ISO 8601 with Z or an offset`);
    const ms = Date.parse(s.t);
    if (Number.isNaN(ms)) return fail(`samples[${i}].t is not a real date`);
    if (ms < MIN_TIME_MS) return fail(`samples[${i}].t is before 2024 (board clock not set?)`);
    if (ms > now + MAX_FUTURE_MS) return fail(`samples[${i}].t is in the future`);
    if (ms < now - MAX_AGE_MS) return fail(`samples[${i}].t is more than 30 days old`);
    out.push({ channel: s.channel, t: new Date(ms).toISOString(), raw: s.raw, spread });
  }

  return {
    ok: true,
    value: {
      clientBatchId: client_batch_id.toLowerCase(),
      firmwareVersion: (firmware_version as string | undefined) ?? null,
      uptimeS: (uptime_s as number | undefined) ?? null,
      wifiRssi: (wifi_rssi as number | undefined) ?? null,
      samples: out,
    },
  };
}
