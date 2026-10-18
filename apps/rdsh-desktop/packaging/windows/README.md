# Windows notes

Build with cargo build --release and copy target\release\rdsh-desktop.exe where
you want it. Create a shortcut to that exe, then set its icon to
packaging\icon.ico (the project icon) and start it from the Start menu folder.

The window sets its app identity through the executable name; the taskbar icon
comes from the shortcut icon on Windows, and from the .desktop entry on Linux.
