import urllib.request
import json

req = urllib.request.Request("http://localhost:8000/api/warehouse/inspections/40")
# we don't need auth since it's probably just a dev environment, or wait!
# let's just use FastAPI's test client
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)
response = client.get("/api/warehouse/inspections/40", headers={"Authorization": "Bearer 1"}) # Just fake it or skip auth if not needed
print(response.json())
