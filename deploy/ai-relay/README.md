# M-BOX Gemini Relay

This minimal Cloud Run service lets the Alibaba Cloud runtime reach Gemini
without exposing the Gemini API key to that runtime.

Required environment variables:

- `MBOX_RELAY_TOKEN`: a random value of at least 32 characters. The Alibaba
  runtime sends this value in `x-goog-api-key`.
- `MBOX_GEMINI_API_KEY`: the real Gemini API key, supplied from Secret Manager.

The service exposes:

- `GET /health`
- `POST /v1beta/interactions`

Set the Alibaba runtime's `MBOX_GEMINI_ENDPOINT` to the relay interactions URL
and set its `MBOX_GEMINI_API_KEY` to the relay token. Never configure the real
Gemini API key on the Alibaba host when the relay is in use.
