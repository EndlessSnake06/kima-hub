"""Sorts analysis failures into DAMAGED (corrupt bitstream), UNSUPPORTED
(codec), MULTICANNEL (over two channels) and INCONCLUSIVE (anything else,
left retryable). Only strong signatures are terminal. Stdlib only, so the
worker process can import it cheaply.
"""

import re


class Disposition:
    """Terminal disposition constants. ``INCONCLUSIVE`` is the non-terminal,
    still-retryable bucket."""

    DAMAGED = "DAMAGED"
    UNSUPPORTED = "UNSUPPORTED"
    MULTICANNEL = "MULTICANNEL"
    INCONCLUSIVE = "INCONCLUSIVE"


# Strong corruption signatures only: a file matching one fails the same way on
# retry. Dooming a file that would decode is worse than missing a rare phrasing.
_DAMAGED_PATTERNS = [
    r"truncated",
    r"\bcrc\b",
    r"over[hr]ead",
    r"missing\s+keyframe",
    r"non[- ]?monotonou[sd]\s+dts",
    r"error\s+while\s+decoding",
    r"cannot\s+decode",
    r"could\s+not\s+decode",
    r"failed\s+to\s+decode",
    r"stretched\s+frame",
    r"invalid\s+start",
    r"invalid\s+end",
    r"invalid\s+\S+\s+frame",
    r"corrupt(?:ed|ion)?\s*(?:bitstream|audio|data|stream|file)",
    r"malformed\s+(?:audio|bitstream|data|stream|file)",
    r"decode[_\s]+frame\b",
    r"\bheader\s+missing\b",
    r"invalid\s+dts",
]

# Signals a codec the engine lacks or cannot decode: a format difference, not a
# damaged file. Retrying cannot supply the missing decoder. Kept to the specific
# phrases the design note lists so an ordinary failure is never branded a codec
# it happens to mention in passing.
_UNSUPPORTED_PATTERNS = [
    r"unsupported\s+codec",
    r"not\s+capable\s+of\s+decoding",
    r"unknown\s+demuxer",
    r"decoder\s+.*not\s+found",
    r"codec\s+.*not\s+found",
]

_MULTICANNEL_PATTERNS = [
    r"more\s+than\s+2\s+channels?",
    r"more\s+than\s+2\s+audio\s+channels?",
    r"multichannel",
]

# Codec names recognised by the extraction below, used so an UNSUPPORTED failure
# reports what the library actually contains instead of a opaque token.
_CODECS = (
    "aac", "ac-3", "ac3", "alac", "amr", "dts", "flac", "m4a", "mp3", "mp4",
    "mpga", "mp2", "ogg", "oga", "vorbis", "opus", "wav", "wma", "aiff", "aif",
    "aacp", "ec-3", "ec3",
)
_CODEC_RE = re.compile(
    r"\b(?:" + "|".join(_CODECS) + r")\b", re.IGNORECASE
)


def _find(msg: str, patterns):
    for pat in patterns:
        if re.search(pat, msg, re.IGNORECASE):
            return pat
    return None


def classify_failure(message: str, ext_hint: str = "") -> str:
    """Return the disposition for a raw ESSENTIA/decoder error message.

    ``ext_hint`` is an optional file-extension hint used only to improve the
    codec attribution of an ``UNSUPPORTED`` result; it never changes the class.
    """

    if not message:
        return Disposition.INCONCLUSIVE

    # 1) Multichannel is unambiguous and listed first in the precedence chain.
    if _find(message, _MULTICANNEL_PATTERNS):
        return Disposition.MULTICANNEL

    # 2) Unsupported codec: a format the engine lacks. Name the codec when we can.
    if _find(message, _UNSUPPORTED_PATTERNS):
        return Disposition.UNSUPPORTED

    # 3) Damaged bitstream: strong corruption signature only.
    if _find(message, _DAMAGED_PATTERNS):
        return Disposition.DAMAGED

    # 4) Nothing decisive -- leave it retryable.
    return Disposition.INCONCLUSIVE


def classify_with_codec(message: str) -> tuple:
    """As :func:`classify_failure` plus the attribution payload.

    Returns ``(disp, codec_name)`` where ``codec_name`` is a short label usable
    in UI copy ("UNSUPPORTED::dts -- ..."), or ``"unknown"`` when no codec token
    is visible in the message.
    """

    disp = classify_failure(message)
    if disp == Disposition.UNSUPPORTED:
        codec = _extract_codec(message, "")
        return disp, codec
    return disp, "unknown"


def _extract_codec(message: str, ext_hint: str = "") -> str:
    """Codec named in the message, else the file extension, else "unknown"."""

    m = _CODEC_RE.search(message)
    if m:
        return m.group(0).lower()

    # Fall back to the file extension hint (e.g. "dts") when no codec name was
    # in the message.
    if ext_hint:
        return ext_hint.strip(".").lower()

    return "unknown"


def disposition_label(disp: str, codec: str = "unknown") -> str:
    """Label for a terminal disposition (UNSUPPORTED includes the codec), or ""
    for INCONCLUSIVE."""

    if disp == Disposition.INCONCLUSIVE:
        return ""
    if disp == Disposition.UNSUPPORTED:
        return f"UNSUPPORTED::{codec}"
    return disp


def tag_error(error: str, disp: str, codec: str = "unknown") -> str:
    """Prefix ``error`` with its disposition: ``"DAMAGED:: <msg>"`` or
    ``"UNSUPPORTED::<codec> -- <msg>"``. INCONCLUSIVE errors come back unchanged.
    """

    label = disposition_label(disp, codec)
    if not label:
        return error
    sep = " -- " if disp == Disposition.UNSUPPORTED else ":: "
    return f"{label}{sep}{error}"
