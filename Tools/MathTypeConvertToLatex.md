# MathType → LaTeX (when Word ribbon fails)

If **轉換公式** / **切換 TeX** flash and die, convert **outside Word** with the script below.  
Double‑click edit can still work; that only proves OLE is fine, not the Word add‑in.

## Programmatic conversion (recommended for you)

1. Copy the `.docx` to the Mac (from Parallels / DiskStation).
2. Run:

```bash
cd ~/Desktop/swift/AlphaEqtContent
pip3 install -r Tools/requirements-mathtype.txt
python3 Tools/mathtype_docx_to_latex.py "/path/to/lesson.docx"
# creates: lesson-latex.docx
```

3. In AlphaEqt Content → **Import Word** → choose `lesson-latex.docx`.

The script finds MathType OLE (`Equation.DSMT4`), converts MTEF → MathML → LaTeX, and replaces objects with `$...$` text.

## Word UI (only if add‑in works)

- **轉換公式** → Text using MathType translator → LaTeX  
- or **切換 TeX**

## After import

- LaTeX / OMML → `$...$` / `$$...$$` in the editor  
- Leftover OLE → `⟦MathType N⟧` markers  
- `% MathType!MTEF!...` comments are stripped  
