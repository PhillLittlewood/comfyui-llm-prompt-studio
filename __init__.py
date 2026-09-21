# -*- coding: utf-8 -*-
"""
ComfyUI - LLM Prompt Studio
Connect to LM Studio or vLLM (OpenAI-compatible) and generate optimized
image / video / music prompts from inside ComfyUI.
"""

import json
import urllib.error
import urllib.request

from .civitai_prompt import (
    NODE_CLASS_MAPPINGS as _CIVITAI_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _CIVITAI_NAMES,
)
from .nodes import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
    _chat_models_first,
    _downloaded_models,
    _list_models,
    _merge_models,
    _pick_chat_model,
)
from .prompt_templates import TEMPLATES, LEGACY_NAMES
from .text_preview import (
    NODE_CLASS_MAPPINGS as _PREVIEW_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _PREVIEW_NAMES,
)

NODE_CLASS_MAPPINGS.update(_CIVITAI_CLASSES)
NODE_DISPLAY_NAME_MAPPINGS.update(_CIVITAI_NAMES)
NODE_CLASS_MAPPINGS.update(_PREVIEW_CLASSES)
NODE_DISPLAY_NAME_MAPPINGS.update(_PREVIEW_NAMES)

# Tell ComfyUI where the front-end JS lives.
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


# --------------------------------------------------------------------------
# Server routes used by the front-end JS:
#   GET /llm_prompt_studio/models?base_url=...&api_key=...   -> { "models": [...] }
#   GET /llm_prompt_studio/templates                          -> { name: template }
# --------------------------------------------------------------------------
try:
    import server  # ComfyUI's PromptServer module
    from aiohttp import web

    routes = server.PromptServer.instance.routes

    @routes.get("/llm_prompt_studio/models")
    async def _route_models(request):
        base_url = request.query.get("base_url", "http://localhost:1234/v1")
        api_key = request.query.get("api_key", "")
        import asyncio
        loop = asyncio.get_event_loop()

        async def _call(fn):
            """Either half may be missing: vLLM has no native API, and a dead
            address has neither. One answer is enough to fill the list."""
            try:
                return await loop.run_in_executor(None, fn, base_url, api_key), None
            except Exception as e:
                return [], str(e)

        # What the address serves right now, plus everything else it holds on
        # disk - picking a model you have but have not loaded is the point.
        served, served_err = await _call(_list_models)
        catalogue, cat_err = await _call(_downloaded_models)
        models = _merge_models(served, catalogue)
        if not models:
            return web.json_response({"models": [], "suggested": None,
                                      "error": served_err or cat_err or "no model listed"})
        # Chat models on top: the dropdown is read top-down and an encoder is
        # never an answer to "which model writes my prompt". The suggestion
        # stays a served one, since that is what an empty field resolves to.
        return web.json_response({
            "models": _chat_models_first(models),
            "suggested": _pick_chat_model(served) or _pick_chat_model(models),
        })

    @routes.get("/llm_prompt_studio/templates")
    async def _route_templates(request):
        # Renamed cards are served under their old name too, so a workflow saved
        # before the rename still finds its preset. The dropdown is built from
        # TEMPLATE_ORDER, so these aliases never show up as extra entries.
        payload = dict(TEMPLATES)
        payload.update({old: TEMPLATES[new] for old, new in LEGACY_NAMES.items()
                        if new in TEMPLATES})
        return web.json_response(payload)

    print("[LLM Prompt Studio] routes registered.")

except Exception as e:  # pragma: no cover - keeps node usable without the server
    print("[LLM Prompt Studio] could not register web routes:", e)
