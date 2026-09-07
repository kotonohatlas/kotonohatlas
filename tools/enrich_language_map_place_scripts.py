#!/usr/bin/env python3
"""Fill missing abugida/alphabet script forms on place labels.

Natural Earth supplies Latn/Jpan/Hans/Hant/Kore/Cyrl/Arab/Deva/Beng/Grek/Hebr.
This enrichment preserves those established forms and adds the remaining
scripts declared in legacy_script_profiles. Missing Deva/Beng forms may also be
filled from pronunciation data.

Policy:
- One shared phonetic form per script, not per-locale readings.
- Most places have no native-speaker written form in these scripts; for those,
  approximate from sound rather than leaving the script absent.
- Missing Indic and mainland SE Asian scripts are generated independently from
  reviewed source-language pronunciation data. Existing upstream or reviewed
  Devanagari and Bengali forms are not replaced by machine transcription.
- Armenian / Georgian / Ethiopic use reviewed source-language IPA when
  available, then fall back to the Latin display form.
- Sparse endonym overrides cover only well-attested local forms.
- Amharic vs Tigrinya reading differences stay out of scope except as optional
  locale overrides for Horn-of-Africa places.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


from atlas_paths import ATLAS_ROOT, GEOGRAPHY_DIR
ROOT = ATLAS_ROOT
PLACES_PATH = GEOGRAPHY_DIR / "places.json"
MAP_CONFIG_PATH = GEOGRAPHY_DIR / "map.json"
PRONUNCIATIONS_PATH = GEOGRAPHY_DIR / "place-pronunciations.json"

AKSHARA_TARGETS = {
    "Guru": "Gurmukhi",
    "Gujr": "Gujarati",
    "Orya": "Oriya",
    "Taml": "Tamil",
    "Telu": "Telugu",
    "Knda": "Kannada",
    "Mlym": "Malayalam",
    "Thai": "Thai",
    "Laoo": "Lao",
    "Mymr": "Burmese",
    "Khmr": "Khmer",
}

PHONETIC_AKSHARA_TARGETS = {
    "Deva": "Devanagari",
    "Beng": "Bengali",
    **AKSHARA_TARGETS,
}

NEW_SCRIPTS = tuple(AKSHARA_TARGETS) + ("Armn", "Geor", "Ethi")

SCRIPT_SOURCES = {
    "Deva": "hi / Natural Earth or reviewed form, with source-language IPA fallback",
    "Beng": "bn / Natural Earth or reviewed form, with source-language IPA fallback",
    "Guru": "pa / source-language IPA-bridged phonetic, with Devanagari fallback",
    "Gujr": "gu / source-language IPA-bridged phonetic, with Devanagari fallback",
    "Orya": "or / source-language IPA-bridged phonetic, with Devanagari fallback",
    "Taml": "ta / source-language IPA-bridged phonetic, with Devanagari fallback",
    "Telu": "te / source-language IPA-bridged phonetic, with Devanagari fallback",
    "Knda": "kn / source-language IPA-bridged phonetic, with Devanagari fallback",
    "Mlym": "ml / source-language IPA-bridged phonetic, with Devanagari fallback",
    "Thai": "th / source-language IPA-bridged phonetic, with Devanagari fallback",
    "Laoo": "lo / source-language IPA-bridged phonetic, with Devanagari fallback",
    "Mymr": "my / source-language IPA-bridged phonetic, with Devanagari fallback",
    "Khmr": "km / source-language IPA-bridged phonetic, with Devanagari fallback",
    "Armn": "hy / source-language IPA-bridged phonetic, with Latin fallback",
    "Geor": "ka / source-language IPA-bridged phonetic, with Latin fallback",
    "Ethi": "am / source-language IPA-bridged phonetic, with Latin fallback",
}

# Sparse endonyms / established encyclopedia forms. Keyed by places `name`.
SCRIPT_OVERRIDES = {
    # Keyed by places row name (field 5), not necessarily the Latn display form.
    "Addis Ababa": {"Ethi": "አዲስ አበባ"},
    "Adama": {"Ethi": "አዳማ"},
    "Yerevan": {"Armn": "Երևան"},
    "Gyumri": {"Armn": "Գյումրի"},
    "Tbilisi": {"Geor": "თბილისი"},
    "Bangkok": {"Thai": "กรุงเทพฯ", "Laoo": "ກຸງເທພ"},
    "Tokyo": {"Thai": "โตเกียว", "Armn": "Տոկիո", "Geor": "ტოკიო", "Ethi": "ቶኪዮ"},
    "London": {"Thai": "ลอนดอน", "Armn": "Լոնդոն", "Geor": "ლონდონი", "Ethi": "ለንደን"},
    "Paris": {"Thai": "ปารีส", "Armn": "Փարիզ", "Geor": "პარიზი", "Ethi": "ፓሪስ"},
    "New York": {"Thai": "นิวยอร์ก", "Armn": "Նյու Յորք", "Geor": "ნიუ-იორკი", "Ethi": "ኒውዮርክ"},
    "Moskva": {"Thai": "มอสโก", "Armn": "Մոսկվա", "Geor": "მოსკოვი", "Ethi": "ሞስኮ"},
    "Kabul": {"Ethi": "ካቡል", "Armn": "Քաբուլ", "Geor": "ქაბული", "Thai": "คาบูล"},
    "São Paulo": {
        "Armn": "Սան Պաուլու",
        "Geor": "სან-პაულუ",
        "Ethi": "ሳኦ ፓውሎ",
    },
    # Preserve the Spanish reading; generic Latin transliteration would read
    # the initial C as /k/ in these fallback generators.
    "Ciudad de la Paz": {
        "Armn": "Սյուդադ դե լա Պաս",
        "Geor": "სიუდად დე ლა პას",
        "Ethi": "ሲዩዳድ ዴ ላ ፓስ",
    },
}


def _clean_aksharamukha(text: str) -> str:
    text = re.sub(r"[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]+", "", text)
    text = re.sub(r"[ʼʻʹ′]", "", text)
    text = re.sub(r"[\u200b\u200c\u200d]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _fold_latin(value: str) -> str:
    import unicodedata

    value = value.translate(str.maketrans({
        "æ": "ae", "Æ": "Ae", "œ": "oe", "Œ": "Oe",
        "ø": "o", "Ø": "O", "ł": "l", "Ł": "L",
        "ð": "d", "Ð": "D", "þ": "th", "Þ": "Th",
        "đ": "d", "Đ": "D", "ı": "i", "Ə": "E", "ə": "e",
        "ŋ": "ng", "Ŋ": "Ng", "ß": "ss",
        "ʻ": "'", "ʼ": "'", "ʹ": "'", "′": "'",
    }))
    folded = []
    for character in unicodedata.normalize("NFKD", value):
        if unicodedata.combining(character):
            continue
        folded.append(character)
    return "".join(folded)


_IPA_BRIDGE_REPLACEMENTS = (
    ("t͡ɕ", "ch"), ("d͡ʑ", "j"), ("tɕ", "ch"), ("dʑ", "j"),
    ("t͡ʃ", "ch"), ("d͡ʒ", "j"), ("t͡s", "ts"), ("d͡z", "dz"),
    ("tʃ", "ch"), ("dʒ", "j"), ("ts", "ts"), ("dz", "dz"),
    ("ʃ", "sh"), ("ʂ", "sh"), ("ɕ", "sh"),
    ("ʒ", "zh"), ("ʐ", "zh"), ("ʑ", "zh"),
    ("x", "kh"), ("χ", "kh"), ("ɣ", "gh"), ("ç", "h"), ("c", "k"),
    ("θ", "s"), ("ð", "d"), ("ɲ", "ny"), ("ŋ", "ng"),
    ("ɳ", "n"), ("ɭ", "l"), ("ɫ", "l"), ("ʎ", "ly"),
    ("ʁ", "r"), ("ʀ", "r"), ("ɾ", "r"), ("ɹ", "r"), ("ɽ", "r"),
    # Glottal stop and pharyngeal ʕ have no stable shared equivalent across the
    # target scripts. An ASCII apostrophe becomes an Indic avagraha (ऽ), which
    # is a grammatical elision mark rather than a useful place-name letter.
    # Leave these consonants unmarked in the coarse cross-script fallback.
    ("ʔ", ""), ("ʕ", ""), ("ħ", "h"),
    ("ɡ", "g"), ("ɟ", "j"), ("ʝ", "y"),
    ("β", "b"), ("ʋ", "v"), ("ɸ", "f"),
    ("ʈ", "t"), ("ɖ", "d"), ("ɗ", "d"),
    ("ʲ", "y"), ("ʰ", "h"), ("ˤ", ""),
    ("y", "u"), ("j", "y"),
    ("ɑ", "a"), ("ɐ", "a"), ("ɒ", "a"), ("ʌ", "a"),
    ("æ", "a"), ("ɛ", "e"), ("ə", "e"), ("ɜ", "e"),
    ("ɪ", "i"), ("ᵻ", "i"), ("ɨ", "i"), ("ɯ", "u"), ("ʏ", "u"),
    ("ɚ", "er"),
    ("ɔ", "o"), ("ø", "o"), ("œ", "o"), ("ɵ", "o"),
    ("ʊ", "u"), ("ʉ", "u"),
)


def _ipa_to_latin_bridge(value: str, language: str = "") -> str:
    """Reduce IPA to the conservative phonetic alphabet used by converters."""

    import unicodedata

    # U+00E7 is an IPA consonant here, not an orthographic c with an accent.
    # Preserve that distinction before canonical decomposition removes it.
    text = unicodedata.normalize("NFD", value.casefold().replace("ç", "h"))
    # Preserve consonant length as a doubled consonant before dropping IPA
    # length marks. This matters for names such as Sapporo /sapːoɾo/. Vowel
    # length remains script-convention dependent and is not forced here.
    consonants = "bcdfghklmnpqrstvwxyzɡɟɣɲŋɳɭɫɾɹɽʁʀʃʂɕʒʐʑχθðβʋɸʈɖɗħʔʕ"
    text = re.sub(rf"([{consonants}])ː", r"\1\1", text)
    # Keep word boundaries, but discard stress, remaining length and combining marks.
    text = re.sub(r"[ˈˌː._]", "", text)
    # Scripts without a productive nasal-vowel notation need a visible nasal
    # consonant approximation. Preserve nasal diphthongs first: otherwise São
    # /sɐ̃w/ collapses to `sav`, while Portimão /...mɐ̃w̃/ becomes `...manun`.
    nasal_vowels = {
        "a": "an", "ɑ": "an", "ɐ": "an", "æ": "an",
        "e": "en", "ɛ": "en", "ə": "en",
        "i": "in", "ɪ": "in",
        "o": "on", "ɔ": "on", "œ": "on",
        "u": "un", "ʊ": "un", "y": "un",
    }
    nasal_bases = {key: value[0] for key, value in nasal_vowels.items()}
    text = re.sub(
        r"([aɑɐæeɛəiɪoɔœuʊy])\u0303(?:w|ʊ)\u0303?",
        lambda match: nasal_bases[match.group(1)] + "un",
        text,
    )
    text = re.sub(
        r"([aɑɐæeɛəiɪoɔœuʊy])\u0303(?:j|ɪ)\u0303?",
        lambda match: nasal_bases[match.group(1)] + "in",
        text,
    )
    text = re.sub(
        r"([aɑɐæeɛəiɪoɔœuʊy])\u0303(?![jwmnɲŋ])",
        lambda match: nasal_vowels[match.group(1)],
        text,
    )
    text = "".join(character for character in text if not unicodedata.combining(character))
    replacements = dict(_IPA_BRIDGE_REPLACEMENTS)
    if language == "pt":
        # Brazilian /x/ is an r-family realization, and eSpeak writes some
        # unstressed /i/ vowels as /y/. Neither should become kh or u here.
        replacements.update({"x": "r", "y": "i"})
    elif language in {"el", "es"}:
        # In these engines, /ɣ/ is the regular fricative realization of an
        # underlying gamma/g. Feeding it to an Indic converter as `gh` creates
        # a spurious aspirated consonant (for example Zaragoza -> Zaraghoza).
        replacements["ɣ"] = "g"
    elif language == "en":
        # American intervocalic /t/ is commonly surfaced as [ɾ]. Preserve the
        # underlying consonant expected by cross-script place-name spellings.
        replacements["ɾ"] = "t"
    pattern = "|".join(
        re.escape(source)
        for source in sorted(replacements, key=len, reverse=True)
    )
    text = re.sub(pattern, lambda match: replacements[match.group(0)], text)
    text = re.sub(r"[^a-z' -]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _aksharamukha_phonetic_input(value: str, language: str = "") -> str:
    """Adapt the bridge alphabet to Aksharamukha's IAST semantics."""

    # IAST gives plain `n` its expected dental value. RomanReadable interprets
    # it as retroflex ṇ, which produced forms such as Nantes -> णण्त्. Convert
    # the bridge's portable digraphs to unambiguous IAST letters before calling
    # Aksharamukha. /ʒ/ uses z rather than j so it remains distinct from /dʒ/.
    adapted = (
        value.replace("zh", "z")
        .replace("sh", "ś")
        .replace("ch", "c")
        .replace("ny", "ñ")
        .replace("ng", "ṅ")
    )
    # Portuguese /w/ is normally the second element of a diphthong; `u`
    # preserves that relation. In the other supported voices it is ordinarily
    # consonantal, for which Indic व and its cognates (`v`) are the closest
    # portable approximation.
    return adapted.replace("w", "u" if language == "pt" else "v")


