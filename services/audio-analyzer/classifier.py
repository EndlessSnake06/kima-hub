"""Classification of analysis failures into terminal disposition classes.

Pure, stdlib-only. Deliberately free of ent/psycopg/redis: it must be
importable from the analyzer's worker process *and* from the Node-side mirror
without dragging the heavy runtime in.

Three kinds of failure matter for a healthy library:

* ``DAMAGED``      -- the file's bitstream is corrupt (a damaged file).
* ``UNSUPPORTED``  -- the codec the engine cannot decode (format-different,
                      not broken). Reported so the UI can name the codec.
* ``MULTICANNEL``  -- more than two channels; the ESSENTIA MonoLoader refuses
                      it. A capability limitation, not a defect in the file.
* ``INCONCLUSIVE`` -- anything else. Left retryable: it keeps the caller's
                      current "failed" fate and rides the retry gate, so a
                      transient IO hiccup can still recover.

Precision dominates recall: a message that is not a *strong* damage or codec
signature stays INCONCLUSIVE rather than being wrongly doomed. A good file
retaken by a transient error is worth more than a speculative terminal tag.

The disposition is decided at the single failure choke point
(``analyzer._save_failed``): every failure surface -- pre-decode ffmpeg,
MonoLoader, worker-death-on-decode -- funnels through the same classify call,
so a new path inherits the rule with zero per-site plumbing.
"""

import re


class Disposition:
    """Terminal disposition constants. ``INCONCLUSIVE`` is the non-terminal,
    still-retryable bucket."""

    DAMAGED = "DAMAGED"
    UNSUPPORTED = "UNSUPPORTED"
    MULTICANNEL = "MULTICANNEL"
    INCONCLUSIVE = "INCONCLUSIVE"

    ALL = (DAMAGED, UNSUPPORTED, MULTICANNEL, INCONCLUSIVE)


# Strong corruption signatures only. A message matching one of these is a file
# the analyzer demonstrably cannot turn into samples; flagging it permanent is
# safe because retrying it will produce the same failure. Each pattern mirrors a
# signature from the design note rather than guessing at every phrasing ESSENTIA
# might emit -- because the inverse mistake (dooming a file that would decode on
# retry) is far worse than missing a rare one.
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
    """Best-effort codec label for an unsupported-codec failure.

    Strategy mirrors the design note: a named codec token when the message
    names one, else the file extension when supplied, else "unknown". We only
    ever call this for an UNSUPPORTED disposition, so an absence of a named
    token is legitimately "unknown" -- the message gave no codec to report.
    """

    m = _CODEC_RE.search(message)
    if m:
        return m.group(0).lower()

    # Fall back to the file extension hint (e.g. "dts") when no codec name was
    # in the message.
    if ext_hint:
        return ext_hint.strip(".").lower()

    return "unknown"


def disposition_label(disp: str, codec: str = "unknown") -> str:
    """Readable label for a terminal disposition, or "" for ``INCONCLUSIVE``.

    DAMAGED and MULTICANNEL carry just their kind; UNSUPPORTED embeds the codec
    so the operator sees what the library holds. ``INCONCLUSIVE`` returns an
    empty label because it is not a terminal disposition and its error is left
    untouched.
    """

    if disp == Disposition.INCONCLUSIVE:
        return ""
    if disp == Disposition.UNSUPPORTED:
        return f"UNSUPPORTED::{codec}"
    return disp


def tag_error(error: str, disp: str, codec: str = "unknown") -> str:
    """Return ``error`` prefixed with its disposition so health/inspection can
    read the classification. The original message is preserved verbatim.

    Format mirrors the design note: a DAMAGED/MULTICANNEL failure reads
    ``"<KIND>:: <original>"``; an UNSUPPORTED one names the codec
    (``"UNSUPPORTED::<codec> -- <original>"``). An INCONCLUSIVE failure is the
    retryable bucket, so its error is returned unchanged.
    """

    label = disposition_label(disp, codec)
    if not label:
        return error
    sep = " -- " if disp == Disposition.UNSUPPORTED else ":: "
    return f"{label}{sep}{error}"
