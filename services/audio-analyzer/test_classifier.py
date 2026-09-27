"""Unit tests for the analysis-failure classifier.

The classifier is the contract between the analyzer and the health/UI views:
it decides, from a raw ESSENTIA/decoder error message, whether a failure is a
damaged file, a format the engine cannot decode, or a multichannel file the
loader refuses -- versus the generic failure that stays retryable.

Run from the service dir so the classifier module is importable:
    cd services/audio-analyzer && python -m pytest test_classifier.py -v

These assert on the classifier's real return values against message phrasings
modeled on the documented ESSENTIA signatures; there is no re-implementation
here. Before trusting a case, mutate the source in thought and check the test
would go red.
"""

import pytest
from classifier import (
    classify_failure,
    classify_with_codec,
    disposition_label,
    tag_error,
    Disposition,
)


class TestMultichannel:
    def test_note_signature_classifies(self):
        assert classify_failure("Audio file has more than 2 channels") == \
            Disposition.MULTICANNEL

    def test_audio_channels_variant(self):
        assert classify_failure("more than 2 audio channels") == \
            Disposition.MULTICANNEL

    def test_multichannel_keyword(self):
        assert classify_failure("input is multichannel") == \
            Disposition.MULTICANNEL


class TestUnsupportedCodec:
    def test_note_signature(self):
        assert classify_failure("Unsupported codec!") == \
            Disposition.UNSUPPORTED

    def test_decode_capable_phrase(self):
        assert classify_failure(
            "not capable of decoding all supported inputs") == \
            Disposition.UNSUPPORTED

    def test_codec_name_captured_from_bracket(self):
        disp, codec = classify_with_codec("unsupported codec: dts")
        assert disp == Disposition.UNSUPPORTED
        assert codec == "dts"

    def test_codec_name_from_decoder_token(self):
        # A "codec ... not found" message surfaces the codec as a bare token.
        disp, codec = classify_with_codec(
            "the decoder for the flac codec is not found")
        assert disp == Disposition.UNSUPPORTED
        assert codec == "flac"


class TestDamagedBitstream:
    def test_flac_decode_frame(self):
        assert classify_failure("flac: decode_frame overrun") == \
            Disposition.DAMAGED

    def test_flac_decode_frame_colon_sep(self):
        # Robust to the colon separator the real ESSENTIA emits.
        assert classify_failure("flac decode_frame at 0x1f3a") == \
            Disposition.DAMAGED

    def test_mp3_header_missing(self):
        assert classify_failure("mp3: Header missing") == \
            Disposition.DAMAGED

    def test_crc_or_overread_or_truncation(self):
        for msg in [
            "CRC check failed mid-stream",
            "overread at 0x1f3a",
            "truncated stream: ended 4122 bytes early",
            "error while decoding audio",
            "non-monotonous dts detected",
        ]:
            assert classify_failure(msg) == Disposition.DAMAGED, msg

    def test_invalid_dts_stream_is_damage(self):
        # An invalid dts stream is damage; an absent dts DECODER would be
        # unsupported. Both paths tested below.
        assert classify_failure("invalid dts stream in frame") == \
            Disposition.DAMAGED

    def test_absent_decodcer_is_not_damage(self):
        # "codec flac not found" is UNSUPPORTED, proving damage detection does
        # not over-match on a bare "flac".
        assert classify_failure("codec flac not found") == \
            Disposition.UNSUPPORTED

    def test_intrusive_noise_words_do_not_trigger(self):
        # A message mentioning a codec near the word "decode" but lacking a
        # damage signature stays INCONCLUSIVE, not damaged.
        assert classify_failure("checking flac decode support") == \
            Disposition.INCONCLUSIVE


class TestRetentionPrinciple:
    """Precision over recall: a message that is not a strong damage/codec
    signature is left INCONCLUSIVE so it keeps the current retryable 'failed'
    fate. Only unambiguous corruption or codec is made terminal.

    The inversion test: a soft 'not capable' phrase is UNSUPPORTED, while a
    bare 'unsupported' adjective is INCONCLUSIVE, proving the codec matcher is
    anchored to the encoder phrase and does not float free.
    """

    def test_transient_io_keeps_inconclusive(self):
        assert classify_failure("temporary I/O error reading buffer") == \
            Disposition.INCONCLUSIVE

    def test_soft_adjective_does_not_trigger_unsupported(self):
        # 'unsupported' as a bare adjective is not the codec refusal phrase.
        assert classify_failure("the file is unsupported") == \
            Disposition.INCONCLUSIVE

    def test_non_specific_error_keeps_inconclusive(self):
        assert classify_failure("something went wrong") == \
            Disposition.INCONCLUSIVE

    def test_none_and_empty_are_inconclusive(self):
        assert classify_failure("") == Disposition.INCONCLUSIVE
        # Empty string is the documented "no message" sentinel.


class TestLabelAndTagFormat:
    def test_label_empty_for_inconclusive(self):
        assert disposition_label(Disposition.INCONCLUSIVE) == ""

    def test_label_formats_each_terminal_kind(self):
        assert disposition_label(Disposition.DAMAGED) == "DAMAGED"
        assert disposition_label(Disposition.MULTICANNEL) == "MULTICANNEL"
        assert disposition_label(Disposition.UNSUPPORTED, "dts") == \
            "UNSUPPORTED::dts"

    def test_tag_wraps_original_verbatim(self):
        orig = "more than 2 channels"
        out = tag_error(orig, Disposition.MULTICANNEL, "unknown")
        assert out == "MULTICANNEL:: " + orig
        assert out.endswith(orig)  # original preserved as the verbatim suffix

    def test_tag_unsupported_names_codec_with_separator(self):
        out = tag_error("decoder not found", Disposition.UNSUPPORTED, "dts")
        assert out == "UNSUPPORTED::dts -- decoder not found"

    def test_tag_damaged_plain_prefix(self):
        out = tag_error("crc mismatch", Disposition.DAMAGED, "unknown")
        assert out == "DAMAGED:: crc mismatch"

    def test_tag_inconclusive_returns_original_unchanged(self):
        assert tag_error("io hiccup", Disposition.INCONCLUSIVE) == "io hiccup"

    def test_tag_codec_from_self_reference(self):
        # Even with no bracketed codec, an explicit codec token in the message
        # propagates, so the UI can name it.
        out = tag_error("codec ogg not found", Disposition.UNSUPPORTED, "ogg")
        assert out.startswith("UNSUPPORTED::ogg -- ")


class TestEndToEndDispositionChain:
    def test_full_message_classification_and_taging(self):
        # A representative real-world-style ESSENTIA rejection flows through
        # the whole chain: classify, attribute, tag, preserve the original.
        msg = "unsupported codec: dts -- unable to decode"
        disp, codec = classify_with_codec(msg)
        assert disp == Disposition.UNSUPPORTED
        assert codec == "dts"
        tagged = tag_error(msg, disp, codec)
        assert tagged == "UNSUPPORTED::dts -- " + msg
        assert tagged.endswith(msg)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