def _latin_to_armenian(value: str) -> str:
    text = _fold_latin(value).lower()
    digraphs = [
        ("zh", "ժ"),
        ("kh", "խ"),
        ("gh", "ղ"),
        ("sh", "շ"),
        ("ch", "չ"),
        ("ts", "ց"),
        ("dz", "ձ"),
        ("th", "թ"),
        ("ph", "փ"),
        ("oo", "ու"),
        ("ee", "ի"),
        ("ye", "յե"),
        ("yo", "յո"),
        ("yu", "յու"),
        ("ya", "յա"),
    ]
    singles = {
        "a": "ա",
        "b": "բ",
        "c": "կ",
        "d": "դ",
        "e": "ե",
        "f": "ֆ",
        "g": "գ",
        "h": "հ",
        "i": "ի",
        "j": "ջ",
        "k": "կ",
        "l": "լ",
        "m": "մ",
        "n": "ն",
        "o": "ո",
        "p": "պ",
        "q": "ք",
        "r": "ր",
        "s": "ս",
        "t": "տ",
        "u": "ու",
        "v": "վ",
        "w": "վ",
        "x": "քս",
        "y": "ի",
        "z": "զ",
        " ": " ",
        "-": " ",
        "'": "",
    }
    out: list[str] = []
    index = 0
    while index < len(text):
        matched = False
        for source, target in digraphs:
            if text.startswith(source, index):
                out.append(target)
                index += len(source)
                matched = True
                break
        if matched:
            continue
        character = text[index]
        out.append(singles.get(character, character if character.isalpha() else character))
        index += 1
    return re.sub(r"\s+", " ", "".join(out)).strip()


