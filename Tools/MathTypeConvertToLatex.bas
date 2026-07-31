' MathType → LaTeX text inside Word (run BEFORE AlphaEqtContent Import Word)
'
' Requirements: Microsoft Word + MathType Word add-in
' Install: Word → Alt+F11 → File → Import File → this .bas
'
' Also: Tools → References → MathType SDK / WordCmds (MT6SDK.dot)
'   Browse MathType install → Templates (Win\64 or Win\32)
'
' Simpler path (no VBA): MathType ribbon → Convert Equations
'   See MathTypeConvertToLatex.md

Option Explicit

Private Const mt_CVT_FIND_MTEE As Long = 1

Public Sub ConvertAllMathTypeToLatex()
    ' Replace MathType / Equation Editor objects with LaTeX text.
    ' Work on a COPY of the .docx.

    Dim info As ConvertEquationsInfo

    info.showStats = True
    info.equationTypes = mt_CVT_FIND_MTEE
    info.selectionOnly = False
    info.promptUser = False
    ' Match the exact name from MathType → Convert Equations → Translator list:
    info.translatorFileName = "TeX - LaTeX 2.09 and later.tdl"
    info.translatorOptions = 0   ' no MTEF / translator-name comments
    info.count = 0

    On Error GoTo Fail
    Call ConvertEquations(info)
    MsgBox "Converted " & CStr(info.count) & " equation(s) to LaTeX text." & vbCrLf & _
           "Save As a new .docx, then Import Word in AlphaEqt Content.", vbInformation
    Exit Sub

Fail:
    MsgBox "Convert failed: " & Err.Description & vbCrLf & vbCrLf & _
           "Use the UI instead:" & vbCrLf & _
           "  MathType → Convert Equations →" & vbCrLf & _
           "  Text using MathType translator → LaTeX 2.09 and later" & vbCrLf & _
           "  Uncheck comment options → Convert", vbExclamation
End Sub
