# Contributing

- Keep IO in `custom_components/<domain>/api.py`
- Use `DataUpdateCoordinator` for periodic updates (`coordinator.py`)
- Prefer HA `.storage` for small persistent state (`storage.py`)
- Add diagnostics with redaction (`diagnostics.py`)

Before opening a PR:

```bash
./scripts/validate.sh
```