def _latin_to_georgian(value: str) -> str:
    text = _fold_latin(value).lower()
    digraphs = [
        ("zh", "ჟ"),
        ("kh", "ხ"),
        ("gh", "ღ"),
        ("sh", "შ"),
        ("ch", "ჩ"),
        ("ts", "ც"),
        ("dz", "ძ"),
        ("th", "თ"),
        ("ph", "ფ"),
        ("ye", "იე"),
        ("yo", "იო"),
        ("yu", "იუ"),
        ("ya", "ია"),
    ]
    singles = {
        "a": "ა",
        "b": "ბ",
        "c": "კ",
        "d": "დ",
        "e": "ე",
        "f": "ფ",
        "g": "გ",
        "h": "ჰ",
        "i": "ი",
        "j": "ჯ",
        "k": "კ",
        "l": "ლ",
        "m": "მ",
        "n": "ნ",
        "o": "ო",
        "p": "პ",
        "q": "ქ",
        "r": "რ",
        "s": "ს",
        "t": "ტ",
        "u": "უ",
        "v": "ვ",
        "w": "ვ",
        "x": "ქს",
        "y": "ი",
        "z": "ზ",
        " ": " ",
        "-": "-",
        "'": "",
    }
    out: list[str] = []
    index = 0
    while index < len(text):
        matched = False
        for source, target in digraphs:
            if text.startswith(source, index):
                out.append(target)
                index += len(source)
                matched = True
                break
        if matched:
            continue
        character = text[index]
        out.append(singles.get(character, character))
        index += 1
    return re.sub(r"\s+", " ", "".join(out)).strip()


