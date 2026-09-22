"""Strict validation of the JSON Schema subset used by planning tools.

Keep execution and the provider-visible schemas in agreement. In particular,
Python's truthy strings and bool-as-int behavior must never coerce a model's
malformed arguments into a calendar mutation.
"""
from math import isfinite


def argument_error(value, schema, path="arguments"):
    kind = schema.get("type")
    valid_type = {
        "object": lambda: isinstance(value, dict),
        "array": lambda: isinstance(value, list),
        "string": lambda: isinstance(value, str),
        "boolean": lambda: type(value) is bool,
        "integer": lambda: type(value) is int,
        "number": lambda: type(value) in (int, float) and isfinite(value),
    }
    if kind not in valid_type:
        raise ValueError(f"Unsupported tool schema type: {kind}")
    if not valid_type[kind]():
        return f"{path} must be {kind}; values are not automatically converted."
    if "enum" in schema and value not in schema["enum"]:
        return f"{path} must be one of {schema['enum']}."
    if kind == "object":
        properties = schema.get("properties", {})
        for required in schema.get("required", []):
            if required not in value:
                return f"{path}.{required} is required."
        if schema.get("additionalProperties") is False and any(key not in properties for key in value):
            return f"{path} contains unsupported fields; allowed fields: {', '.join(properties) or '(none)'}."
        for key, child in value.items():
            if key in properties:
                error = argument_error(child, properties[key], f"{path}.{key}")
                if error:
                    return error
    elif kind == "array":
        if len(value) < schema.get("minItems", 0):
            return f"{path} requires at least {schema['minItems']} item(s)."
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            return f"{path} permits at most {schema['maxItems']} item(s)."
        for index, child in enumerate(value):
            error = argument_error(child, schema["items"], f"{path}[{index}]")
            if error:
                return error
    elif kind in ("number", "integer"):
        if "minimum" in schema and value < schema["minimum"]:
            return f"{path} must be at least {schema['minimum']}."
        if "maximum" in schema and value > schema["maximum"]:
            return f"{path} must be at most {schema['maximum']}."
    return None
