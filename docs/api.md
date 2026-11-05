# AINA ingest API (v1 draft, implemented in `web/`)

The contract between firmware and server. Firmware work should follow this file.

## POST /api/ingest

Headers

| header | value |
|---|---|
| `X-Board-Id` | the board's UUID (printed by `npm run bootstrap`) |
| `Authorization` | `Bearer <board key>` (printed once by bootstrap; the server stores only its SHA-256) |
| `Content-Type` | `application/json` |

Body

```json
{
  "client_batch_id": "6f1c0b0e-6e4e-4a53-9a3f-0f6a1d1d2b11",
  "firmware_version": "0.1.0-dev",
  "uptime_s": 10800,
  "wifi_rssi": -61,
  "samples": [
    { "channel": 1, "t": "2026-11-03T21:45:00Z", "raw": 3088, "spread": 54 }
  ]
}
```

| field | rules |
|---|---|
| `client_batch_id` | required. A NEW random UUID per batch, **kept the same when that batch is re-sent**. This is what makes retries safe |
| `firmware_version` | optional string, up to 40 chars |
| `uptime_s` | optional integer >= 0. Seconds since boot; a drop between batches means a reboot |
| `wifi_rssi` | optional integer, -127 to 0 |
| `samples` | required, 1 to 500 entries |
| `samples[].channel` | integer 1 to 32. Must exist on this board or the sample is dropped |
| `samples[].t` | ISO 8601 **with** `Z` or an offset. Not before 2024 (board clock not set), not more than 5 min in the future, not older than 30 days |
| `samples[].raw` | integer 0 to 4095. The median of the oversampled ADC reads, unmodified |
| `samples[].spread` | optional integer 0 to 4095 (default 0). max minus min of those reads |

Body size limit: 64 KB.

Responses

| status | body | meaning | what the board should do |
|---|---|---|---|
| 200 | `{"ok":true,"received":4,"inserted":4}` | stored. `inserted` < `received` means a retry, overlap, or unknown channel | drop the batch from RAM |
| 400 | `{"error":"invalid_json"}` or `{"error":"invalid_payload","detail":"..."}` | the payload is wrong; resending the same thing will fail again | log it, drop the batch (or the bad samples), do not retry forever |
| 401 | `{"error":"unauthorized"}` | unknown board or wrong key (same answer on purpose) | do not retry quickly; the key is wrong |
| 413 | `{"error":"payload_too_large"}` | over 64 KB | split the batch |
| 500 / 503 | `{"error":"server_error"}` / `database_unavailable` | server-side trouble | keep the batch and retry later with the SAME `client_batch_id` |

Rule of thumb for firmware: **2xx means delete, 4xx means don't resend the same bytes, 5xx or no reply means keep and retry the same batch id.**

## GET /api/health

`{"ok":true,"db_ms":9}` when the app can reach the database; 503 otherwise. No auth. The `db_ms` number is handy for seeing Neon wake from sleep.
