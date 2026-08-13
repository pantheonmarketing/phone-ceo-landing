Option Explicit

Dim shell, files, projectDirectory, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
projectDirectory = files.GetParentFolderName(WScript.ScriptFullName)
scriptPath = projectDirectory & "\scripts\connect-facebook-audit.ps1"
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """"
shell.Run command, 0, False
