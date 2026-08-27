"""API console endpoints. No logic here (rule 2).

Two routers under one `router` object, because `main.py` includes one attribute per
module and the two halves are one feature:

  * `/api/apis/**` — the console. JWT + `require_permission`, like every other
    endpoint in the system.
  * `/api/ext/v1/**` — what an outside application calls. An API key, no session, no
    employee, and no route that writes to a business table.

Three permission codes, declared in `platform/rbac/permissions.py` (rule 6):

  * `integration.view`    — see connected applications, their endpoints and usage
  * `integration.manage`  — register an application and compose its endpoints
  * `integration.keys.manage` — issue and revoke keys

Split three ways rather than riding on `admin.settings.manage`, because handing an
outside system a key that reads the database is not the same decision as editing the
company address — and that code also unscopes every stock list. All three are
fail-closed: Admin on first start, nobody else, until a job profile grants them.
"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import PageParams
from app.modules.integrations import (
    adapters, introspect, platform_links, service, webhooks,
)
from app.modules.integrations.schemas import (
    CallLogOut, ClientOut, ClientWrite, ColumnOut, EndpointImportIn, EndpointOut,
    EndpointWrite, ExtEndpointOut, ExtPage, ImportResultOut, KeyIssuedOut, KeyOut,
    KeyWrite, LinkLogRow, LinkRevealOut, LinkTestOut, PlatformLinkOut, PreviewOut,
    TableOut, UsageOut, WebhookOut, WebhookSecretOut, WebhookWrite,
)
from app.modules.integrations.security import Caller, require_api_key
from app.platform.rbac import permissions as perms

VIEW = perms.INTEGRATION_VIEW
CONSOLE = perms.INTEGRATION_MANAGE
KEYS = perms.INTEGRATION_KEYS_MANAGE

console = APIRouter(prefix="/api/apis", tags=["api-console"])
external = APIRouter(prefix="/api/ext/v1", tags=["external-api"])


# --------------------------------------------------------------------------- #
# Source picker
# --------------------------------------------------------------------------- #

@console.get("/tables", response_model=list[TableOut])
async def tables(db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(CONSOLE))):
    return await introspect.tables(db)


@console.get("/tables/{table}/columns", response_model=list[ColumnOut])
async def table_columns(table: str, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(CONSOLE))):
    return await introspect.columns(db, table)


@console.post("/schema/refresh")
async def refresh_schema(user=Depends(require_permission(CONSOLE))):
    """Re-read the database after a migration, without restarting the server."""
    introspect.reset_cache()
    return {"success": True}


@console.get("/adapters")
async def list_adapters(user=Depends(require_permission(VIEW))):
    """The hand-written integrations this deployment carries.

    An adapter serves shapes the endpoint builder cannot compose. The list is whatever
    is installed under `integrations/adapters/`, so a new system appears here by being
    dropped in — the console has no idea which ones exist until it asks.
    """
    return [{"key": a.key, "name": a.name, "description": a.description,
             "scope": a.key, "base_path": f"/api/ext/v1/{a.key}"}
            for a in adapters.catalogue()]


# --------------------------------------------------------------------------- #
# Clients
# --------------------------------------------------------------------------- #

@console.get("/clients")
async def list_clients(params: PageParams = Depends(), search: str = "",
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(VIEW))):
    return await service.list_clients(db, params, search=search or None)


@console.post("/clients", response_model=ClientOut, status_code=201)
async def create_client(body: ClientWrite, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(CONSOLE))):
    return await service.create_client(db, body, user)


@console.get("/clients/{code}", response_model=ClientOut)
async def get_client(code: str, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(VIEW))):
    return await service.get_client(db, code)


@console.put("/clients/{code}", response_model=ClientOut)
async def update_client(code: str, body: ClientWrite,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(CONSOLE))):
    return await service.update_client(db, code, body)


# --------------------------------------------------------------------------- #
# Keys
# --------------------------------------------------------------------------- #

@console.get("/clients/{code}/keys", response_model=list[KeyOut])
async def list_keys(code: str, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(VIEW))):
    return await service.list_keys(db, code)


@console.post("/clients/{code}/keys", response_model=KeyIssuedOut, status_code=201)
async def issue_key(code: str, body: KeyWrite, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(KEYS))):
    """The only response in the system that carries a raw key. Shown once."""
    return await service.issue_key(db, code, body, user)


@console.post("/keys/{prefix}/revoke", response_model=KeyOut)
async def revoke_key(prefix: str, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(KEYS))):
    return await service.revoke_key(db, prefix, user)


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #

@console.get("/clients/{code}/endpoints", response_model=list[EndpointOut])
async def list_endpoints(code: str, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(VIEW))):
    return await service.list_endpoints(db, code)


@console.post("/clients/{code}/endpoints/preview", response_model=PreviewOut)
async def preview(code: str, body: EndpointWrite, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(CONSOLE))):
    """The SQL and the first rows, before anything is saved."""
    return await service.preview(db, code, body)


@console.post("/clients/{code}/endpoints", response_model=EndpointOut, status_code=201)
async def create_endpoint(code: str, body: EndpointWrite,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(CONSOLE))):
    return await service.save_endpoint(db, code, body, user)


@console.put("/clients/{code}/endpoints/{slug}", response_model=EndpointOut)
async def update_endpoint(code: str, slug: str, body: EndpointWrite,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(CONSOLE))):
    return await service.save_endpoint(db, code, body, user, replacing=slug)


@console.delete("/endpoints/{slug}", response_model=EndpointOut)
async def delete_endpoint(slug: str, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(CONSOLE))):
    return await service.delete_endpoint(db, slug)


@console.get("/clients/{code}/docs")
async def connection_docs(code: str, request: Request,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(VIEW))):
    """What you send a partner so they can start: base URL, auth, and every endpoint
    with what it accepts and what it returns. DERIVED from the endpoint documents —
    a doc kept in step by hand is wrong by the second week."""
    base = str(request.base_url).rstrip("/")
    return await service.connection_docs(db, code, base)


@console.get("/endpoints/{slug}/sample")
async def endpoint_sample(slug: str, rows: int = 2,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(VIEW))):
    """A real response from this endpoint, so its shape is seen rather than imagined.
    Runs it exactly as an API key would, with a small page."""
    return await service.endpoint_sample(db, slug, rows)


@console.get("/clients/{code}/endpoints/export")
async def export_endpoints(code: str, db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(CONSOLE))):
    """This application's whole endpoint set, as a clip to paste into another
    deployment. Carries NO keys — only a hash of those is ever stored, and a key that
    worked on two deployments could not be revoked on either."""
    return await service.export_endpoints(db, code)


@console.post("/clients/{code}/endpoints/import", response_model=ImportResultOut)
async def import_endpoints(code: str, body: EndpointImportIn,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(CONSOLE))):
    """Apply an exported set here. All-or-nothing, and every endpoint is re-validated
    against THIS database, so a clip cannot introduce a table or column this
    deployment does not have — or one on the blocked list."""
    return await service.import_endpoints(db, code, body.clip, user, body.replace)


# --------------------------------------------------------------------------- #
# Usage
# --------------------------------------------------------------------------- #

@console.get("/clients/{code}/logs")
async def call_logs(code: str, params: PageParams = Depends(),
                    errors_only: bool = False, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(VIEW))):
    return await service.call_logs(db, code, params, errors_only=errors_only)


@console.get("/clients/{code}/usage", response_model=UsageOut)
async def usage(code: str, db: AsyncSession = Depends(get_db),
                user=Depends(require_permission(VIEW))):
    return await service.usage(db, code)


# --------------------------------------------------------------------------- #
# External — what an outside application calls
# --------------------------------------------------------------------------- #
# Literal paths are declared before `/{slug}`, or "_endpoints" is read as a slug.

@external.get("/_ping")
async def ping(caller: Caller = Depends(require_api_key)):
    """What this key is. The first call a new consumer makes to prove it is wired up."""
    return {"client": caller.client_code, "name": caller.client.get("name"),
            "scopes": caller.scopes}


@external.get("/_endpoints", response_model=list[ExtEndpointOut])
async def endpoints(db: AsyncSession = Depends(get_db),
                    caller: Caller = Depends(require_api_key)):
    return await service.visible_endpoints(db, caller)


@external.get("/{slug}", response_model=ExtPage)
async def read(slug: str, request: Request, db: AsyncSession = Depends(get_db),
               caller: Caller = Depends(require_api_key)):
    return await service.serve_logged(
        db, slug, caller, dict(request.query_params),
        ip=request.client.host if request.client else None)


# --------------------------------------------------------------------------- #
#  Platform links — what THIS app connects out to
# --------------------------------------------------------------------------- #
# The mirror of the console above: that half is "who calls us", this half is "who do
# we call". Same router, same `integration.view` gate, so a job profile that can read
# the API console can read this and nothing new has to be granted.
#
# Every secret these routes return is MASKED in `platform_links` and there is no
# endpoint that unmasks one. `/test` is how "is the credential right" gets answered
# without ever sending the credential to a browser.
#
# Read-only throughout: no route here writes a business table, and none enters a
# workflow — configuration is not a document and has no approval ladder.

@console.get("/platform", response_model=list[PlatformLinkOut])
async def list_platform_links(db: AsyncSession = Depends(get_db),
                              user=Depends(require_permission(VIEW))):
    """Every outbound link. Makes no network call — opening a settings screen must not
    hang on a dead SMTP host; `/test` is the button that does."""
    return await platform_links.list_links(db)


@console.get("/platform/{code}", response_model=PlatformLinkOut)
async def get_platform_link(code: str, db: AsyncSession = Depends(get_db),
                            user=Depends(require_permission(VIEW))):
    return await platform_links.get_link(db, code)


@console.get("/platform/{code}/logs")
async def platform_link_logs(code: str, params: PageParams = Depends(),
                             status: str | None = None,
                             db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(VIEW))):
    """The link's own log — `sys_hcm_sync_log` or `sys_mail_messages` — normalised to
    one row shape. Nothing is written for this screen's benefit."""
    return await platform_links.link_logs(db, code, params, status)


