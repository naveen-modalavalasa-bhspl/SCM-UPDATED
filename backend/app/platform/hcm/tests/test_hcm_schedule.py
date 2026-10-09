"""HCM schedule endpoints: admin-only, get/set roundtrip."""


async def test_schedule_requires_admin(client, make_user, login):
    await make_user(employee_id=2, username="u", password="pw", permissions=["indent.view"])
    headers = await login("u", "pw")
    r = await client.get("/api/hcm/schedule", headers=headers)
    assert r.status_code == 403


async def test_admin_sets_and_reads_schedule(client, make_user, login):
    await make_user(employee_id=3, username="admin1", password="pw",
                    permissions=["admin.users.manage"])
    headers = await login("admin1", "pw")

    r = await client.put("/api/hcm/schedule", headers=headers,
                         json={"enabled": True, "interval_minutes": 120})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True and body["interval_minutes"] == 120

    g = await client.get("/api/hcm/schedule", headers=headers)
    assert g.json()["interval_minutes"] == 120
