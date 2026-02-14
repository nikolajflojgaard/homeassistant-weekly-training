# FAQ

## Why does this template include storage, services, websocket, and diagnostics?

Most integrations end up implementing these. Having good defaults helps contributors build consistent, maintainable integrations.

## Do I have to keep host/api_key fields?

No. Remove `CONF_HOST` / `CONF_API_KEY` and related code if your integration does not need auth.