_ETHI_FAMILY = {
    "h": "ሀሁሂሃሄህሆ",
    "l": "ለሉሊላሌልሎ",
    "m": "መሙሚማሜምሞ",
    "r": "ረሩሪራሬርሮ",
    "s": "ሰሱሲሳሴስሶ",
    "sh": "ሸሹሺሻሼሽሾ",
    "q": "ቀቁቂቃቄቅቆ",
    "b": "በቡቢባቤብቦ",
    "v": "ቨቩቪቫቬቭቮ",
    "t": "ተቱቲታቴትቶ",
    "ch": "ቸቹቺቻቼችቾ",
    "n": "ነኑኒናኔንኖ",
    "ny": "ኘኙኚኛኜኝኞ",
    "k": "ከኩኪካኬክኮ",
    "w": "ወዉዊዋዌውዎ",
    "z": "ዘዙዚዛዜዝዞ",
    "zh": "ዠዡዢዣዤዥዦ",
    "y": "የዩዪያዬይዮ",
    "d": "ደዱዲዳዴድዶ",
    "j": "ጀጁጂጃጄጅጆ",
    "g": "ገጉጊጋጌግጎ",
    "th": "ጠጡጢጣጤጥጦ",
    "c": "ጨጩጪጫጬጭጮ",
    "p": "ጰጱጲጳጴጵጶ",
    "f": "ፈፉፊፋፌፍፎ",
    "ts": "ጸጹጺጻጼጽጾ",
}

