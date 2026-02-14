"""Frontend asset registration for Weekly Training card."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

CARD_STATIC_URL = "/weekly_training_files/weekly-training-card.js"


async def async_register_frontend(hass: HomeAssistant) -> None:
    card_path = Path(__file__).parent / "frontend" / "weekly-training-card.js"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_STATIC_URL, str(card_path), cache_headers=False)]
    )
    add_extra_js_url(hass, CARD_STATIC_URL)

