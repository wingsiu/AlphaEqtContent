' MathType 6.9 — convert equations to TeX/LaTeX WITHOUT Convert Equations dialog
' (Use when 轉換公式 flashes and dies, but double-click edit still works.)
'
' Install: Word Alt+F11 → File → Import → this file
' Tools → References → check "MathType SDK" / MT6SDK.dot if available
'
' Prefer trying ribbon 切換 TeX first (Publish group). This macro is the
' programmatic equivalent / batch helper.

Option Explicit

' --- Option A: Toggle TeX (often works when Convert Equations does not) ---
Public Sub ToggleAllEquationsToTeX()
    On Error GoTo Fail

    ' Whole document selection
    ActiveDocument.Content.Select

    ' MathType Commands for Word — Toggle TeX
    ' If this errors, use Option B below or ribbon 切換 TeX.
    Application.Run "MTCommandsMain.DoToggleTeX", True

    MsgBox "Toggle TeX finished. Check that equations became $...$ / LaTeX text." & vbCrLf & _
           "Save As .docx, then Import Word in AlphaEqt Content.", vbInformation
    Exit Sub

Fail:
    MsgBox "Toggle TeX macro failed: " & Err.Description & vbCrLf & vbCrLf & _
           "Try ribbon: MathType → 切換 TeX" & vbCrLf & _
           "Or run ConvertAllMathTypeToLatex_SDK if MT6SDK is referenced.", vbExclamation
End Sub

' --- Option B: SDK ConvertEquations (needs MT6SDK.dot reference) ---
Private Const mt_CVT_FIND_MTEE As Long = 1

Public Sub ConvertAllMathTypeToLatex_SDK()
    Dim info As ConvertEquationsInfo

    info.showStats = True
    info.equationTypes = mt_CVT_FIND_MTEE
    info.selectionOnly = False
    info.promptUser = False
    info.translatorFileName = "TeX - LaTeX 2.09 and later.tdl"
    info.translatorOptions = 0
    info.count = 0

    On Error GoTo Fail
    Call ConvertEquations(info)
    MsgBox "Converted " & CStr(info.count) & " equation(s).", vbInformation
    Exit Sub

Fail:
    MsgBox "SDK ConvertEquations failed: " & Err.Description, vbExclamation
End Sub
