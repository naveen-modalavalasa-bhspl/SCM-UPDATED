"""The house style every message this app sends is wrapped in.

WHY IT IS ITS OWN FILE, and not a string in whichever service happens to be sending:
before this, each caller wrote its own body. `service._reset_email` wrote plain text,
`procurement._po_copy_html` wrote a bare `<div>` of inline styles and handed it to a
transport that sent it as `text/plain` — so a supplier received the markup itself. Two
callers, two looks, one of them broken. A template that is called is the only way the
next caller lands in the same place.

THE HARD RULES OF EMAIL HTML, which is not web HTML and does not get to be:

  * **Tables, not flexbox.** Outlook renders through Word; `display:flex`, `grid`,
    `position` and `float` are ignored or worse. Every column below is a `<td>`.
  * **Inline styles only.** Gmail strips `<style>` blocks on some clients and all of
    them on forwards. A `<style>` block is used here for exactly one thing — the
    `@media` query that stacks the layout under 480px — and nothing in the mail
    depends on it having survived.
  * **No external requests.** A remote `<img src="https://...">` is blocked by default
    in Outlook and Gmail, so a logo hosted anywhere is a broken box for most readers on
    first open. The logos are attached to the message and referenced by `cid:` — see
    `LOGO_CIDS` and `client._send_sync`.
  * **A `text/plain` alternative is not optional.** Some clients are configured to
    show it, and a message with no plain part scores as spam. Every function here
    returns BOTH parts, built from the SAME arguments, so they cannot drift.

WEB FONTS ARE NOT USED, deliberately: `@font-face` works in about a third of clients
and the other two thirds fall back mid-paragraph. The stack below is the system UI
face on every platform, which is what the app itself renders in.

Colours are the app's own brand tokens written out literally (`index.css` cannot be
imported into an inbox), and the layout is a LIGHT document whatever the reader's
theme is — `prefers-color-scheme` in mail is unreliable enough that a design which
depends on it renders as black text on black for somebody.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from html import escape, unescape
from pathlib import Path

#: The two logos, as `cid:` names. The transport attaches a file only if its cid
#: appears in the html being sent, so a message that shows neither carries neither.
ASSET_DIR = Path(__file__).parent / "assets"
LOGO_CIDS: dict[str, Path] = {
    "scm-mark": ASSET_DIR / "scm-mark.png",
    "bavya-logo": ASSET_DIR / "bavya-logo.png",
}

# The brand sweep, and the ink it is read against. Same values as `PrintPage.tsx`
# BRAND — a printed indent and an email from the same system are the same letterhead.
BRAND = {
    "grad1": "#FABC41",
    "grad2": "#FB8B00",
    "grad3": "#CC004C",
    "grad4": "#4D148C",
    "brand": "#CC004C",
    "ink": "#141a2a",
    "muted": "#697187",
    "faint": "#8b93a7",
    "line": "#e5e8ef",
    "wash": "#fdf6f0",
    "page": "#f4f5f8",
    "card": "#ffffff",
}

#: A gradient is a background IMAGE, and Outlook drops background images. So the
#: sweep bar is drawn as four solid cells that butt together — a hard-edged sweep
#: everywhere rather than a gradient in half the world and a white gap in the other.
_SWEEP_STOPS = (BRAND["grad1"], BRAND["grad2"], BRAND["grad3"], BRAND["grad4"])

FONT_STACK = (
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',"
    "Arial,'Noto Sans',sans-serif"
)


@dataclass(frozen=True)
class Company:
    """The letterhead line at the foot. Filled from Settings > Company by the caller
    (`settings.service.get_company_letterhead`); the fallbacks are the registered
    particulars, the same ones `frontend/src/modules/indents/companyProfile.ts` holds,
    because a message leaves the building and a blank footer must not go with it."""
    name: str = "Bavya Health Services"
    legal_name: str = "Bavya Health Services Private Limited"
    address: str = (
        "59A-21/7-10, 1st Floor, Ramdev Apartments, Panta Kaluva Rd, "
        "Patamata, Vijayawada, Andhra Pradesh 520007"
    )
    phone: str = ""
    email: str = ""

    @classmethod
    def of(cls, source=None) -> "Company":
        """Settings wins field by field; an empty value there means "not configured".
        Takes anything with the attributes — the Pydantic `CompanySettings`, a dict,
        or nothing at all."""
        if source is None:
            return cls()
        get = (source.get if isinstance(source, dict)
               else lambda key, default="": getattr(source, key, default))
        blank = cls()
        return cls(**{
            field: (str(get(field, "") or "").strip() or getattr(blank, field))
            for field in ("name", "legal_name", "address", "phone", "email")
        })


def _esc(value) -> str:
    return escape(str(value if value is not None else ""), quote=True)


def _sweep_bar(height: int = 4) -> str:
    """The four-colour rule under the letterhead, as solid cells (see `_SWEEP_STOPS`)."""
    cells = "".join(
        f'<td width="25%" height="{height}" style="line-height:{height}px;font-size:0;'
        f'background-color:{colour};">&nbsp;</td>'
        for colour in _SWEEP_STOPS
    )
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'border="0" style="border-collapse:collapse;"><tr>{cells}</tr></table>')


def _header() -> str:
    """SCM's wordmark on the left, `Powered by Bavya` on the right — the same pairing
    the app's own rail shows, so an email is recognisably from the thing they log in
    to. Both logos are `cid:` references; see the module docstring."""
    return (
        f'<tr><td style="padding:26px 32px 18px;background-color:{BRAND["card"]};">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
        f'<tr>'
        f'<td align="left" style="vertical-align:middle;">'
        f'<img src="cid:scm-mark" width="104" alt="SCM ERP" '
        f'style="display:block;width:104px;max-width:104px;height:auto;border:0;">'
        f'</td>'
        f'<td align="right" style="vertical-align:middle;text-align:right;">'
        f'<span style="display:inline-block;font-family:{FONT_STACK};font-size:8px;'
        f'letter-spacing:1.4px;text-transform:uppercase;font-weight:700;'
        f'color:{BRAND["brand"]};vertical-align:middle;padding-right:7px;">Powered by</span>'
        f'<img src="cid:bavya-logo" width="76" alt="Bavya" '
        f'style="display:inline-block;width:76px;max-width:76px;height:auto;border:0;'
        f'vertical-align:middle;">'
        f'</td>'
        f'</tr></table></td></tr>'
        f'<tr><td style="font-size:0;line-height:0;">{_sweep_bar()}</td></tr>'
    )


def _footer(company: Company, note: str | None) -> str:
    contact = "  ·  ".join(x for x in (company.phone, company.email) if x)
    extra = (f'<div style="margin:0 0 10px;font-size:12px;line-height:1.6;'
             f'color:{BRAND["muted"]};">{_esc(note)}</div>' if note else "")
    return (
        f'<tr><td style="padding:20px 32px 26px;background-color:{BRAND["wash"]};'
        f'border-top:1px solid {BRAND["line"]};font-family:{FONT_STACK};">'
        f'{extra}'
        f'<div style="font-size:12px;font-weight:700;color:{BRAND["ink"]};'
        f'letter-spacing:0.2px;">{_esc(company.legal_name or company.name)}</div>'
        f'<div style="margin-top:3px;font-size:11px;line-height:1.6;'
        f'color:{BRAND["faint"]};">{_esc(company.address)}</div>'
        + (f'<div style="margin-top:2px;font-size:11px;color:{BRAND["faint"]};">'
           f'{_esc(contact)}</div>' if contact else "")
        + f'<div style="margin-top:12px;font-size:10.5px;line-height:1.6;'
        f'color:{BRAND["faint"]};">This message was sent automatically by SCM ERP. '
        f'Please do not reply to it.</div>'
        f'</td></tr>'
    )


def button(label: str, url: str) -> str:
    """One call to action, as a padded table cell rather than a styled `<a>`.

    Outlook gives an anchor no padding at all, so a CSS button collapses to plain
    underlined text there. A single-cell table with a background colour is the shape
    that survives everywhere — and the url is repeated in the plain-text part by
    `render`, because a client that strips the button must still leave a way through.
    """
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        f'style="margin:22px 0 6px;"><tr>'
        f'<td align="center" bgcolor="{BRAND["brand"]}" '
        f'style="border-radius:8px;background-color:{BRAND["brand"]};">'
        f'<a href="{_esc(url)}" target="_blank" '
        f'style="display:inline-block;padding:13px 30px;font-family:{FONT_STACK};'
        f'font-size:14px;font-weight:700;line-height:1;color:#ffffff;'
        f'text-decoration:none;border-radius:8px;">{_esc(label)}</a>'
        f'</td></tr></table>'
    )


def paragraph(text: str, muted: bool = False) -> str:
    colour = BRAND["muted"] if muted else BRAND["ink"]
    size = "13px" if muted else "14.5px"
    return (f'<p style="margin:0 0 14px;font-family:{FONT_STACK};font-size:{size};'
            f'line-height:1.65;color:{colour};">{_esc(text)}</p>')


def facts(rows: list[tuple[str, str]]) -> str:
    """A label/value block — a document's particulars, a reset's expiry.

    Two columns of a table, not a definition list: `<dl>` is unstyled in half of the
    clients and indented differently in the rest.
    """
    if not rows:
        return ""
    body = "".join(
        f'<tr>'
        f'<td style="padding:7px 14px 7px 0;font-family:{FONT_STACK};font-size:11px;'
        f'text-transform:uppercase;letter-spacing:0.8px;font-weight:700;'
        f'color:{BRAND["faint"]};white-space:nowrap;vertical-align:top;">{_esc(label)}</td>'
        f'<td style="padding:7px 0;font-family:{FONT_STACK};font-size:13.5px;'
        f'line-height:1.5;color:{BRAND["ink"]};font-weight:600;">{_esc(value)}</td>'
        f'</tr>'
        for label, value in rows
    )
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" style="margin:4px 0 18px;border-collapse:collapse;'
        f'border:1px solid {BRAND["line"]};border-radius:10px;'
        f'background-color:#fbfcfe;"><tr><td style="padding:6px 16px;">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0">{body}</table></td></tr></table>'
    )


def link_fallback(url: str) -> str:
    """The button's url spelled out, for a client that mangled the button. Wrapped at
    any character (`word-break`) so a 90-character token does not stretch the card."""
    return (
        f'<p style="margin:0 0 4px;font-family:{FONT_STACK};font-size:11.5px;'
        f'line-height:1.5;color:{BRAND["faint"]};">'
        f'If the button does not work, copy this link into your browser:</p>'
        f'<p style="margin:0 0 16px;font-family:{FONT_STACK};font-size:11.5px;'
        f'line-height:1.5;word-break:break-all;color:{BRAND["brand"]};">'
        f'<a href="{_esc(url)}" style="color:{BRAND["brand"]};'
        f'text-decoration:underline;">{_esc(url)}</a></p>'
    )


def render(*, subject: str, heading: str, blocks: list[str],
           preheader: str = "", eyebrow: str = "",
           company: Company | None = None, footer_note: str | None = None) -> str:
    """The house shell around `blocks`, which are the fragments above joined in order.

    `preheader` is the grey line an inbox shows next to the subject. Left out, a client
    lifts it from the first thing in the body — which for a message that opens with a
    logo is the alt text, so the list reads "SCM ERP SCM ERP". It is hidden in the
    body itself by the zero-size span, padded so nothing after it leaks in.
    """
    company = company or Company()
    hidden = (
        f'<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;'
        f'font-size:1px;line-height:1px;color:{BRAND["page"]};opacity:0;">'
        f'{_esc(preheader)}{"&#847;&zwnj;&nbsp;" * 30}</div>'
    ) if preheader else ""

    eyebrow_html = (
        f'<div style="margin:0 0 6px;font-family:{FONT_STACK};font-size:10.5px;'
        f'font-weight:700;letter-spacing:1.3px;text-transform:uppercase;'
        f'color:{BRAND["brand"]};">{_esc(eyebrow)}</div>' if eyebrow else ""
    )

    return (
        f'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" '
        f'"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">'
        f'<html xmlns="http://www.w3.org/1999/xhtml"><head>'
        f'<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />'
        f'<meta name="viewport" content="width=device-width,initial-scale=1" />'
        f'<meta name="x-apple-disable-message-reformatting" />'
        f'<title>{_esc(subject)}</title>'
        # The one @media rule, and nothing depends on it: without it the card simply
        # keeps its 32px padding on a narrow screen.
        f'<style type="text/css">'
        f'@media only screen and (max-width:480px){{'
        f'.pad{{padding-left:20px !important;padding-right:20px !important;}}'
        f'.card{{width:100% !important;}}}}'
        f'</style></head>'
        f'<body style="margin:0;padding:0;background-color:{BRAND["page"]};'
        f'-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">'
        f'{hidden}'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" style="background-color:{BRAND["page"]};">'
        f'<tr><td align="center" style="padding:28px 12px;">'
        f'<table role="presentation" class="card" width="600" cellpadding="0" '
        f'cellspacing="0" border="0" style="width:600px;max-width:600px;'
        f'border-collapse:collapse;background-color:{BRAND["card"]};'
        f'border-radius:14px;overflow:hidden;'
        f'border:1px solid {BRAND["line"]};">'
        f'{_header()}'
        f'<tr><td class="pad" style="padding:28px 32px 8px;'
        f'background-color:{BRAND["card"]};">'
        f'{eyebrow_html}'
        f'<h1 style="margin:0 0 18px;font-family:{FONT_STACK};font-size:21px;'
        f'line-height:1.3;font-weight:800;color:{BRAND["ink"]};'
        f'letter-spacing:-0.3px;">{_esc(heading)}</h1>'
        f'{"".join(blocks)}'
        f'</td></tr>'
        f'<tr><td class="pad" style="padding:0 32px 24px;'
        f'background-color:{BRAND["card"]};"></td></tr>'
        f'{_footer(company, footer_note)}'
        f'</table></td></tr></table></body></html>'
    )


# --------------------------------------------------------------------------- #
#  The plain-text half
# --------------------------------------------------------------------------- #

_TAG = re.compile(r"<[^>]+>")
_BLANKS = re.compile(r"\n{3,}")


def to_text(html: str) -> str:
    """A readable `text/plain` fallback derived from the html itself.

    Derived rather than written twice on purpose: two hand-maintained copies of a
    message drift, and the one nobody looks at is the one that goes stale. Block-level
    tags become line breaks, the rest are dropped, entities are unescaped.

    A caller with something better to say in plain text passes its own instead:
    `service._log_and_send` takes `body` and `html` separately and never derives one
    from the other behind the caller's back.
    """
    text = re.sub(r"(?is)<(head|style|title)[^>]*>.*?</\1>", "", html)
    # The preheader is hidden FROM THE EYE, not from a text reader — it would arrive
    # as the first line followed by thirty invisible padding characters.
    text = re.sub(r"(?is)<div[^>]*display:none[^>]*>.*?</div>", "", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    # A cell boundary is a SPACE and a row boundary is a line: without the first,
    # a label column and its value run together as one word.
    text = re.sub(r"(?i)</t[dh]>", " ", text)
    text = re.sub(r"(?i)</(p|div|h1|h2|h3|tr|table)>", "\n", text)
    text = _TAG.sub("", text)
    text = unescape(text)
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return _BLANKS.sub("\n\n", "\n".join(lines)).strip()
