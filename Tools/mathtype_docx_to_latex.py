#!/usr/bin/env python3
"""Convert MathType / Equation Editor OLE in a .docx to LaTeX text (no Word ribbon).

Usage:
  python3 Tools/mathtype_docx_to_latex.py input.docx
  python3 Tools/mathtype_docx_to_latex.py input.docx -o output.docx
"""

from __future__ import annotations

import argparse
import io
import re
import shutil
import struct
import sys
import zipfile
from pathlib import Path

import olefile
from lxml import etree
from mathml_to_latex import MathMLToLaTeX

from mathtypejx.extractor import extract_mtef
from mathtypejx.models import FormulaStatus
from mathtypejx.mtef import mtef_to_mathml
from mathtypejx.mtef.mathml import _skip_stream_header
from mathtypejx.mtef.records3 import parse_equation_v3
from mathtypejx.mtef.stream import ByteStream
from mathtypejx.scanner import MATHTYPE_PROG_IDS, NS, read_ole_binary, scan_docx

W_NS = NS["w"]

CHAR_MAP = {
    0x2212: "-",
    0x00D7: "\\times ",
    0x00F7: "\\div ",
    0x00B1: "\\pm ",
    0x2264: "\\leq ",
    0x2265: "\\geq ",
    0x2260: "\\neq ",
    0x221E: "\\infty ",
    0x22C5: "\\cdot ",
    0x2026: "\\ldots ",
    0x03B1: "\\alpha ",
    0x03B2: "\\beta ",
    0x03B3: "\\gamma ",
    0x03B8: "\\theta ",
    0x03BB: "\\lambda ",
    0x03BC: "\\mu ",
    0x03C0: "\\pi ",
    0x03C3: "\\sigma ",
    0x03C6: "\\phi ",
    0x03C9: "\\omega ",
}


