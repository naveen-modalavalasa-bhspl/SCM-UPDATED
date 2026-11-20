"""Escalation follows the document's OWN ladder (2026-11-20, MoM point 2). Pure."""
from app.platform.workflow import escalation
from app.platform.workflow.models import Instance


def chain(n):
    return [{"sequence": i, "role_name": f"Level {i}", "approver_ids": [i],
             "approver_names": [f"Person {i}"]} for i in range(1, n + 1)]


def test_a_rung_with_another_above_it_is_not_the_last():
    doc = Instance(resolved_chain=chain(3), current_sequence=2)
    assert escalation.is_last_rung(doc) is False
    assert escalation.is_last_rung(doc, 3) is True


def test_the_top_rung_has_nowhere_to_go():
    assert escalation.is_last_rung(Instance(resolved_chain=chain(2), current_sequence=2)) is True


def test_the_history_note_says_who_it_waited_with_and_where_it_went():
    note = escalation.escalation_note(24, ["Anita"], "Regional Manager", "District Manager")
    assert note == ("Escalated — waited 24 h with Anita (Regional Manager). "
                    "Moved to District Manager by the system.")


def test_the_note_still_reads_with_nobody_named():
    assert escalation.escalation_note(25.4, [], None, None).startswith(
        "Escalated — waited 25 h with the approver.")
