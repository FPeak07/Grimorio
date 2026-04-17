[Setup]
AppName=Grimorio
AppVersion=1.0
AppPublisher=FPeak07
AppPublisherURL=https://github.com/FPeak07/Grimorio
AppSupportURL=https://github.com/FPeak07/Grimorio/issues
DefaultDirName={autopf}\Grimorio
DefaultGroupName=Grimorio
OutputDir=Output
OutputBaseFilename=GrimorioInstaller
SetupIconFile=logo.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\Grimorio.exe
DisableProgramGroupPage=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\Grimorio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Grimorio"; Filename: "{app}\Grimorio.exe"
Name: "{commondesktop}\Grimorio"; Filename: "{app}\Grimorio.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Grimorio.exe"; Description: "{cm:LaunchProgram,Grimorio}"; Flags: nowait postinstall skipifsilent