_ETHI_VOWEL_INDEX = {
    "e": 0,
    "u": 1,
    "i": 2,
    "a": 3,
    "ee": 4,
    "é": 4,
    "": 5,
    "o": 6,
    "wa": 3,
}


def _latin_to_ethiopic(value: str) -> str:
    text = _fold_latin(value).lower()
    text = text.replace("ee", "é")
    consonants = sorted(_ETHI_FAMILY, key=len, reverse=True)
    out: list[str] = []
    index = 0
    while index < len(text):
        if text[index] in {" ", "-", "'"}:
            if text[index] == " ":
                out.append(" ")
            elif text[index] == "-":
                out.append(" ")
            index += 1
            continue
        if text[index] in "aeioué":
            # Bare vowel: use family አ
            bare = {"a": "አ", "u": "ኡ", "i": "ኢ", "e": "እ", "o": "ኦ", "é": "ኤ"}
            out.append(bare.get(text[index], "አ"))
            index += 1
            continue
        cons = next((item for item in consonants if text.startswith(item, index)), "")
        if not cons:
            index += 1
            continue
        index += len(cons)
        vowel = ""
        if index < len(text) and text[index] in "aeioué":
            vowel = text[index]
            index += 1
            if vowel == "e" and index < len(text) and text[index] == "e":
                vowel = "é"
                index += 1
        family = _ETHI_FAMILY[cons]
        order = _ETHI_VOWEL_INDEX.get(vowel, 5)
        out.append(family[order])
    return re.sub(r"\s+", " ", "".join(out)).strip()


