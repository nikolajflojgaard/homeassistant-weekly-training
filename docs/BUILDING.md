# Building Your Integration From This Template

This template is designed to be renamed and extended.

## Recommended Workflow

1. Rename domain and integration name using the helper script:

```bash
python3 scripts/rename_domain.py --old weekly_training --new my_integration --name "My Integration" --repo yourname/my_integration --codeowner "@yourhandle"
```

2. Open your new domain folder:
- `custom_components/my_integration/`

3. Update metadata:
- `manifest.json` (`documentation`, `issue_tracker`, `version`, `codeowners`)
- `hacs.json` (domains + minimum Home Assistant version)

4. Implement your IO:
- Put your real IO in `api.py`
- Use `coordinator.py` to schedule fetch/update

5. Persist small state:
- Use `storage.py` (HA `.storage`) as your lightweight database

## Quick Checks

- GitHub Actions should pass `Validate` (HACS + hassfest).
- Home Assistant should discover config flow.