@console.get("/platform/{code}/log-stats", response_model=dict)
async def platform_link_log_stats(code: str, db: AsyncSession = Depends(get_db),
                                  user=Depends(require_permission(VIEW))):
    return await platform_links.link_stats(db, code)


@console.post("/platform/{code}/reveal", response_model=LinkRevealOut)
async def reveal_platform_link(code: str, db: AsyncSession = Depends(get_db),
                               user=Depends(require_permission(KEYS))):
    """The real credentials for one link, in the clear.

    On KEYS (`integration.keys.manage`), not the VIEW the rest of this panel uses:
    reading a credential is the same class of act as issuing one, and the two codes
    can be granted apart. A POST rather than a GET so a secret can never arrive as a
    side effect of opening a screen, being prefetched, or sitting in a URL. Writes an
    audit row naming the reader and the link — see `platform_links.reveal_secrets`.
    """
    return await platform_links.reveal_secrets(db, code, user)


@console.post("/platform/{code}/test", response_model=LinkTestOut)
async def test_platform_link(code: str, db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(VIEW))):
    """One live call against the configured credentials. Nothing is sent, nothing is
    written: the mail probe authenticates and hangs up, and the HCM probe reads one
    row. A failure is the answer, not a 500."""
    return await platform_links.test_link(db, code)


