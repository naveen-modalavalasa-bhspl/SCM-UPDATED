"""Data-driven event / condition / action engine.

Other modules use one function:

    from app.platform.rules import fire
    actions = await fire(db, "INDENT_SUBMITTED", ctx, doc_type="INDENT", doc_id=42)
"""
from app.platform.rules.evaluator import Action, actions_of_type, evaluate, fire

__all__ = ["Action", "actions_of_type", "evaluate", "fire"]