def _clean_latex(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\{\s+", "{", s)
    s = re.sub(r"\s+\}", "}", s)
    return s


def mathml_to_latex(mathml: str) -> str:
    try:
        latex = MathMLToLaTeX.convert(mathml)
    except Exception:
        return ""
    return _clean_latex(latex)


def _line_objects(node: dict) -> list:
    if node.get("type") == "line":
        return node.get("objects") or []
    return [node]


def _slot_latex(subobjects: list) -> list[str]:
    """Collect LaTeX for each line/slot among template subobjects."""
    parts: list[str] = []
    for so in subobjects:
        t = so.get("type")
        if t == "line":
            parts.append(objects_to_latex(so.get("objects") or []))
        elif t == "size":
            continue
        elif t in ("tmpl", "char", "pile", "matrix"):
            parts.append(obj_to_latex(so))
    return parts


def obj_to_latex(obj: dict) -> str:
    t = obj.get("type")
    if t == "char":
        code = int(obj.get("mt_code_value", "0"), 16)
        if code in CHAR_MAP:
            ch = CHAR_MAP[code]
        else:
            try:
                ch = chr(code)
            except ValueError:
                ch = "?"
            if ch in r"\{}$&#^_%~":
                ch = "\\" + ch if ch not in "^_" else ch
        base = ch
        for emb in obj.get("embellishment_list") or []:
            if emb.get("type") != "tmpl":
                # nested char embellishments (e.g. minus in exponent)
                if emb.get("type") == "char":
                    base += obj_to_latex(emb)
                continue
            sel = emb.get("selector", "")
            slots = _slot_latex(emb.get("subobjects") or [])
            # tmSUP/tmSUB often: [size, empty line, content line]
            content = next((s for s in reversed(slots) if s), "")
            if sel == "tmSUP":
                base = f"{{{base}}}^{{{content}}}"
            elif sel == "tmSUB":
                base = f"{{{base}}}_{{{content}}}"
            elif sel == "tmSUBSUP":
                sub = slots[0] if slots else ""
                sup = slots[1] if len(slots) > 1 else ""
                base = f"{{{base}}}_{{{sub}}}^{{{sup}}}"
            else:
                base += "".join(slots)
        return base

    if t == "tmpl":
        sel = obj.get("selector", "")
        slots = _slot_latex(obj.get("subobjects") or [])
        if sel == "tmFRACT":
            num = slots[0] if slots else ""
            den = slots[1] if len(slots) > 1 else ""
            return f"\\frac{{{num}}}{{{den}}}"
        if sel == "tmROOT":
            return f"\\sqrt{{{slots[0] if slots else ''}}}"
        if sel == "tmROOTN":
            return f"\\sqrt[{slots[0] if slots else ''}]{{{slots[1] if len(slots) > 1 else ''}}}"
        if sel in ("tmPAREN", "tmBRACK", "tmBRACE", "tmFLOOR", "tmCEIL"):
            left = {"tmPAREN": "(", "tmBRACK": "[", "tmBRACE": r"\{", "tmFLOOR": r"\lfloor ", "tmCEIL": r"\lceil "}.get(sel, "(")
            right = {"tmPAREN": ")", "tmBRACK": "]", "tmBRACE": r"\}", "tmFLOOR": r"\rfloor ", "tmCEIL": r"\rceil "}.get(sel, ")")
            body = "".join(slots)
            return f"\\left{left}{body}\\right{right}"
        if sel == "tmSUP":
            # bare superscript template without base (base is previous char)
            return f"^{{{slots[-1] if slots else ''}}}"
        if sel == "tmSUB":
            return f"_{{{slots[-1] if slots else ''}}}"
        if sel == "tmSUM":
            sub = slots[0] if slots else ""
            sup = slots[1] if len(slots) > 1 else ""
            body = slots[2] if len(slots) > 2 else ""
            return f"\\sum_{{{sub}}}^{{{sup}}}{{{body}}}"
        return "".join(slots)

    if t == "line":
        return objects_to_latex(obj.get("objects") or [])

    if t == "pile":
        rows = _slot_latex(obj.get("subobjects") or [])
        return "\\\\".join(rows)

    if t == "size":
        return ""

    return objects_to_latex(obj.get("objects") or obj.get("subobjects") or [])


def objects_to_latex(objects: list) -> str:
    return "".join(obj_to_latex(o) for o in objects)


def extract_raw_mtef(ole_data: bytes) -> bytes | None:
    try:
        ole = olefile.OleFileIO(io.BytesIO(ole_data))
    except Exception:
        return None
    raw = None
    for name in ("Equation Native", "EquationNative", "Equation"):
        if ole.exists(name):
            raw = ole.openstream(name).read()
            break
    ole.close()
    if not raw or len(raw) < 28:
        return None
    hdr = struct.Struct("<H I H I I I I I")
    cb_hdr, _, _, cb_object, *_ = hdr.unpack_from(raw, 0)
    if cb_hdr == 28:
        data = raw[28:]
        if 0 < cb_object <= len(data):
            data = data[:cb_object]
        return data
    return raw


def equation3_to_latex(ole_data: bytes) -> str:
    """Legacy Equation Editor 3.0 → LaTeX via record tree (bypasses broken XSLT path)."""
    data = extract_raw_mtef(ole_data)
    if not data or data[0] not in (3, 5):
        return ""
    ver = data[0]
    stream = ByteStream(data)
    _skip_stream_header(stream, ver)
    if ver != 3:
        return ""
    eq = parse_equation_v3(stream)
    records = eq.get("records") or []
    if not records and eq.get("equation"):
        records = eq["equation"].get("objects") or []
    return _clean_latex(objects_to_latex(records))


def latex_run_xml(latex: str, display: bool) -> etree._Element:
    delim = "$$" if display else "$"
    text = f"{delim}{latex}{delim}"
    r = etree.Element(f"{{{W_NS}}}r")
    t = etree.SubElement(r, f"{{{W_NS}}}t")
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    t.text = text
    return r


def convert_formula_to_latex(workdir: Path, formula) -> str | None:
    ole = read_ole_binary(workdir, formula.ole_name)
    if not ole:
        return None
    formula.ole_data = ole
    if not extract_mtef(formula):
        return None

    latex = ""

    # Prefer MathType DSMT4 → MathML → LaTeX
    if formula.prog_id == "Equation.DSMT4":
        try:
            mathml = mtef_to_mathml(ole)
            if mathml and not re.search(r"<math[^>]*>\s*</math>", mathml):
                latex = mathml_to_latex(mathml)
        except Exception as e:
            formula.error_message = str(e)

    # Equation.3 (and DSMT4 fallback) → direct record walker
    if not latex:
        try:
            latex = equation3_to_latex(ole)
        except Exception as e:
            formula.status = FormulaStatus.FAILED
            formula.error_message = f"v3 walk failed: {e}"
            return None

    if not latex:
        formula.status = FormulaStatus.FAILED
        formula.error_message = formula.error_message or "empty LaTeX"
        return None
    return latex


def replace_objects_in_part(xml_path: Path, rid_to_latex: dict[str, tuple[str, bool]]) -> int:
    if not xml_path.exists() or not rid_to_latex:
        return 0
    parser = etree.XMLParser(remove_blank_text=False)
    tree = etree.parse(str(xml_path), parser)
    root = tree.getroot()
    replaced = 0
    for obj in list(root.xpath(".//w:object | .//w:pict", namespaces=NS)):
        ole = obj.find(".//o:OLEObject", namespaces=NS)
        if ole is None:
            continue
        prog = ole.get("ProgID", "")
        if prog not in MATHTYPE_PROG_IDS:
            continue
        rid = ole.get(f"{{{NS['r']}}}id")
        if not rid or rid not in rid_to_latex:
            continue
        latex, display = rid_to_latex[rid]
        parent = obj.getparent()
        if parent is None:
            continue
        idx = list(parent).index(obj)
        parent.remove(obj)
        parent.insert(idx, latex_run_xml(latex, display))
        replaced += 1
    tree.write(str(xml_path), xml_declaration=True, encoding="UTF-8", standalone=True)
    return replaced


def convert_docx(input_path: Path, output_path: Path) -> dict:
    formulas, workdir = scan_docx(str(input_path))
    stats = {"found": 0, "converted": 0, "failed": 0, "failures": [], "by_prog": {}}
    try:
        mathtype = [f for f in formulas if f.prog_id in MATHTYPE_PROG_IDS]
        stats["found"] = len(mathtype)
        by_part: dict[str, dict[str, tuple[str, bool]]] = {}
        for f in mathtype:
            stats["by_prog"][f.prog_id] = stats["by_prog"].get(f.prog_id, 0) + 1
            latex = convert_formula_to_latex(workdir, f)
            if not latex:
                stats["failed"] += 1
                stats["failures"].append(f"{f.ole_name} ({f.prog_id}): {f.error_message or 'fail'}")
                continue
            stats["converted"] += 1
            by_part.setdefault(f.part_name, {})[f.relationship_id] = (latex, not f.is_inline)

        total_replaced = 0
        for part, mapping in by_part.items():
            total_replaced += replace_objects_in_part(workdir / part, mapping)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        if output_path.exists():
            output_path.unlink()
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(workdir.rglob("*")):
                if path.is_file():
                    zf.write(path, path.relative_to(workdir).as_posix())
        stats["replaced"] = total_replaced
        return stats
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=None)
    args = ap.parse_args()
    inp = args.input.expanduser().resolve()
    if not inp.exists():
        print(f"File not found: {inp}", file=sys.stderr)
        return 1
    out = args.output.expanduser().resolve() if args.output else inp.with_name(f"{inp.stem}-latex{inp.suffix}")
    print(f"Converting MathType OLE → LaTeX\n  in:  {inp}\n  out: {out}")
    stats = convert_docx(inp, out)
    print(f"Found {stats['found']} {stats.get('by_prog')}")
    print(f"Converted {stats['converted']}, replaced {stats.get('replaced', 0)}, failed {stats['failed']}")
    for msg in stats["failures"][:15]:
        print(f"  ! {msg}")
    if stats["converted"] == 0:
        return 2
    print("Done. Import the output .docx in AlphaEqt Content.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