def _format_payload(payload: dict) -> str:
    # Keep the same compact reviewable layout as build_language_map_places.py.
    def compact(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))

    lines = ["{"]
    top_level = list(payload.items())
    for top_index, (key, value) in enumerate(top_level):
        top_comma = "," if top_index + 1 < len(top_level) else ""
        if key != "countries":
            lines.append(f"  {compact(key)}: {compact(value)}{top_comma}")
            continue
        lines.append(f"  {compact(key)}: {{")
        countries = list(value.items())
        for country_index, (code, country) in enumerate(countries):
            country_comma = "," if country_index + 1 < len(countries) else ""
            lines.append(f"    {compact(code)}: {{")
            members = list(country.items())
            for member_index, (member_key, member_value) in enumerate(members):
                member_comma = "," if member_index + 1 < len(members) else ""
                if member_key != "places":
                    lines.append(
                        f"      {compact(member_key)}: {compact(member_value)}{member_comma}"
                    )
                    continue
                lines.append(f"      {compact(member_key)}: [")
                for place_index, place in enumerate(member_value):
                    place_comma = "," if place_index + 1 < len(member_value) else ""
                    lines.append(f"        {compact(place)}{place_comma}")
                lines.append(f"      ]{member_comma}")
            lines.append(f"    }}{country_comma}")
        lines.append(f"  }}{top_comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def _enrich_scripts(
    scripts: dict,
    name: str,
    process,
    pronunciation: dict | None = None,
) -> dict:
    updated = dict(scripts)
    overrides = SCRIPT_OVERRIDES.get(name) or {}
    deva = str(scripts.get("Deva") or "").strip()
    latn = str(scripts.get("Latn") or name).strip()
    ipa = str((pronunciation or {}).get("ipa") or "").strip()
    language = str((pronunciation or {}).get("language") or "")
    phonetic_latn = _ipa_to_latin_bridge(
        ipa,
        language,
    ) or latn
    if (
        language in {"ar", "fa", "he", "ur"}
        and not re.search(r"[aeiou]", phonetic_latn)
    ):
        # Unvocalized abjads occasionally make both engines return little more
        # than a consonant skeleton (for example Marzuq -> `mrzq`). The map's
        # reviewed Latin spelling is a more useful pronunciation fallback than
        # propagating an unreadable cluster into eleven additional scripts.
        phonetic_latn = _fold_latin(latn).lower() or latn

    if ipa and phonetic_latn:
        native_script = {"bn": "Beng", "hi": "Deva"}.get(language)
        akshara_input = _aksharamukha_phonetic_input(phonetic_latn, language)
        for code, akshara_name in PHONETIC_AKSHARA_TARGETS.items():
            if (
                code == native_script
                or code in overrides
                or (code in {"Deva", "Beng"} and str(scripts.get(code) or "").strip())
            ):
                continue
            try:
                value = _clean_aksharamukha(
                    process("IAST", akshara_name, akshara_input, nativize=True)
                )
            except Exception:
                value = ""
            if value:
                updated[code] = value
    elif deva:
        for code, akshara_name in AKSHARA_TARGETS.items():
            if code in overrides:
                continue
            try:
                value = _clean_aksharamukha(
                    process("Devanagari", akshara_name, deva, nativize=True)
                )
            except Exception:
                value = ""
            if value:
                updated[code] = value

    updated["Armn"] = overrides.get("Armn") or _latin_to_armenian(phonetic_latn)
    updated["Geor"] = overrides.get("Geor") or _latin_to_georgian(phonetic_latn)
    updated["Ethi"] = overrides.get("Ethi") or _latin_to_ethiopic(phonetic_latn)

    for code, value in overrides.items():
        if value:
            updated[code] = value
    return updated


