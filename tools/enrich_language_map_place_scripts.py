#!/usr/bin/env python3
"""Fill missing abugida/alphabet script forms on place labels.

Natural Earth already supplies Latn/Jpan/Hans/Hant/Kore/Cyrl/Arab/Deva/Beng/Grek/Hebr.
This enrichment adds the remaining scripts declared in legacy_script_profiles.

Policy:
- One shared phonetic form per script, not per-locale readings.
- Most places have no native-speaker written form in these scripts; for those,
  approximate from sound rather than leaving the script absent.
- Indic and mainland SE Asian scripts are derived from the existing Devanagari
  form (already a phonetic reading of the place).
- Armenian / Georgian / Ethiopic are derived from the Latin display form.
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

NEW_SCRIPTS = tuple(AKSHARA_TARGETS) + ("Armn", "Geor", "Ethi")

SCRIPT_SOURCES = {
    "Guru": "pa / Devanagari-bridged phonetic",
    "Gujr": "gu / Devanagari-bridged phonetic",
    "Orya": "or / Devanagari-bridged phonetic",
    "Taml": "ta / Devanagari-bridged phonetic",
    "Telu": "te / Devanagari-bridged phonetic",
    "Knda": "kn / Devanagari-bridged phonetic",
    "Mlym": "ml / Devanagari-bridged phonetic",
    "Thai": "th / Devanagari-bridged phonetic",
    "Laoo": "lo / Devanagari-bridged phonetic",
    "Mymr": "my / Devanagari-bridged phonetic",
    "Khmr": "km / Devanagari-bridged phonetic",
    "Armn": "hy / Latin-bridged phonetic",
    "Geor": "ka / Latin-bridged phonetic",
    "Ethi": "am / Latin-bridged phonetic",
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
}


def _clean_aksharamukha(text: str) -> str:
    text = re.sub(r"[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]+", "", text)
    text = re.sub(r"[ʼʻʹ′]", "", text)
    text = re.sub(r"[\u200b\u200c\u200d]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _fold_latin(value: str) -> str:
    import unicodedata

    folded = []
    for character in unicodedata.normalize("NFKD", value):
        if unicodedata.combining(character):
            continue
        folded.append(character)
    return "".join(folded)


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


def _enrich_scripts(scripts: dict, name: str, process) -> dict:
    updated = dict(scripts)
    overrides = SCRIPT_OVERRIDES.get(name) or {}
    deva = str(scripts.get("Deva") or "").strip()
    latn = str(scripts.get("Latn") or name).strip()

    if deva:
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

    updated["Armn"] = overrides.get("Armn") or _latin_to_armenian(latn)
    updated["Geor"] = overrides.get("Geor") or _latin_to_georgian(latn)
    updated["Ethi"] = overrides.get("Ethi") or _latin_to_ethiopic(latn)

    for code, value in overrides.items():
        if value:
            updated[code] = value
    return updated


def enrich_places(payload: dict, process) -> tuple[dict, int]:
    changed = 0
    for country in payload.get("countries", {}).values():
        for row in country.get("places") or []:
            names = row[6]
            scripts = names.get("scripts") or {}
            enriched = _enrich_scripts(scripts, str(row[5]), process)
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
        raise ValueError(f"script_sources block not found in {path}")
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
    payload, changed = enrich_places(payload, transliterate.process)
    args.places.write_text(_format_payload(payload), encoding="utf-8")
    if not args.skip_map_config:
        update_map_config(args.map_config)
    print(f"enriched_places={changed} scripts={','.join(NEW_SCRIPTS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