# --------------------------------------------------------------------------- #
# Inbound webhooks — who may push into SCM, configured rather than written
# --------------------------------------------------------------------------- #
#
# The console half carries `integration.manage` like the endpoint builder, except the
# secret, which is `integration.keys.manage`: minting the value a partner signs with is
# the same class of act as issuing an API key.

@console.get("/webhooks", response_model=list[WebhookOut])
async def list_webhooks(db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(VIEW))):
    return await webhooks.list_hooks(db)


@console.get("/webhook-handlers")
async def webhook_handlers(user=Depends(require_permission(VIEW))):
    """What a webhook may DO with what it receives — a closed set, served so the screen
    offers exactly what the server will accept rather than a list that can drift."""
    return webhooks.handler_choices()


@console.get("/webhook-events")
async def webhook_events(db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(VIEW))):
    """Event names to offer in the picker. Suggestions, not a whitelist — a partner's
    own name is accepted too. What it saves is the typo, which otherwise reads as a
    silent afternoon of nothing arriving."""
    return await webhooks.event_suggestions(db)


@console.post("/webhooks", response_model=WebhookOut, status_code=201)
async def create_webhook(body: WebhookWrite, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(CONSOLE))):
    return await webhooks.create_hook(db, body, user)


@console.get("/webhooks/{source}", response_model=WebhookOut)
async def get_webhook(source: str, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(VIEW))):
    return await webhooks.get_hook(db, source)


