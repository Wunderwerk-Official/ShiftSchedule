"""Explicit, same-endpoint fallback policy for the deployed Qwen planners.

Do not select arbitrary entries from /models: the endpoint also serves
embeddings, rerankers, OCR and safety models that cannot plan with tools.
Keep the preferred model in settings; each new run starts at that preference.
"""
import re


QWEN_MODEL_ORDER = (
    "nvidia/Qwen3.8-Flash-Next-NVFP4",
    "Qwen/Qwen3.8-27B",
    "Qwen/Qwen3.5-122B-A10B-GPTQ-Int4-cliniva",
)


def model_fallback_order(model: str) -> list[str]:
    """Respect explicit model selection; only known Qwen picks have fallbacks."""
    if model not in QWEN_MODEL_ORDER:
        return [model]
    return list(QWEN_MODEL_ORDER[QWEN_MODEL_ORDER.index(model):])


def model_is_unavailable(status: int, body, message: str) -> bool:
    """Classify missing deployments, never auth, context or transport errors.

    Several LiteLLM deployments report a missing model as 400, while other
    OpenAI-compatible servers use 404 or a model-specific 503. Status alone
    is not sufficient. Only the classification is persisted, not raw bodies.
    """
    if status not in (400, 404, 422, 429, 500, 502, 503):
        return False
    error = body.get("error", body) if isinstance(body, dict) else {}
    if not isinstance(error, dict):
        error = {}
    if str(error.get("code", "")).lower() in {
        "model_not_found", "model_not_available", "model_unavailable",
        "deployment_not_found", "deploymentnotfound",
    }:
        return True
    detail = str(error.get("message") or message or "").lower()
    if re.search(r"\bno (?:healthy|available) deployments?\b", detail):
        return True
    return any(re.search(pattern, detail) for pattern in (
        r"\binvalid model (?:name|id)\b",
        r"\bunknown model\b",
        r"\bmodel\s+(?:['\"`][^'\"`]+['\"`]\s+)?(?:was |is )?(?:not found|not available|unavailable|does not exist)\b",
        r"\bmodel_not_found\b",
    ))
