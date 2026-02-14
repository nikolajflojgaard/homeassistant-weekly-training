.PHONY: validate lint format

validate:
	./scripts/validate.sh

lint:
	ruff check custom_components scripts

format:
	ruff format custom_components scripts

