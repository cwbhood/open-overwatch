' Starts the Open Overwatch helper with its console minimized to the taskbar.
' Close that console (or press Ctrl+C in it) to stop the helper.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & dir & "\Start Open Overwatch.bat""", 7, False