def enrich_places(payload: dict, process, pronunciations: dict | None = None) -> tuple[dict, int]:
    changed = 0
    pronunciation_countries = (pronunciations or {}).get("countries") or {}
    for country_code, country in payload.get("countries", {}).items():
        for row in country.get("places") or []:
            names = row[6]
            scripts = names.get("scripts") or {}
            name = str(row[5])
            pronunciation = (pronunciation_countries.get(country_code) or {}).get(name)
            enriched = _enrich_scripts(scripts, name, process, pronunciation)
            if enriched != scripts:
                names["scripts"] = enriched
                # Keep a stable key order: existing first, then new scripts.
                ordered = {}
                for key in list(scripts) + [code for code in NEW_SCRIPTS if code not in scripts]:
                    if key in enriched:
                        ordered[key] = enriched[key]
                for key, value in enriched.items():
                    ordered.setdefault(key, value)
                names["scripts"] = ordered
                changed += 1
    return payload, changed


def update_map_config(path: Path) -> None:
    """Patch script_sources in place. Never pretty-print the whole map config:
    coordinate polygons must stay compact for editor readability.
    """

    text = path.read_text(encoding="utf-8")
    match = re.search(
        r'("script_sources"\s*:\s*\{)(.*?)(\n\s*\})',
        text,
        flags=re.DOTALL,
    )
    if not match:
        # Older compact configs carried this provenance block. The generated
        # place catalog is self-describing now, so its absence is valid.
        return
    block = match.group(2)
    for script, note in SCRIPT_SOURCES.items():
        pattern = rf'("{re.escape(script)}"\s*:\s*)(.*?)(,|\n)'
        replacement_value = json.dumps(note, ensure_ascii=False)
        if re.search(rf'"{re.escape(script)}"\s*:', block):
            block = re.sub(
                pattern,
                lambda m, value=replacement_value: f"{m.group(1)}{value}{m.group(3)}",
                block,
                count=1,
            )
            continue
        # Insert before the closing of the captured block content by appending
        # after the last entry. Ensure the previous last entry has a comma.
        stripped = block.rstrip()
        if stripped and not stripped.endswith(","):
            # add comma after last property line
            lines = stripped.split("\n")
            for index in range(len(lines) - 1, -1, -1):
                if lines[index].strip():
                    if not lines[index].rstrip().endswith(","):
                        lines[index] = lines[index] + ","
                    break
            stripped = "\n".join(lines)
        indent = "      "
        stripped += f'\n{indent}"{script}": {replacement_value}'
        block = stripped + ("\n" if block.endswith("\n") else "")
    path.write_text(
        text[: match.start(2)] + block + text[match.end(2) :],
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--places", type=Path, default=PLACES_PATH)
    parser.add_argument("--map-config", type=Path, default=MAP_CONFIG_PATH)
    parser.add_argument("--pronunciations", type=Path, default=PRONUNCIATIONS_PATH)
    parser.add_argument("--skip-map-config", action="store_true")
    args = parser.parse_args()

    try:
        from aksharamukha import transliterate
    except ImportError:
        print(
            "aksharamukha is required. Install it in the active environment first.",
            file=sys.stderr,
        )
        return 1

    payload = json.loads(args.places.read_text(encoding="utf-8"))
    pronunciations = (
        json.loads(args.pronunciations.read_text(encoding="utf-8"))
        if args.pronunciations.exists()
        else {}
    )
    payload, changed = enrich_places(payload, transliterate.process, pronunciations)
    args.places.write_text(_format_payload(payload), encoding="utf-8")
    if not args.skip_map_config:
        update_map_config(args.map_config)
    print(f"enriched_places={changed} scripts={','.join(NEW_SCRIPTS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
