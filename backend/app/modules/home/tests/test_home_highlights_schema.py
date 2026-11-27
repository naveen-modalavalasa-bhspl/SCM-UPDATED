"""The Approvals card's highlights reach the screen (2026-11-21).

The service built them and the response model, lacking the field, dropped them in
silence — the first web test of the Home card is what caught it."""
from app.modules.home.schemas import HomeKpi


def test_highlights_survive_the_response_model():
    kpi = HomeKpi.model_validate({
        "key": "approvals", "label": "APPROVALS", "value": 2, "detail": "0 Overdue",
        "href": "/approvals", "icon": "circle-check",
        "highlights": [{"text": "1 stuck at final approval", "tone": "red",
                        "href": "/approvals?waiting=stuck", "hint": "Waited over 24 h"}],
    })
    assert kpi.model_dump()["highlights"][0]["text"] == "1 stuck at final approval"