@console.put("/webhooks/{source}", response_model=WebhookOut)
async def update_webhook(source: str, body: WebhookWrite,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(CONSOLE))):
    return await webhooks.update_hook(db, source, body, user)


@console.delete("/webhooks/{source}", response_model=WebhookOut)
async def delete_webhook(source: str, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(CONSOLE))):
    """Deactivates rather than deletes, so the deliveries it took keep their meaning."""
    return await webhooks.delete_hook(db, source)


@console.get("/webhooks/{source}/docs")
async def webhook_docs(source: str, request: Request,
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(VIEW))):
    """What you send the system that will push to us: the URL, the two headers, the
    signing recipe, the events it may send and a body per event. Derived from the
    registration, so it cannot drift from what the endpoint will actually accept."""
    base = str(request.base_url).rstrip("/")
    return await webhooks.connection_docs(db, source, base)


@console.post("/webhooks/{source}/secret", response_model=WebhookSecretOut,
              status_code=201)
async def rotate_webhook_secret(source: str, db: AsyncSession = Depends(get_db),
                                user=Depends(require_permission(KEYS))):
    """Mint the secret this source signs its pushes with. Shown once."""
    return await webhooks.rotate_secret(db, source, user)


@console.get("/webhook-deliveries")
async def webhook_deliveries(params: PageParams = Depends(), source: str = "",
                             event: str = "", db: AsyncSession = Depends(get_db),
                             user=Depends(require_permission(VIEW))):
    return await webhooks.deliveries(db, params, source or None, event or None)


@console.get("/webhook-deliveries/{source}/{event_id}")
async def webhook_delivery(source: str, event_id: str,
                           db: AsyncSession = Depends(get_db),
                           user=Depends(require_permission(VIEW))):
    return await webhooks.delivery(db, source, event_id)


hooks = APIRouter(prefix="/api/ext/v1/hooks", tags=["external-api"])


@hooks.post("/{source}")
async def receive_webhook(source: str, request: Request,
                          db: AsyncSession = Depends(get_db),
                          caller: Caller = Depends(require_api_key)):
    """Where a registered system pushes. API key AND a signature over the raw body:
    the key says who is calling, the signature says the body is what they sent."""
    body = await request.body()
    return await webhooks.receive(
        db, source, body, request.headers.get(webhooks.SIGNATURE_HEADER),
        webhooks.json_body(body), caller.client_code,
    )


router = APIRouter()
# Adapters and `hooks` BEFORE `external`: that router ends in `/{slug}`, which would
# otherwise swallow every one-segment path under /api/ext/v1 — including each adapter's
# own prefix. Whatever `adapters.discover()` finds is mounted; no system is named here.
for _adapter_router in adapters.routers():
    router.include_router(_adapter_router)
router.include_router(hooks)
router.include_router(console)
router.include_router(external)
