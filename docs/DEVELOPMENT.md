# Development

## Local Setup

Optional dev dependencies:

```bash
pip3 install -r requirements-dev.txt
```

Run checks:

```bash
./scripts/validate.sh
```

## Enabling GitHub Actions Workflows

If your Git credentials cannot push workflows, they are stored in `docs/workflows/`.
Enable them locally via:

```bash
./scripts/enable_ci.sh
```

